#!/usr/bin/env bash
# Write host beads' uplink recovery copy (/var/lib/beads-host/uplink.conf)
# from fleet/secrets/fleet-addresses.yaml. For the OWNER, at install
# (docs/operations/install.md), so the first NixOS boot has an uplink even if
# sops-nix cannot decrypt yet. The addresses go from sops straight through
# the same renderer the host runs (uplink.py) into ssh; nothing is printed.
#
#   fleet/scripts/uplink-recovery.sh root@<BEADS_PUBLIC_IPV4>
#   fleet/scripts/uplink-recovery.sh --print-ip    # BEADS_PUBLIC_IPV4 only
set -euo pipefail

cd "$(dirname "$0")/../.."
FILE=fleet/secrets/fleet-addresses.yaml

sops_cmd() {
  if command -v sops >/dev/null 2>&1; then
    SOPS_AGE_KEY_FILE=${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt} sops "$@"
  else
    BEADS_MOUNT_KEYS=1 fleet/scripts/nix-docker.sh nix --quiet shell nixpkgs/nixos-26.05#sops -c sops "$@"
  fi
}

case "${1:-}" in
  --print-ip)
    sops_cmd decrypt --extract '["BEADS_PUBLIC_IPV4"]' "$FILE"
    echo
    ;;
  *@*)
    sops_cmd decrypt --output-type dotenv "$FILE" \
      | python3 -I fleet/hosts/beads/files/uplink/uplink.py render /dev/stdin \
      | ssh "$1" 'install -d -m 0700 /var/lib/beads-host && umask 077 && cat > /var/lib/beads-host/uplink.conf && wc -l /var/lib/beads-host/uplink.conf'
    ;;
  *)
    sed -n '2,10p' "$0"
    exit 2
    ;;
esac
