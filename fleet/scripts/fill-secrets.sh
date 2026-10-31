#!/usr/bin/env bash
# Fill values in fleet/secrets/beads.yaml without ever printing them. For the
# operator, on a machine with the admin age key (docs/operations/host-beads.md).
#
#   fleet/scripts/fill-secrets.sh generate    Better Auth secret and master key,
#                                       only while they are still placeholders
#   fleet/scripts/fill-secrets.sh tailscale   prompt (hidden) for a new auth key
#   fleet/scripts/fill-secrets.sh check       names of keys still holding placeholders
#
# Environment:
#   SECRETS_FILE   default fleet/secrets/beads.yaml (relative to the flake)
# sops: a local `sops` with SOPS_AGE_KEY_FILE (default ~/.config/sops/age/keys.txt),
# or, without one, sops from nixpkgs in Docker (fleet/scripts/nix-docker.sh).
# Other values: `sops set` or `sops edit` directly.
set -euo pipefail

cd "$(dirname "$0")/../.."
SECRETS_FILE=${SECRETS_FILE:-fleet/secrets/beads.yaml}


sops_cmd() {
  if command -v sops >/dev/null 2>&1; then
    SOPS_AGE_KEY_FILE=${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt} sops "$@"
  else
    BEADS_MOUNT_KEYS=1 fleet/scripts/nix-docker.sh nix --quiet shell nixpkgs/nixos-26.05#sops -c sops "$@"
  fi
}

# stdin: the exact value bytes. Stored as a JSON string, byte for byte.
set_value() {
  local key=$1
  jq -Rs . | sops_cmd set --value-stdin "$SECRETS_FILE" "[\"${key}\"]"
}

# Prints only key names, never values.
placeholders() {
  sops_cmd decrypt --output-type json "$SECRETS_FILE" \
    | jq -r 'to_entries[] | select((.value | type) == "string" and (.value | startswith("PLACEHOLDER"))) | .key'
}

is_placeholder() {
  placeholders | grep -qx "$1"
}





do_generate() {
  # Never rotate these by accident: a new Better Auth secret signs everyone
  # out, and a new master key makes saved backup credentials unreadable.
  if is_placeholder beads-web-better-auth-secret; then
    openssl rand -base64 32 | tr -d '\n' | set_value beads-web-better-auth-secret
    echo "generated beads-web-better-auth-secret"
  else
    echo "beads-web-better-auth-secret already set; left alone"
  fi
  if is_placeholder beads-web-master-key; then
    openssl rand -hex 32 | tr -d '\n' | set_value beads-web-master-key
    echo "generated beads-web-master-key"
  else
    echo "beads-web-master-key already set; left alone"
  fi
}

do_tailscale() {
  local key
  printf 'Tailscale auth key (input hidden): ' >&2
  IFS= read -rs key
  printf '\n' >&2
  case "$key" in
    tskey-auth-*) ;;
    *) echo "that does not look like a tskey-auth-... key" >&2; exit 1 ;;
  esac
  printf '%s' "$key" | set_value tailscale-auth-key
  echo "set tailscale-auth-key"
}

do_check() {
  local left
  left=$(placeholders)
  if [ -n "$left" ]; then
    echo "still placeholders:"
    printf '  %s\n' $left
    return 1
  fi
  echo "no placeholders left in ${SECRETS_FILE}"
}

case "${1:-}" in
  generate) do_generate ;;
  tailscale) do_tailscale ;;
  check) do_check ;;
  *)
    sed -n '2,14p' "$0"
    exit 2
    ;;
esac
