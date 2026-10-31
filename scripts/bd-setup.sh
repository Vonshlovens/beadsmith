#!/usr/bin/env bash
# Point bd at the maintainer's Beads database in a fresh clone or worktree.
#
# .beads/ is not in this public repository: which Dolt server, SQL user and
# database hold Beadsmith's own issues is the maintainer's configuration, as
# in upstream beads. Each machine keeps a copy outside the repo and this
# script installs it:
#
#   scripts/bd-setup.sh && bd ready
#
# Source: $BEADSMITH_BD_CONFIG (default ~/.config/beadsmith/beads/), holding
# metadata.json and config.yaml from a working checkout's .beads/, and
# optionally CLAUDE.local.md, claude-settings.local.json, codex/ and
# skills-beads/ (the maintainer's agent setup for the tracker). Existing
# files are left alone. The SQL password is never here; bd reads it from
# ~/.config/beads/credentials. Contributors without that server create their
# own project instead (docs/new-project.md).
set -euo pipefail

src=${BEADSMITH_BD_CONFIG:-$HOME/.config/beadsmith/beads}
cd "$(git rev-parse --show-toplevel)"
[ -f "$src/metadata.json" ] || {
	echo "bd-setup: no $src/metadata.json; copy .beads/metadata.json and config.yaml there from a working checkout" >&2
	exit 1
}

mkdir -p .beads
for f in metadata.json config.yaml; do
	if [ -e ".beads/$f" ]; then
		echo "kept .beads/$f"
	elif [ -f "$src/$f" ]; then
		cp "$src/$f" ".beads/$f"
		echo "installed .beads/$f"
	fi
done
# Agent shells do not source the login profile, so pin the port per checkout.
[ -s .beads/dolt-server.port ] || printf '3306\n' > .beads/dolt-server.port

# The maintainer's agent setup for the tracker: Claude Code notes and hooks,
# Codex hooks and the beads skill. All ignored by git.
install_once() {
	[ -e "$src/$1" ] || return 0
	if [ -e "$2" ]; then
		echo "kept $2"
	else
		mkdir -p "$(dirname "$2")"
		cp -R "$src/$1" "$2"
		echo "installed $2"
	fi
}
install_once CLAUDE.local.md CLAUDE.local.md
install_once claude-settings.local.json .claude/settings.local.json
install_once codex .codex
install_once skills-beads .agents/skills/beads
