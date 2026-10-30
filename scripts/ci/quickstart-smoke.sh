#!/usr/bin/env bash
# Prove the quickstart works from this checkout: bring it up,
# create the first admin with the setup token, and expect the three sample
# projects with issues. Leaves the stack running; `down -v` cleans up.
set -euo pipefail

compose=(docker compose -f quickstart/compose.yaml)
base="http://127.0.0.1:${BEADSMITH_PORT:-4321}"
trap '"${compose[@]}" ps; "${compose[@]}" logs --no-color --tail 60' ERR

"${compose[@]}" up -d --build --wait

token=$("${compose[@]}" exec -T beadsmith cat /state/setup-token | tr -d '\r\n')
password=$(head -c 32 /dev/urandom | base64 | tr -dc A-Za-z0-9)
headers=$(mktemp)
curl -fsS -o /dev/null -D "$headers" -X POST "$base/api/auth/sign-up/email" \
	-H 'Content-Type: application/json' -H "Origin: $base" -H 'x-bdx-request: 1' \
	-H "x-bdx-setup-token: $token" \
	--data "{\"name\":\"CI\",\"email\":\"ci@example.com\",\"password\":\"$password\"}"
# The session cookie is Secure; curl will not replay it over http by itself.
session=$(sed -n 's/^set-cookie: \(__Host-bdx_session=[^;]*\).*/\1/ip' "$headers" | tr -d '\r')
[ -n "$session" ] || { echo 'sign-up set no session cookie' >&2; exit 1; }

curl -fsS -H "Cookie: $session" "$base/api/projects" | jq -e '
	[.projects[] | select(.counts.total > 0) | .name] | sort == ["lighthouse", "pantry", "trailhead"]
' >/dev/null
echo 'quickstart: three sample projects visible to the first admin'
