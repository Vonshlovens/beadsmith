#!/usr/bin/env bash
# End-to-end check of the shared Dolt server's account model (ADR 0013)
# against a throwaway Dolt container set up the way production is after the
# grant change: root exists only as root@localhost; beads_bd_writer (the
# owner's machines) has ALL PRIVILEGES ON *.*; beads_web_reader and
# beads_backup have SELECT ON *.*; agent_remote, an account for an agent that
# should reach only some projects, has grants on single projects only.
# Proves that
#   - stock `bd init --server --external` creates a new project as the writer,
#     and bd create and bd ready work, with no helper and no extra grant;
#   - Beadsmith's own discovery, as the reader, lists the new project; the
#     reader and backup accounts can read it and cannot write;
#   - the per-agent account stays narrow: it cannot create a database, reach
#     a project it was not granted, grant, create accounts, or touch mysql.*;
#     after the one-line grant, run by the writer through `bd sql`, bd create
#     and bd ready work for it;
#   - the trade-offs ADR 0013 records still hold on this Dolt: the writer is
#     root-equivalent, the reader can read mysql.user, and a partial revoke
#     of mysql.* does not take effect.
#
#   scripts/ci/dolt-grants-smoke.sh
#   DOLT_IMAGE=dolthub/dolt-sql-server:2.5.0 scripts/ci/dolt-grants-smoke.sh
#
# Needs docker, node (with `pnpm install` done), bd, jq, python3.
# Never touches any server but the throwaway container.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
# dolthub/dolt-sql-server:2.1.8, the digest production runs.
image=${DOLT_IMAGE:-dolthub/dolt-sql-server@sha256:96786c6553f8852cb24c18fc2c856a17d1bf3f9232426991eafab4167e7192f6}
work=$(mktemp -d "${TMPDIR:-/tmp}/dolt-grants-smoke.XXXXXX")
container="dolt-grants-smoke-$$"

cleanup() {
	status=$?
	if [ "$status" -ne 0 ]; then
		echo "--- dolt logs (tail):" >&2
		docker logs --tail 30 "$container" >&2 2>/dev/null || true
	fi
	docker rm -f "$container" >/dev/null 2>&1 || true
	if [ "${KEEP:-0}" = 1 ]; then echo "kept $work" >&2; else rm -rf "$work"; fi
}
trap cleanup EXIT

pass() { echo "ok - $*"; }
note() { echo "note - $*"; }
die() {
	echo "not ok - $*" >&2
	exit 1
}
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
secret() { head -c 24 /dev/urandom | base64 | tr -dc A-Za-z0-9; }

root_pw=$(secret)
writer_pw=$(secret)
reader_pw=$(secret)
backup_pw=$(secret)
agent_pw=$(secret)

# --- throwaway Dolt, root@localhost only ---------------------------------------
mkdir -p "$work/servercfg.d"
cat >"$work/servercfg.d/config.yaml" <<'EOF'
log_level: info
behavior:
  read_only: false
listener:
  host: 0.0.0.0
  port: 3306
EOF
dolt_port=$(free_port)
docker run -d --name "$container" --platform linux/amd64 \
	-e DOLT_ROOT_PASSWORD="$root_pw" -e DOLT_ROOT_HOST=localhost \
	-v "$work/servercfg.d:/etc/dolt/servercfg.d:ro" \
	-p "127.0.0.1:$dolt_port:3306" "$image" >/dev/null

# SQL inside the container over its own loopback (root is root@localhost).
sql_as() { # user password sql...
	local user=$1 password=$2
	shift 2
	DOLT_CLI_PASSWORD=$password docker exec -e DOLT_CLI_PASSWORD "$container" \
		dolt --host 127.0.0.1 --port 3306 --user "$user" --no-tls sql -r json -q "$*"
}
for _ in $(seq 1 90); do
	sql_as root "$root_pw" 'SELECT 1' >/dev/null 2>&1 && break
	sleep 2
done
sql_as root "$root_pw" 'SELECT 1' >/dev/null || die "Dolt did not come up"
version=$(sql_as root "$root_pw" 'SELECT dolt_version() AS v' | jq -r '.rows[0].v')
pass "Dolt $version up with root@localhost only"

# The account model from docs/new-project.md, plus a project nobody but the
# administrator created.
sql_as root "$root_pw" "
CREATE USER 'beads_bd_writer'@'%' IDENTIFIED BY '$writer_pw';
GRANT ALL PRIVILEGES ON *.* TO 'beads_bd_writer'@'%' WITH GRANT OPTION;
CREATE USER 'beads_web_reader'@'%' IDENTIFIED BY '$reader_pw';
GRANT SELECT ON *.* TO 'beads_web_reader'@'%';
CREATE USER 'beads_backup'@'%' IDENTIFIED BY '$backup_pw';
GRANT SELECT ON *.* TO 'beads_backup'@'%';
CREATE USER 'agent_remote'@'%' IDENTIFIED BY '$agent_pw';
CREATE DATABASE other_project;
CREATE TABLE other_project.notes (id INT PRIMARY KEY, body TEXT);
INSERT INTO other_project.notes VALUES (1, 'granted to nobody');" >/dev/null
pass "accounts and an unrelated project created"

