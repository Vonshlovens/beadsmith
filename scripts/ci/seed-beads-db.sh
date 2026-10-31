#!/usr/bin/env bash
# Create a Beads project database with a given bd release, for schema
# compatibility tests. Works against any Dolt sql-server.
#
#   BEADS_DOLT_SERVER_HOST=127.0.0.1 BEADS_DOLT_SERVER_PORT=3307 \
#   BEADS_DOLT_SERVER_USER=root BEADS_DOLT_PASSWORD=... \
#   scripts/ci/seed-beads-db.sh /path/to/bd compat_1_3
#
# The database gets open, in-progress, and closed issues with labels, a
# blocking dependency, and a comment: enough for every read-plane query.
set -euo pipefail

BD=${1:?usage: seed-beads-db.sh <bd-binary> <database>}
DB=${2:?usage: seed-beads-db.sh <bd-binary> <database>}
: "${BEADS_DOLT_SERVER_HOST:?}" "${BEADS_DOLT_SERVER_PORT:?}" "${BEADS_DOLT_SERVER_USER:?}"
export BD_NON_INTERACTIVE=1

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
git init -q
git config user.email ci@example.com
git config user.name ci

"$BD" init --server --external \
	--server-host "$BEADS_DOLT_SERVER_HOST" \
	--server-port "$BEADS_DOLT_SERVER_PORT" \
	--server-user "$BEADS_DOLT_SERVER_USER" \
	--database "$DB" --prefix "$DB" --non-interactive >/dev/null

epic=$("$BD" create --title "Compat epic" --type epic --priority 1 --silent)
a=$("$BD" create --title "Open task with label" --description "Line one
line two" --type task --priority 2 --silent)
b=$("$BD" create --title "Blocking bug" --type bug --priority 0 --silent)
c=$("$BD" create --title "Closed feature" --type feature --priority 3 --silent)
"$BD" label add "$a" backend >/dev/null
"$BD" label add "$b" urgent >/dev/null
"$BD" dep add "$a" "$b" >/dev/null
"$BD" comment "$a" "First comment; with punctuation" >/dev/null
"$BD" update "$b" --status in_progress >/dev/null
"$BD" close "$c" --reason "done" >/dev/null
echo "$DB: $epic $a $b $c"
