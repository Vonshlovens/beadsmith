#!/usr/bin/env bash
# Fill values in fleet/secrets/beads.yaml without ever printing them. For the
# operator, on a machine with the admin age key (docs/operations/host-beads.md).
#
#   fleet/scripts/fill-secrets.sh generate    Better Auth secret and master key,
#                                       only while they are still placeholders
#   fleet/scripts/fill-secrets.sh tailscale   prompt (hidden) for a new auth key
#   fleet/scripts/fill-secrets.sh sand        prompt (hidden) for the Sand (E2B)
#                                       values still holding placeholders;
#                                       Enter skips one (docs/sand-e2b.md)
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

# Prompt for one value, hidden, unless it is already set. Empty input skips.
# $3 is a shell pattern the value must match, to catch a paste into the
# wrong prompt.
prompt_value() {
  local key=$1 label=$2 pattern=$3 value
  if ! is_placeholder "$key"; then
    echo "$key already set; left alone"
    return
  fi
  printf '%s (input hidden, Enter to skip): ' "$label" >&2
  IFS= read -rs value
  printf '\n' >&2
  if [ -z "$value" ]; then
    echo "skipped $key"
    return
  fi
  # shellcheck disable=SC2254
  case "$value" in
    $pattern) ;;
    *) echo "that does not look like a $label; $key left alone" >&2; return ;;
  esac
  printf '%s' "$value" | set_value "$key"
  echo "set $key"
}

do_sand() {
  prompt_value beads-web-e2b-api-key "E2B API key (e2b_...)" 'e2b_*'
  prompt_value beads-web-e2b-claude-oauth-token "Claude token from claude setup-token (sk-ant-oat...)" 'sk-ant-oat*'
  prompt_value beads-web-e2b-tailscale-oauth-client-id "Tailscale OAuth client id" '[A-Za-z0-9]*'
  prompt_value beads-web-e2b-tailscale-oauth-secret "Tailscale OAuth client secret (tskey-client-...)" 'tskey-client-*'
  prompt_value beads-web-e2b-github-app-id "GitHub App id (digits)" '[0-9]*'
  if is_placeholder beads-web-e2b-github-app-key; then
    local pem
    printf 'GitHub App private key: path to the downloaded .pem (Enter to skip): ' >&2
    IFS= read -r pem
    pem=${pem/#\~/$HOME}
    if [ -z "$pem" ]; then
      echo "skipped beads-web-e2b-github-app-key"
    elif grep -q 'BEGIN RSA PRIVATE KEY' "$pem" 2>/dev/null; then
      set_value beads-web-e2b-github-app-key <"$pem"
      echo "set beads-web-e2b-github-app-key (you can delete $pem now)"
    else
      echo "$pem is not a GitHub App private key; left alone" >&2
    fi
  else
    echo "beads-web-e2b-github-app-key already set; left alone"
  fi
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
  sand) do_sand ;;
  check) do_check ;;
  *)
    sed -n '2,17p' "$0"
    exit 2
    ;;
esac