# --- stock bd init as the writer -----------------------------------------------
# The owner's machine setup from docs/new-project.md: sync is live SQL on the
# shared server, so bd must not wire a git remote into it or push.
mkdir -p "$work/home/.config/bd"
printf 'no-push: true\ndolt:\n    local-only: true\n' >"$work/home/.config/bd/config.yaml"
# A clean environment, so nothing points bd at a real server. Another account
# uses the same checkout through BEADS_DOLT_SERVER_USER, which wins over
# metadata.json.
bd_as() { # dir user password bd-args...
	local dir=$1 user=$2 password=$3
	shift 3
	(cd "$dir" && env -i "PATH=$PATH" "HOME=$work/home" "BD_ACTOR=smoke-$user" \
		"GIT_CONFIG_GLOBAL=/dev/null" "BEADS_DOLT_SERVER_USER=$user" "BEADS_DOLT_PASSWORD=$password" \
		bd "$@")
}
bd_init() { # dir user password database prefix
	bd_as "$1" "$2" "$3" init --server --external --non-interactive \
		--server-host 127.0.0.1 --server-port "$dolt_port" --server-user "$2" \
		--database "$4" --prefix "$5"
}

repo="$work/repo"
mkdir -p "$repo"
git -C "$repo" init -q
# A git origin, as most real repositories have. Without the local-only setting
# above, bd init would add it as a Dolt remote on the shared server.
git init -q --bare "$work/origin.git"
git -C "$repo" remote add origin "$work/origin.git"
bd_init "$repo" beads_bd_writer "$writer_pw" smoke_proj smoke >"$work/init.log" 2>&1 ||
	{ cat "$work/init.log" >&2; die "stock bd init as the writer failed"; }
jq -e '.dolt_database == "smoke_proj" and .dolt_server_user == "beads_bd_writer"' \
	"$repo/.beads/metadata.json" >/dev/null || die "metadata.json does not name smoke_proj and the writer"
pass "stock bd init --server --external created smoke_proj as beads_bd_writer"

remotes=$(sql_as root "$root_pw" 'SELECT name, url FROM smoke_proj.dolt_remotes' | jq -c '[.rows[]?]')
[ "$remotes" = "[]" ] || die "bd init added Dolt remotes on the server despite local-only: $remotes"
pass "with no-push and dolt.local-only in ~/.config/bd/config.yaml, bd init adds no Dolt remote on the server"

id=$(bd_as "$repo" beads_bd_writer "$writer_pw" create "Smoke issue from the writer" -t task -p 2 --json | jq -r .id)
[ -n "$id" ] && [ "$id" != null ] || die "bd create returned no id"
bd_as "$repo" beads_bd_writer "$writer_pw" ready --json | jq -e --arg id "$id" 'map(.id) | index($id) != null' >/dev/null ||
	die "bd ready does not list $id"
pass "bd create ($id) and bd ready work as beads_bd_writer"

# The by-hand fix docs/new-project.md gives for a bd init that stopped
# halfway (gastownhall/beads#4566): as the writer, with a plain SQL client
# (bd itself would run its migrations first and stop on the same error),
# commit the leftover working set, then run bd init again.
sql_as beads_bd_writer "$writer_pw" "CREATE DATABASE halfdone; CREATE TABLE halfdone.leftover (id INT PRIMARY KEY)" >/dev/null
sql_as beads_bd_writer "$writer_pw" "USE halfdone; CALL DOLT_COMMIT('-Am', 'Commit the working set an unfinished bd init left')" \
	>/dev/null || die "writer could not commit halfdone's working set"
sql_as root "$root_pw" 'SELECT COUNT(*) AS n FROM halfdone.dolt_status' | jq -e '.rows[0].n == "0"' >/dev/null ||
	die "halfdone still has a dirty working set"
halfdone_repo="$work/halfdone"
mkdir -p "$halfdone_repo"
git -C "$halfdone_repo" init -q
bd_init "$halfdone_repo" beads_bd_writer "$writer_pw" halfdone half >"$work/halfdone.log" 2>&1 ||
	{ cat "$work/halfdone.log" >&2; die "bd init after the by-hand commit failed"; }
pass "the writer commits an unfinished init's working set with CALL DOLT_COMMIT, then bd init works"

