# beads-dolt-backup: prepare/cleanup halves of the nightly Dolt backup.
#
# NixOS port of /opt/beads-dolt-backup/bin/beads-dolt-backup.sh from the
# Ubuntu host (read 2026-10-18). services.restic.backups.beads-dolt runs:
#   ExecStartPre   beads-dolt-backup prepare   (this file)
#   ExecStart      restic backup --tag beads-dolt --compression auto <scratch>
#                  restic forget --prune --tag beads-dolt --group-by host,paths
#                    --keep-daily 14 --keep-weekly 8 --keep-monthly 12
#   ExecStopPost   beads-dolt-backup cleanup   (this file)
#
# `prepare` does exactly what the old script did before the upload:
# a pre-stop SQL checkpoint (informational), a brief stop of the Dolt
# container, a `cp -a` of the four captured mount sources into a stable
# scratch path, a restart, the authoritative post-restart checkpoint, and a
# manifest inside the scratch tree. The Dolt root password mount is
# deliberately not captured (see docs/backup-recovery.md). Upload and
# retention moved to the restic module; `cleanup` writes the same
# machine-checkable last-result.json and removes the scratch copy.
#
# Differences from the Ubuntu script: the container is stopped and started
# through its systemd unit (docker-beads-dolt.service) instead of
# `docker stop/start`, because the NixOS unit owns the container; settings
# come from the unit environment instead of /etc/beads-web/beads-dolt-backup.env;
# the SQL password comes from sops-nix (/run/secrets).
#
# It authenticates to Dolt only as the read-only `beads_backup` user and never
# writes Beads data. Secrets never go to argv, the environment file or a log.

IFS=$'\n\t'
umask 077

SCRIPT_NAME=beads-dolt-backup
STAGE="startup"
START_EPOCH=$(date +%s)
DOWNTIME_START_EPOCH=""
DOWNTIME_END_EPOCH=""

: "${DOLT_UNIT:?}" "${DOLT_DATA_ROOT:?}" "${DOLT_SERVERCFG_DIR:?}" "${DOLT_SECUREFILE_PATH:?}"
: "${DOLT_ENTRYPOINT_PATH:?}" "${DOLT_DATABASES:?}" "${DOLT_SQL_HOST:?}" "${DOLT_SQL_PORT:?}"
: "${DOLT_SQL_USER:?}" "${DOLT_SQL_PASSWORD_FILE:?}" "${BACKUP_STATE_DIR:?}"
SNAPSHOT_SCRATCH_DIR="${BACKUP_STATE_DIR}/work/snapshot-current"
RESULT_FILE="${BACKUP_STATE_DIR}/last-result.json"
STAGE_FILE="${BACKUP_STATE_DIR}/work/stage"
CONTAINER_READY_TIMEOUT="${CONTAINER_READY_TIMEOUT:-60}"

log() {
  printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SCRIPT_NAME" "$*" >&2
}

set_stage() {
  STAGE=$1
  printf '%s\n' "$STAGE" >"$STAGE_FILE" 2>/dev/null || true
}

# Machine-checkable result file used for alerting. Never pass a secret.
write_result() {
  local status=$1 message=$2 snapshot=${3:-null} started=${4:-$START_EPOCH}
  local tmp snapshot_json escaped
  mkdir -p "$(dirname "$RESULT_FILE")" 2>/dev/null || true
  tmp=$(mktemp "${RESULT_FILE}.XXXXXX") || return 0
  if [ "$snapshot" = "null" ]; then snapshot_json=null; else snapshot_json="\"${snapshot}\""; fi
  escaped=$(printf '%s' "$message" | sed 's/\\/\\\\/g; s/"/\\"/g')
  cat >"$tmp" <<JSON
{
  "component": "beads-dolt-backup",
  "status": "${status}",
  "stage": "${STAGE}",
  "message": "${escaped}",
  "restic_snapshot_id": ${snapshot_json},
  "started_at": "$(date -u -d "@${started}" +%Y-%m-%dT%H:%M:%SZ)",
  "finished_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "duration_seconds": $(($(date +%s) - started))
}
JSON
  mv -f "$tmp" "$RESULT_FILE"
  chmod 0640 "$RESULT_FILE" 2>/dev/null || true
}

fail() {
  log "FAILURE at stage '${STAGE}': $1"
  write_result "failure" "$1"
  echo "BEADS_DOLT_BACKUP_RESULT=FAILURE stage=${STAGE}" >&2
  exit 1
}

