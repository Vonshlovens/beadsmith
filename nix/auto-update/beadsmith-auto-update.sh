# beadsmith-auto-update: follow one branch of the public flake (ghuntley/overalls
# ADR-0036, adapted). CI advances that branch only after every check, the VM
# test and the image pass on main, so the host deploys nothing CI has not
# passed.
#
#   beadsmith-auto-update run      one poll (the timer runs this)
#   beadsmith-auto-update status   print status.json
#
# A poll: read the branch head; if it is the running, healthy revision, stop.
# Otherwise build exactly that revision's system, switch to it, and require
# two healthy observations HEALTH_INTERVAL seconds apart within HEALTH_TIMEOUT
# (health URL answers 204, every required unit active). If the switch or the
# health check fails, switch back to the previous generation, verify it, and
# record the revision as failed; it is retried after a backoff of 30 s
# doubling to 15 min, and a newer revision bypasses the backoff.
#
# Rollback restores the system, not data: Beadsmith's state.db and Dolt keep
# whatever the failed release wrote, so releases must stay compatible with
# the previous one.
#
# Configuration (environment, set by nix/modules/auto-update.nix):
#   REPOSITORY BRANCH FLAKE_ATTR HEALTH_URL HEALTH_TIMEOUT HEALTH_INTERVAL
#   REQUIRED_UNITS STATE_DIR
# Test seams (nix/tests/auto-update.sh): PROFILE CURRENT_SYSTEM, and the
# commands are looked up on PATH.
set -euo pipefail

: "${REPOSITORY:?}" "${BRANCH:?}" "${FLAKE_ATTR:?}" "${HEALTH_URL:?}" "${STATE_DIR:?}"
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-120}
HEALTH_INTERVAL=${HEALTH_INTERVAL:-5}
REQUIRED_UNITS=${REQUIRED_UNITS:-}
PROFILE=${PROFILE:-/nix/var/nix/profiles/system}
CURRENT_SYSTEM=${CURRENT_SYSTEM:-/run/current-system}
STATUS=$STATE_DIR/status.json

log() { echo "beadsmith-auto-update: $*" >&2; }
now() { date +%s; }

status_get() { jq -r "$1 // empty" "$STATUS" 2>/dev/null || true; }
# status_set KEY=JSON ... : merge into status.json atomically.
status_set() {
	local tmp=$STATUS.tmp args=() filter='.'
	for kv in "$@"; do
		args+=(--argjson "${kv%%=*}" "${kv#*=}")
		filter+=" | .${kv%%=*} = \$${kv%%=*}"
	done
	[ -s "$STATUS" ] || echo '{}' >"$STATUS"
	jq "${args[@]}" "$filter | .updatedAt = $(now)" "$STATUS" >"$tmp"
	mv "$tmp" "$STATUS"
}
str() { jq -n --arg v "$1" '$v'; }

healthy_once() {
	local code unit
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" || true)
	[ "$code" = 204 ] || return 1
	for unit in $REQUIRED_UNITS; do
		systemctl is-active --quiet "$unit" || return 1
	done
}

# Two healthy observations HEALTH_INTERVAL apart, within HEALTH_TIMEOUT.
verify_health() {
	local deadline=$(($(now) + HEALTH_TIMEOUT)) streak=0
	while [ "$(now)" -le "$deadline" ]; do
		if healthy_once; then
			streak=$((streak + 1))
			[ "$streak" -ge 2 ] && return 0
		else
			streak=0
		fi
		sleep "$HEALTH_INTERVAL"
	done
	return 1
}

activate() {
	nix-env -p "$PROFILE" --set "$1"
	"$1/bin/switch-to-configuration" switch
}

fail_revision() {
	local rev=$1 phase=$2 failures delay
	failures=$(status_get '.failures')
	[ "$(status_get '.failedRevision')" = "$rev" ] || failures=0
	failures=$((${failures:-0} + 1))
	delay=$((30 << (failures - 1)))
	[ "$delay" -le 900 ] && [ "$failures" -le 6 ] || delay=900
	status_set "phase=$(str failed)" "failedRevision=$(str "$rev")" "failedPhase=$(str "$phase")" \
		"failures=$failures" "nextAttempt=$(($(now) + delay))"
	log "revision $rev failed at $phase (attempt $failures); retry in ${delay}s"
}

run() {
	mkdir -p "$STATE_DIR"
	exec 9>"$STATE_DIR/lock"
	flock -n 9 || { log "another poll is running"; return 0; }

	local rev active previous candidate
	rev=$(git ls-remote "$REPOSITORY" "refs/heads/$BRANCH" | cut -f1)
	[[ "$rev" =~ ^[0-9a-f]{40}$ ]] || { log "no usable head for $BRANCH"; return 1; }
	active=$(readlink -f "$CURRENT_SYSTEM")

	if [ "$(status_get '.lastHealthy')" = "$rev" ] && [ "$(status_get '.activeSystem')" = "$active" ]; then
		return 0
	fi
	if [ "$(status_get '.failedRevision')" = "$rev" ] && [ "$(now)" -lt "$(status_get '.nextAttempt')" ]; then
		return 0
	fi

	log "candidate $rev"
	status_set "phase=$(str build)" "candidate=$(str "$rev")"
	if ! candidate=$(nix build --no-link --print-out-paths \
		"git+$REPOSITORY?ref=refs/heads/$BRANCH&rev=$rev#nixosConfigurations.$FLAKE_ATTR.config.system.build.toplevel"); then
		fail_revision "$rev" build
		return 1
	fi

	if [ "$candidate" != "$active" ]; then
		previous=$(readlink -f "$PROFILE")
		status_set "phase=$(str switch)" "previousSystem=$(str "$previous")"
		if ! activate "$candidate"; then
			log "switch to $candidate failed; checking health anyway"
		fi
		status_set "phase=$(str verify)" "activeSystem=$(str "$(readlink -f "$CURRENT_SYSTEM")")"
		if ! verify_health; then
			log "unhealthy after switch; rolling back to $previous"
			status_set "phase=$(str rollback)"
			activate "$previous" || log "switch back to $previous failed"
			if verify_health; then
				status_set "activeSystem=$(str "$(readlink -f "$CURRENT_SYSTEM")")"
			else
				log "previous system is unhealthy too; needs the operator"
			fi
			fail_revision "$rev" verify
			return 1
		fi
	elif ! verify_health; then
		fail_revision "$rev" verify
		return 1
	fi

	status_set "phase=$(str healthy)" "lastHealthy=$(str "$rev")" \
		"activeSystem=$(str "$(readlink -f "$CURRENT_SYSTEM")")" \
		"failedRevision=null" "failures=0" "nextAttempt=0"
	log "revision $rev is healthy"
}

case "${1:-}" in
run) run ;;
status) cat "$STATUS" 2>/dev/null || echo '{}' ;;
*)
	echo "usage: beadsmith-auto-update run|status" >&2
	exit 2
	;;
esac