# --- the reader and backup accounts see the new project ------------------------
# Beadsmith's own discovery code (src/lib/server/dolt/client.ts), as the reader.
discover() {
	(cd "$root" && env -i "PATH=$PATH" "HOME=$HOME" BEADS_DOLT_SERVER_HOST=127.0.0.1 \
		"BEADS_DOLT_SERVER_PORT=$dolt_port" BEADS_DOLT_SERVER_USER=beads_web_reader "BEADS_DOLT_PASSWORD=$reader_pw" \
		node --import ./scripts/ts-resolve.mjs scripts/ci/list-projects.ts)
}
discovered=$(discover) || die "Beadsmith discovery failed as the reader"
echo "$discovered" | jq -e '(.databases | index("smoke_proj") != null) and (.databases | index("mysql") == null)
	and .issues.smoke_proj == 1' >/dev/null || die "Beadsmith discovery as the reader returned $discovered"
pass "Beadsmith discovery as beads_web_reader lists smoke_proj (1 issue) with no extra grant"

sql_as beads_backup "$backup_pw" 'SELECT COUNT(*) AS n FROM smoke_proj.issues' | jq -e '.rows[0].n == "1"' >/dev/null ||
	die "backup account cannot read smoke_proj"
for user in beads_web_reader beads_backup; do
	pw=$reader_pw
	[ "$user" = beads_backup ] && pw=$backup_pw
	for statement in "DELETE FROM smoke_proj.issues" "CREATE DATABASE smoke_evil" \
		"UPDATE mysql.user SET Super_priv = 'Y' WHERE User = '$user'"; do
		if sql_as "$user" "$pw" "$statement" >/dev/null 2>&1; then
			die "$user could run: $statement"
		fi
	done
done
pass "backup account reads smoke_proj; reader and backup cannot write, create databases or write mysql.*"

# --- a per-agent account stays narrow -------------------------------------------
agent_repo="$work/agent-repo"
git clone -q "$repo" "$agent_repo" 2>/dev/null || { mkdir -p "$agent_repo" && git -C "$agent_repo" init -q; }
# Same project config as the owner's checkout (bd init may not have committed it).
rm -rf "$agent_repo/.beads"
cp -R "$repo/.beads" "$agent_repo/.beads"
if out=$(bd_as "$agent_repo" agent_remote "$agent_pw" ready --json 2>&1); then
	die "Agent account reached smoke_proj before any grant: $out"
fi
pass "agent account cannot open smoke_proj before its grant"

agent_new="$work/agent-new"
mkdir -p "$agent_new"
git -C "$agent_new" init -q
if out=$(bd_init "$agent_new" agent_remote "$agent_pw" agent_new agentnew 2>&1); then
	die "Agent account created a database with bd init: $out"
fi
echo "$out" | grep -E -qi 'denied|not allowed' || die "agent bd init failed for another reason: $out"
[ "$(sql_as root "$root_pw" "SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'agent_new'" |
	jq -r '.rows[0].n')" = 0 ] || die "agent_new exists after the refused init"
pass "agent account's bd init of a new database is refused (CREATE DATABASE denied)"

# The one-line grant from docs/new-project.md, run by the owner from any of
# their checkouts with bd sql (no SSH to the Dolt host).
grant_line="GRANT ALL PRIVILEGES ON \`smoke_proj\`.* TO 'agent_remote'@'%'"
bd_as "$repo" beads_bd_writer "$writer_pw" sql "$grant_line" >/dev/null || die "writer could not run: $grant_line"
pass "writer ran the per-agent grant with bd sql: $grant_line"

agent_id=$(bd_as "$agent_repo" agent_remote "$agent_pw" create "Smoke issue from a remote agent" -t task -p 2 --json |
	jq -r .id)
[ -n "$agent_id" ] && [ "$agent_id" != null ] || die "bd create as the agent account returned no id"
bd_as "$agent_repo" agent_remote "$agent_pw" ready --json |
	jq -e --arg a "$id" --arg b "$agent_id" 'map(.id) | (index($a) != null) and (index($b) != null)' >/dev/null ||
	die "bd ready as the agent account does not list $id and $agent_id"
pass "after the grant, bd create ($agent_id) and bd ready work as agent_remote"

# A new project from that agent, as docs/new-project.md gives it: the owner
# creates the empty database and grants it, the agent runs bd init, and the
# owner's account goes back into metadata.json.
for statement in "CREATE DATABASE IF NOT EXISTS \`agent_proj\`" \
	"GRANT ALL PRIVILEGES ON \`agent_proj\`.* TO 'agent_remote'@'%'"; do
	bd_as "$repo" beads_bd_writer "$writer_pw" sql "$statement" >/dev/null || die "writer could not run: $statement"