split_databases() {
  set -f
  local IFS=$' \t\n'
  # shellcheck disable=SC2206
  DOLT_DATABASES_ARRAY=($DOLT_DATABASES)
  set +f
  [ "${#DOLT_DATABASES_ARRAY[@]}" -gt 0 ] || fail "DOLT_DATABASES produced no database names"
}

# One read-only statement as beads_backup. The password goes only through
# MYSQL_PWD, never argv; driver errors and query text are never logged.
sql_query() {
  local db=$1 query=$2 output
  if ! output=$(MYSQL_PWD="$DOLT_SQL_PASSWORD" mysql \
    --host="$DOLT_SQL_HOST" --port="$DOLT_SQL_PORT" --user="$DOLT_SQL_USER" \
    --protocol=TCP --skip-ssl --batch --raw --skip-column-names \
    --database="$db" --execute="$query" 2>/dev/null); then
    log "sql_query failed: database=${db} (mysql client exited non-zero)"
    return 1
  fi
  printf '%s\n' "$output"
}

wait_for_dolt_ready() {
  set_stage wait_for_ready
  local waited=0
  until MYSQL_PWD="$DOLT_SQL_PASSWORD" mysql \
    --host="$DOLT_SQL_HOST" --port="$DOLT_SQL_PORT" --user="$DOLT_SQL_USER" \
    --protocol=TCP --skip-ssl --batch --skip-column-names --execute="SELECT 1" >/dev/null 2>&1; do
    sleep 2
    waited=$((waited + 2))
    if [ "$waited" -ge "$CONTAINER_READY_TIMEOUT" ]; then
      fail "Dolt SQL server did not become reachable within ${CONTAINER_READY_TIMEOUT}s after restart"
    fi
  done
}

json_escape() {
  sed 's/\\/\\\\/g; s/"/\\"/g' <<<"$1"
}

# Per-database commit-history and row-level checkpoint, as one JSON object.
# Unchanged from the Ubuntu script.
capture_checkpoint_for_db() {
  local db=$1
  local head branches tags remotes pending row_total sample_table sample_hash
  head=$(sql_query "$db" "SELECT commit_hash FROM dolt_log ORDER BY date DESC LIMIT 1" | head -n1) || return 1
  branches=$(sql_query "$db" "SELECT COUNT(*) FROM dolt_branches" | head -n1) || return 1
  tags=$(sql_query "$db" "SELECT COUNT(*) FROM dolt_tags" | head -n1) || return 1
  remotes=$(sql_query "$db" "SELECT COUNT(*) FROM dolt_remotes" | head -n1) || return 1
  pending=$(sql_query "$db" "SELECT COUNT(*) FROM dolt_status" | head -n1) || return 1
  [ -n "$head" ] || { log "empty HEAD commit hash for database=${db}"; return 1; }

  local tables
  tables=$(sql_query "$db" \
    "SELECT table_name FROM information_schema.tables WHERE table_schema = '${db}' AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'dolt\\_%' ORDER BY table_name") || return 1

  row_total=0
  sample_table=""
  sample_hash=""
  local t first_col count
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    count=$(sql_query "$db" "SELECT COUNT(*) FROM \`${t}\`" | head -n1) || return 1
    row_total=$((row_total + count))
    if [ -z "$sample_table" ] && [ "$count" -gt 0 ]; then
      first_col=$(sql_query "$db" \
        "SELECT column_name FROM information_schema.columns WHERE table_schema = '${db}' AND table_name = '${t}' ORDER BY ordinal_position LIMIT 1" | head -n1) || return 1
      if [ -n "$first_col" ]; then
        local cols concat_expr
        cols=$(sql_query "$db" \
          "SELECT column_name FROM information_schema.columns WHERE table_schema = '${db}' AND table_name = '${t}' ORDER BY ordinal_position") || return 1
        # Backtick every column (some are reserved words, e.g. `key`).
        # shellcheck disable=SC2016
        concat_expr=$(printf '%s\n' "$cols" | sed 's/`/``/g; s/^/`/; s/$/`/' | paste -sd, -)
        sample_hash=$(sql_query "$db" \
          "SELECT MD5(CONCAT_WS('|', ${concat_expr})) FROM \`${t}\` ORDER BY \`${first_col}\` LIMIT 1" | head -n1) || return 1
        sample_table="$t"
        [ -n "$sample_hash" ] || { log "empty sample_row_hash for non-empty table ${t} in database=${db}"; return 1; }
      fi
    fi
  done <<<"$tables"

  cat <<JSON
{"database":"$(json_escape "$db")","head_commit":"$(json_escape "$head")","branch_count":${branches},"tag_count":${tags},"remote_count":${remotes},"pending_changes":${pending},"table_row_total":${row_total},"sample_table":"$(json_escape "$sample_table")","sample_row_hash":"$(json_escape "$sample_hash")"}
JSON
}

