# Drives nix/auto-update/beadsmith-auto-update.sh against stub git, nix,
# nix-env, curl, systemctl and switch-to-configuration (nix/tests/auto-update.nix).
# Covers: first deploy, no-op poll, unhealthy candidate rolled back, backoff,
# a newer revision bypassing it, and a build failure. Usage: auto-update.sh SCRIPT
set -euo pipefail
updater=$1
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/state"
export STATE_DIR=$work/state PROFILE=$work/profile CURRENT_SYSTEM=$work/current
export REPOSITORY=https://example.invalid/beadsmith BRANCH=deploy FLAKE_ATTR=beads
export HEALTH_URL=http://127.0.0.1:4321/healthz HEALTH_TIMEOUT=2 HEALTH_INTERVAL=0
export REQUIRED_UNITS=beadsmith.service CALLS=$work/calls
touch "$CALLS"

# One fake system per revision; bad-* systems answer 500.
system() {
	local s=$work/sys-$1
	mkdir -p "$s/bin"
	cat >"$s/bin/switch-to-configuration" <<SW
#!/usr/bin/env bash
ln -sfn "$s" "$CURRENT_SYSTEM"
SW
	chmod +x "$s/bin/switch-to-configuration"
}
for s in old a bad-b c; do system "$s"; done
ln -sfn "$work/sys-old" "$PROFILE"
ln -sfn "$work/sys-old" "$CURRENT_SYSTEM"

stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" >"$work/bin/$1"; chmod +x "$work/bin/$1"; }
stub git 'printf "%s\trefs/heads/deploy\n" "$(cat '"$work"'/head)"'
stub nix 'echo nix >>"$CALLS"; rev=$(cat '"$work"'/head); case "$rev" in dddd*) exit 1 ;; esac; echo '"$work"'/sys-$(cat '"$work"'/map-$rev)'
stub nix-env 'ln -sfn "$4" "$PROFILE"'  # nix-env -p PROFILE --set PATH
stub curl 'case "$(readlink -f "$CURRENT_SYSTEM")" in */sys-bad-*) echo 500 ;; *) echo 204 ;; esac'
stub systemctl 'exit 0'
stub sleep 'exit 0'
export PATH=$work/bin:$PATH

A=$(printf 'a%.0s' {1..40}) B=$(printf 'b%.0s' {1..40}) C=$(printf 'c%.0s' {1..40}) D=$(printf 'd%.0s' {1..40})
echo a >"$work/map-$A"; echo bad-b >"$work/map-$B"; echo c >"$work/map-$C"
deploy() { echo "$1" >"$work/head"; bash "$updater" run; }
current() { basename "$(readlink -f "$CURRENT_SYSTEM")"; }
st() { jq -r "$1" "$STATE_DIR/status.json"; }
nixcalls() { wc -l <"$CALLS" | tr -d ' '; }
ok() { echo "ok: $*"; }
# expect ACTUAL EXPECTED WHAT
expect() { [ "$1" = "$2" ] || { echo "FAIL: $3: got '$1', want '$2'"; exit 1; }; }

deploy "$A"
expect "$(current)" sys-a current; expect "$(st .lastHealthy)" "$A" lastHealthy; expect "$(st .phase)" healthy phase
ok "first deploy switches and records the healthy revision"

n=$(nixcalls); deploy "$A"
expect "$(nixcalls)" "$n" "nix builds"
ok "an unchanged healthy revision is a no-op"

if deploy "$B"; then echo "FAIL: unhealthy revision reported success"; exit 1; fi
expect "$(current)" sys-a current; expect "$(st .failedRevision)" "$B" failedRevision
expect "$(st .failedPhase)" verify failedPhase; expect "$(st .lastHealthy)" "$A" lastHealthy
ok "an unhealthy candidate is rolled back and recorded"

n=$(nixcalls); deploy "$B" || true
expect "$(nixcalls)" "$n" "nix builds"
ok "a failed revision waits for its backoff"

deploy "$C"
expect "$(current)" sys-c current; expect "$(st .lastHealthy)" "$C" lastHealthy; expect "$(st .failedRevision)" null failedRevision
ok "a newer revision bypasses the backoff"

if deploy "$D"; then echo "FAIL: build failure reported success"; exit 1; fi
expect "$(current)" sys-c current; expect "$(st .failedPhase)" build failedPhase
ok "a build failure leaves the running system alone"
