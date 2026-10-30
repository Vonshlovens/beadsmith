#!/usr/bin/env bash
# Cutover checkpoint: per-database issue count, commit count and HEAD, then
# the SQL users, as CSV. Run the same script before the wipe and after each
# restore, and diff the outputs (docs/operations/backup-and-restore.md):
#   ssh beads-admin@beads 'sudo bash -s' < fleet/scripts/checkpoint.sh
#   CONTAINER=beads-verify fleet/scripts/checkpoint.sh      # local copy
# The databases are listed from the server, so their names stay out of this
# public repository.
set -euo pipefail
container=${CONTAINER:-beads-dolt}

# No -i: run as `bash -s`, the script itself is on stdin.
sql() { docker exec "$container" dolt sql -r csv "$@" </dev/null; }

dbs=$(sql -q 'SHOW DATABASES' | tail -n +2 | tr -d '\r' \
  | grep -vxE 'information_schema|mysql|performance_schema|sys|dolt_cluster' | sort)
[ -n "$dbs" ] || { echo "no databases found in $container" >&2; exit 1; }

query=
for db in $dbs; do
  [ -z "$query" ] || query+=" UNION ALL "
  query+="SELECT '$db' AS db, (SELECT COUNT(*) FROM \`$db\`.issues) AS issues, (SELECT COUNT(*) FROM \`$db\`.dolt_log) AS commits, (SELECT commit_hash FROM \`$db\`.dolt_log ORDER BY date DESC LIMIT 1) AS head"
done
sql -q "$query"
sql -q 'SELECT user, host FROM mysql.user ORDER BY user, host'