capture_checkpoint_all() {
  local db first=1
  echo "["
  for db in "${DOLT_DATABASES_ARRAY[@]}"; do
    [ "$first" -eq 1 ] || echo ","
    first=0
    capture_checkpoint_for_db "$db" || return 1
  done
  echo "]"
}

assert_checkpoint_complete() {
  local checkpoint_json=$1 label=$2
  local expected=${#DOLT_DATABASES_ARRAY[@]} actual empty_heads
  actual=$({ grep -o '"database":"[^"]*"' <<<"$checkpoint_json" || true; } | wc -l)
  [ "$actual" -eq "$expected" ] \
    || fail "${label} checkpoint has ${actual} database entries, expected ${expected}"
  empty_heads=$({ grep -o '"head_commit":""' <<<"$checkpoint_json" || true; } | wc -l)
  [ "$empty_heads" -eq 0 ] \
    || fail "${label} checkpoint has ${empty_heads} database entry(ies) with an empty head_commit"
}

# Never leave Dolt down, whatever failed.
ensure_container_running() {
  if ! systemctl is-active --quiet "$DOLT_UNIT"; then
    log "${DOLT_UNIT} is not active during cleanup; starting it"
    systemctl start "$DOLT_UNIT" || log "CRITICAL: failed to start ${DOLT_UNIT}; manual intervention required"
  fi
}

stop_container() {
  set_stage stop_container
  log "Stopping ${DOLT_UNIT} for a consistent filesystem snapshot"
  DOWNTIME_START_EPOCH=$(date +%s)
  systemctl stop "$DOLT_UNIT" || fail "systemctl stop ${DOLT_UNIT} failed"
}

# The only work done while Dolt is down: a local `cp -a` of the four
# captured sources into a stable path (stable so restic skips unchanged
# files). The root password mount is never copied.
snapshot_sources() {
  set_stage snapshot_sources
  rm -rf "$SNAPSHOT_SCRATCH_DIR"
  mkdir -p "$SNAPSHOT_SCRATCH_DIR"
  cp -a --parents \
    "$DOLT_DATA_ROOT" "$DOLT_SERVERCFG_DIR" "$DOLT_SECUREFILE_PATH" "$DOLT_ENTRYPOINT_PATH" \
    "$SNAPSHOT_SCRATCH_DIR" || fail "cp -a snapshot of the Dolt mount sources failed"
  local path
  for path in "$DOLT_DATA_ROOT" "$DOLT_SERVERCFG_DIR" "$DOLT_SECUREFILE_PATH" "$DOLT_ENTRYPOINT_PATH"; do
    [ -e "${SNAPSHOT_SCRATCH_DIR}${path}" ] || fail "snapshot of ${path} did not appear in the scratch tree"
  done
}

start_container() {
  set_stage start_container
  log "Starting ${DOLT_UNIT}"
  systemctl start "$DOLT_UNIT" || fail "systemctl start ${DOLT_UNIT} failed"
  wait_for_dolt_ready
  DOWNTIME_END_EPOCH=$(date +%s)
  log "Dolt back up after $((DOWNTIME_END_EPOCH - DOWNTIME_START_EPOCH))s downtime"
}

source_bytes() {
  local bytes
  bytes=$(du -sb "$1" 2>/dev/null | cut -f1)
  [ -n "$bytes" ] || fail "could not measure size of $1 (missing or unreadable)"
  printf '%s' "$bytes"
}

write_manifest() {
  set_stage write_manifest
  local ts data_bytes servercfg_bytes securefile_bytes entrypoint_bytes
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  # Inside the scratch tree, so every snapshot has the same single path.
  MANIFEST_PATH="${SNAPSHOT_SCRATCH_DIR}/beads-dolt-manifest-${ts}.json"
  data_bytes=$(source_bytes "${SNAPSHOT_SCRATCH_DIR}${DOLT_DATA_ROOT}")
  servercfg_bytes=$(source_bytes "${SNAPSHOT_SCRATCH_DIR}${DOLT_SERVERCFG_DIR}")
  securefile_bytes=$(source_bytes "${SNAPSHOT_SCRATCH_DIR}${DOLT_SECUREFILE_PATH}")
  entrypoint_bytes=$(source_bytes "${SNAPSHOT_SCRATCH_DIR}${DOLT_ENTRYPOINT_PATH}")
  cat >"$MANIFEST_PATH" <<JSON
{
  "backup_kind": "beads-dolt-tree",
  "captured_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "container": "beads-dolt",
  "excluded_sources": [
    {"role":"root_password_credential","path":"/run/secrets/beads-dolt-root-password","reason":"deliberately excluded; see docs/backup-recovery.md"}
  ],
  "sources": [
    {"role":"data","path":"$(json_escape "$DOLT_DATA_ROOT")","captured_bytes":${data_bytes}},
    {"role":"servercfg","path":"$(json_escape "$DOLT_SERVERCFG_DIR")","captured_bytes":${servercfg_bytes}},
    {"role":"securefile","path":"$(json_escape "$DOLT_SECUREFILE_PATH")","captured_bytes":${securefile_bytes}},
    {"role":"entrypoint","path":"$(json_escape "$DOLT_ENTRYPOINT_PATH")","captured_bytes":${entrypoint_bytes}}
  ],
  "databases": [$(printf '%s\n' "${DOLT_DATABASES_ARRAY[@]}" | sed 's/^/"/;s/$/"/' | paste -sd, -)],
  "downtime_seconds": $((DOWNTIME_END_EPOCH - DOWNTIME_START_EPOCH)),
  "checkpoint_before_stop": ${CHECKPOINT_BEFORE_STOP},
  "checkpoint_after_restart_authoritative": ${CHECKPOINT_AFTER_RESTART}
}
JSON
}

prepare() {
  mkdir -p "${BACKUP_STATE_DIR}/work"
  printf '%s\n' "$START_EPOCH" >"${BACKUP_STATE_DIR}/work/started"
  trap 'fail "unexpected error (exit code $?)"' ERR
  trap ensure_container_running EXIT
  split_databases
  [ -r "$DOLT_SQL_PASSWORD_FILE" ] || fail "SQL password file is not readable"
  DOLT_SQL_PASSWORD=$(cat "$DOLT_SQL_PASSWORD_FILE")

  set_stage checkpoint_before_stop
  log "Capturing pre-stop checkpoint (informational)"
  CHECKPOINT_BEFORE_STOP=$(capture_checkpoint_all) || fail "failed to capture the pre-stop checkpoint"
  assert_checkpoint_complete "$CHECKPOINT_BEFORE_STOP" "pre-stop"

  stop_container
  snapshot_sources
  start_container

  set_stage checkpoint_after_restart
  log "Capturing post-restart checkpoint (authoritative, matches the scratch copy)"
  CHECKPOINT_AFTER_RESTART=$(capture_checkpoint_all) || fail "failed to capture the post-restart checkpoint"
  assert_checkpoint_complete "$CHECKPOINT_AFTER_RESTART" "post-restart"

  write_manifest
  unset DOLT_SQL_PASSWORD
  set_stage upload_backup
  log "Scratch tree ready; restic uploads and applies retention next"
}

# ExecStopPost: systemd sets SERVICE_RESULT, EXIT_CODE and EXIT_STATUS.
cleanup() {
  local started stage
  started=$(cat "${BACKUP_STATE_DIR}/work/started" 2>/dev/null || echo "$START_EPOCH")
  stage=$(cat "$STAGE_FILE" 2>/dev/null || echo unknown)
  STAGE=$stage
  if [ "${SERVICE_RESULT:-}" = "success" ]; then
    local snapshot
    snapshot=$(restic snapshots --json --latest 1 --tag beads-dolt --host "$(hostname)" 2>/dev/null \
      | jq -r 'last | .short_id // empty' 2>/dev/null || true)
    STAGE="done"
    write_result "success" "backup uploaded" "${snapshot:-null}" "$started"
    log "BEADS_DOLT_BACKUP_RESULT=SUCCESS restic_snapshot=${snapshot:-unknown}"
  else
    # prepare() already wrote its own failure; a later failure is restic's.
    local recorded
    recorded=$(jq -r '.status + " " + .started_at' "$RESULT_FILE" 2>/dev/null || true)
    if [ "$recorded" != "failure $(date -u -d "@${started}" +%Y-%m-%dT%H:%M:%SZ)" ]; then
      [ "$stage" = "upload_backup" ] && STAGE=upload_or_retention
      write_result "failure" "restic exited with ${EXIT_CODE:-?}/${EXIT_STATUS:-?}" null "$started"
    fi
    echo "BEADS_DOLT_BACKUP_RESULT=FAILURE stage=${STAGE}" >&2
  fi
  rm -rf "$SNAPSHOT_SCRATCH_DIR" "$STAGE_FILE" "${BACKUP_STATE_DIR}/work/started"
}

case "${1:-}" in
  prepare) prepare ;;
  cleanup) cleanup ;;
  *)
    echo "usage: $SCRIPT_NAME prepare|cleanup" >&2
    exit 2
    ;;
esac
