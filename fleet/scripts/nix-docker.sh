#!/usr/bin/env bash
# Run a command with Nix inside Docker, for Macs without a local Nix.
#
#   fleet/scripts/nix-docker.sh nix build .#nixosConfigurations.beads.config.system.build.toplevel
#   fleet/scripts/nix-docker.sh            # interactive shell
#
# The container is native arm64 (fast evaluation). Docker Desktop's Rosetta
# binfmt handler runs the few x86_64-linux build steps, so the result is the
# real x86_64-linux closure; almost everything comes from cache.nixos.org.
# The Nix store persists in the Docker volume `beads-nix-store`.
#
# The flake directory is mounted at /work. The private age keys are NOT
# mounted unless BEADS_MOUNT_KEYS=1 (only the secrets scripts need them).
# BEADS_DOCKER_ENV="NAME1 NAME2" passes those variables into the container.
set -euo pipefail

here=$(cd "$(dirname "$0")/../.." && pwd)
keys_dir="$HOME/.config/sops/age"

args=(
  --rm --platform linux/arm64
  -v beads-nix-store:/nix
  -v "$here":/work
  -w /work
  -e NIX_CONFIG="experimental-features = nix-command flakes
extra-platforms = x86_64-linux
sandbox = false
filter-syscalls = false
max-jobs = auto
warn-dirty = false"
)
# In a git worktree, .git is a file pointing into the main checkout's .git by
# absolute path, both ways; mount both at their real paths so flake
# evaluation can read the repository.
if [ -f "$here/.git" ]; then
  common=$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)
  args+=(-v "$common":"$common" -v "$here":"$here" -w "$here")
fi
if [ "${BEADS_MOUNT_KEYS:-0}" = 1 ]; then
  args+=(-v "$keys_dir":/keys:ro -e SOPS_AGE_KEY_FILE="${BEADS_SOPS_KEY:-/keys/keys.txt}")
fi
# Pass named variables through without putting their values in argv.
for var in ${BEADS_DOCKER_ENV:-}; do
  args+=(-e "$var")
done
if [ -t 0 ] && [ -t 1 ]; then
  args+=(-it)
else
  args+=(-i)
fi

if [ "$#" -eq 0 ]; then
  set -- bash
fi
exec docker run "${args[@]}" nixos/nix:latest "$@"
