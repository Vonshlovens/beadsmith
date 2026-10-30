# Push to main deploys: CI fast-forwards the
# public repo's `deploy` branch after every check, the VM test and the image
# pass, and this host follows it (services.beadsmithAutoUpdate,
# nix/modules/auto-update.nix). No inbound access, deploy key or token.
#
#   sudo beadsmith-auto-update status
#   journalctl -u beadsmith-auto-update
#   sudo systemctl stop beadsmith-auto-update.timer    # before manual work
{ ... }:
{
  services.beadsmithAutoUpdate = {
    enable = true;
    repository = "https://github.com/Vonshlovens/beadsmith";
    branch = "deploy";
    requiredUnits = [
      "beadsmith.service"
      "docker-beads-dolt.service"
      "cloudflared.service"
      "tailscaled.service"
    ];
  };

  # Off until the operator turns it on (docs/operations/host-beads.md, Deploy), once the
  # restored host is healthy and `deploy` carries this host's real secrets:
  #   sudo touch /var/lib/beadsmith-auto-update/enabled
  # (Gating on the restored Dolt data instead started it at the first switch
  # after the restore, before the secrets were on main.)
  systemd.timers.beadsmith-auto-update.unitConfig.ConditionPathExists =
    "/var/lib/beadsmith-auto-update/enabled";
}