done
agent_init="$work/agent-init"
mkdir -p "$agent_init"
git -C "$agent_init" init -q
bd_init "$agent_init" agent_remote "$agent_pw" agent_proj agentp >"$work/agent-init.log" 2>&1 ||
	{ cat "$work/agent-init.log" >&2; die "agent bd init of a granted, empty database failed"; }
bd_as "$agent_init" agent_remote "$agent_pw" dolt set user beads_bd_writer >>"$work/agent-init.log" 2>&1 ||
	{ cat "$work/agent-init.log" >&2; die "bd dolt set user failed"; }
jq -e '.dolt_server_user == "beads_bd_writer"' "$agent_init/.beads/metadata.json" >/dev/null ||
	die "metadata.json does not name beads_bd_writer after bd dolt set user"
agent_proj_id=$(bd_as "$agent_init" agent_remote "$agent_pw" create "Smoke issue in an agent-made project" \
	-t task -p 2 --json | jq -r .id)
bd_as "$agent_init" beads_bd_writer "$writer_pw" ready --json | jq -e --arg id "$agent_proj_id" 'map(.id) | index($id) != null' \
	>/dev/null || die "the owner's bd ready does not list $agent_proj_id"
pass "agent bd init of an empty, granted database works; after bd dolt set user the owner's bd ready sees $agent_proj_id"

discovered=$(discover) || die "Beadsmith discovery failed as the reader"
echo "$discovered" | jq -e '.issues.smoke_proj == 2 and .issues.agent_proj == 1' >/dev/null ||
	die "Beadsmith discovery after the agent's write returned $discovered"
pass "Beadsmith discovery sees the agent's issue too: $(echo "$discovered" | jq -c .issues)"

agent_denied() { # description sql
	local out
	if out=$(sql_as agent_remote "$agent_pw" "$2" 2>&1); then
		die "Agent account could $1: $out"
	fi
	echo "$out" | grep -E -qi 'denied|not allowed|privilege' || die "Agent account $1 failed for another reason: $out"
}
agent_denied "GRANT on its project" "GRANT SELECT ON smoke_proj.* TO 'beads_web_reader'@'%'"
agent_denied "GRANT on *.*" "GRANT ALL PRIVILEGES ON *.* TO 'agent_remote'@'%'"
agent_denied "read mysql.user" "SELECT authentication_string FROM mysql.user"
agent_denied "write mysql.user" "UPDATE mysql.user SET Super_priv = 'Y' WHERE User = 'agent_remote'"
agent_denied "write mysql.db" "INSERT INTO mysql.db (Host, Db, User, Select_priv) VALUES ('%', 'other_project', 'agent_remote', 'Y')"
agent_denied "create a user" "CREATE USER 'smoke_evil'@'%' IDENTIFIED BY 'x'"
agent_denied "create a database" "CREATE DATABASE smoke_evil"
agent_denied "read another project" "SELECT * FROM other_project.notes"
agent_denied "drop another project" "DROP DATABASE other_project"
pass "agent account cannot GRANT, read or write mysql.*, create users or databases, or reach other_project"

# --- trade-offs ADR 0013 records -------------------------------------------------
sql_as beads_bd_writer "$writer_pw" 'SELECT COUNT(*) AS n FROM other_project.notes' | jq -e '.rows[0].n == "1"' >/dev/null ||
	die "writer cannot read other_project"
sql_as beads_bd_writer "$writer_pw" "UPDATE mysql.user SET Super_priv = 'Y' WHERE User = 'smoke_nobody'" >/dev/null ||
	die "writer cannot write mysql.user; ADR 0013 calls it root-equivalent, revisit"
pass "writer reads every project and may write mysql.* (root-equivalent, as ADR 0013 says)"

sql_as beads_web_reader "$reader_pw" "SELECT COUNT(*) AS n FROM mysql.user WHERE LENGTH(authentication_string) > 0" |
	jq -e '(.rows[0].n | tonumber) >= 5' >/dev/null || die "reader cannot read mysql.user hashes; revisit ADR 0013"
sql_as root "$root_pw" "REVOKE SELECT ON mysql.* FROM 'beads_web_reader'@'%'" >/dev/null 2>&1 || true
if sql_as beads_web_reader "$reader_pw" 'SELECT COUNT(*) AS n FROM mysql.user' >/dev/null 2>&1; then
	pass "reader can read mysql.user hashes, and REVOKE SELECT ON mysql.* does not take effect"
else
	note "this Dolt honors REVOKE SELECT ON mysql.* after a global grant: readers can be kept out of mysql.* with it"
fi

echo "dolt-grants smoke: all checks passed (Dolt $version)"
