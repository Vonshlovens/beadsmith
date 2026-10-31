#!/usr/bin/env bash
# Check that a tree of this public repository is safe to push: gitleaks,
# trufflehog and an optional private denylist over exactly what git would
# publish (the index by default, or --ref REF), and that every commit on HEAD
# carries a GitHub noreply address. Nothing is changed.
#
#   scripts/public-scan.sh [--ref REF] [--denylist FILE]
#
# The denylist (default $BEADSMITH_PUBLIC_DENYLIST, else
# ~/.config/beadsmith/public-denylist.txt when present) holds private
# identifiers, one extended regex per line, # for comments. It lives outside
# this repository and its patterns are never printed; hits show file:line only.
# Secrets and addresses belong in fleet/secrets/ (sops), as in
# ghuntley/overalls; this scan is the backstop.
set -euo pipefail

ref=
denylist=${BEADSMITH_PUBLIC_DENYLIST:-}
[ -n "$denylist" ] || [ ! -f "$HOME/.config/beadsmith/public-denylist.txt" ] \
	|| denylist="$HOME/.config/beadsmith/public-denylist.txt"

die() {
	echo "public-scan: $*" >&2
	exit 1
}

while [ $# -gt 0 ]; do
	case "$1" in
	--ref) ref=$2; shift 2 ;;
	--denylist) denylist=$2; shift 2 ;;
	-h | --help) sed -n '2,15p' "$0"; exit 0 ;;
	*) die "unknown argument: $1" ;;
	esac
done

repo=$(git rev-parse --show-toplevel)
tree=${ref:-$(git -C "$repo" write-tree)}
out=$(mktemp -d "${TMPDIR:-/tmp}/beadsmith-scan.XXXXXX")
trap 'rm -rf "$out"' EXIT
git -C "$repo" archive --format=tar "$tree" | tar -x -C "$out"

failed=0
if command -v gitleaks >/dev/null 2>&1; then
	if (cd "$out" && gitleaks dir . --config .gitleaks.toml --no-banner --redact --log-level warn); then
		echo "gitleaks: clean"
	else
		echo "FAIL: gitleaks findings (above)"
		failed=1
	fi
else
	echo "FAIL: gitleaks is not installed"
	failed=1
fi

if command -v trufflehog >/dev/null 2>&1; then
	found=$(trufflehog filesystem "$out" --json --no-update --results=verified,unknown,unverified 2>/dev/null | wc -l | tr -d ' ')
	if [ "$found" = 0 ]; then
		echo "trufflehog: clean"
	else
		echo "FAIL: trufflehog reported $found result(s)"
		failed=1
	fi
else
	echo "FAIL: trufflehog is not installed"
	failed=1
fi

if [ -n "$denylist" ]; then
	[ -f "$denylist" ] || die "denylist not found: $denylist"
	count=0
	while IFS= read -r pattern; do
		count=$((count + 1))
		hits=$(grep -rnIiE -- "$pattern" "$out" | sed "s|^$out/||" | cut -d: -f1,2) || true
		if [ -n "$hits" ]; then
			echo "FAIL: denylist pattern #$count matched at"
			echo "$hits" | sed 's/^/    /'
			failed=1
		fi
	done < <(sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$denylist")
	# Commit metadata is published too: every author and committer on HEAD,
	# including the merge commits GitHub makes on its side.
	people=$(git -C "$repo" log --format='%an <%ae>%n%cn <%ce>' HEAD 2>/dev/null | sort -u) || true
	while IFS= read -r pattern; do
		if grep -qiE -- "$pattern" <<<"$people"; then
			echo "FAIL: a denylisted identity authored or committed a commit on HEAD"
			failed=1
		fi
	done < <(sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$denylist")
	echo "denylist: $count pattern(s) checked"
else
	echo "warning: no denylist; only the scanners ran"
fi

# Every commit address must be a GitHub noreply one. A merge made in GitHub's
# web UI uses the account's primary address unless "Keep my email addresses
# private" is on, so a real address can land on main without a local push.
emails=$(git -C "$repo" log --format='%ae%n%ce' HEAD 2>/dev/null | sort -u \
	| grep -viE '^([0-9]+\+)?[^@]+@users\.noreply\.github\.com$|^noreply@github\.com$') || true
if [ -n "$emails" ]; then
	echo "FAIL: $(wc -l <<<"$emails" | tr -d ' ') commit address(es) on HEAD are not GitHub noreply addresses"
	failed=1
else
	echo "commit addresses: noreply only"
fi

[ "$failed" = 0 ] || die "checks failed"
echo "public-scan: clean"
