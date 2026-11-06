# beads-dolt-grants: apply the account grants ADR 0013 decides
# (specs/decisions/0013-owner-account-and-global-readers.md):
#   beads_bd_writer   ALL PRIVILEGES ON *.* WITH GRANT OPTION, so a plain
#                     `bd init --server` can create a new project;
#   beads_web_reader  SELECT ON *.*, so Beadsmith and its in-app backups see it;
#   beads_backup      SELECT ON *.*, for the host's restic checkpoints.
#
# Runs after every start of the Dolt container (dolt.nix), so a host restored
# from a backup taken before the change converges too. GRANT is idempotent and
# this only adds: per-database grants the accounts already hold stay. It never
# creates an account or sets a password; an account that is missing fails the
# unit instead.
#
# SQL runs as root inside the container over its own loopback, because root
# exists only as root@localhost. The password goes through the environment
# (`docker exec -e NAME` copies the value without putting it in argv), never
# to argv or a log.

: "${DOLT_CONTAINER:?}" "${DOLT_ROOT_PASSWORD_FILE:?}"
READY_TIMEOUT="${READY_TIMEOUT:-90}"

DOLT_CLI_PASSWORD=$(cat "$DOLT_ROOT_PASSWORD_FILE")
export DOLT_CLI_PASSWORD

sql() {
  docker exec -e DOLT_CLI_PASSWORD "$DOLT_CONTAINER" \
    dolt --host 127.0.0.1 --port 3306 --user root --no-tls sql -q "$1"
}

waited=0
until sql 'SELECT 1' >/dev/null 2>&1; do
  if [ "$waited" -ge "$READY_TIMEOUT" ]; then
    echo "Dolt did not accept root over the container's loopback within ${READY_TIMEOUT}s" >&2
    exit 1
  fi
  sleep 2
  waited=$((waited + 2))
done

status=0
while IFS='|' read -r account statement; do
  if sql "$statement" >/dev/null; then
    echo "granted: $statement"
  else
    echo "failed: $statement (does the account '$account' exist?)" >&2
    status=1
  fi
done <<'GRANTS'
beads_bd_writer|GRANT ALL PRIVILEGES ON *.* TO 'beads_bd_writer'@'%' WITH GRANT OPTION
beads_web_reader|GRANT SELECT ON *.* TO 'beads_web_reader'@'%'
beads_backup|GRANT SELECT ON *.* TO 'beads_backup'@'%'
GRANTS
exit "$status"
