# Tailscale. The node must come up as `beads` with tag:beads-sql, like the
# old one: clients dial the MagicDNS name `beads`, and the tailnet policy
# grants 3306 to that tag. Delete the old `beads` machine in the admin
# console BEFORE this node logs in, or it becomes `beads-1` (docs/operations/install.md).
#
# Tailscale SSH is off: sshd with beads-admin's key is the one SSH path
# (the old node had it on; `--ssh` in extraSetFlags turns it back on).
{ config, ... }:
{
  services.tailscale = {
    enable = true;
    port = 41641;
    openFirewall = false; # networking.nix opens 41641/udp explicitly
    authKeyFile = config.sops.secrets.tailscale-auth-key.path;
    extraUpFlags = [
      "--hostname=beads"
      "--advertise-tags=tag:beads-sql"
      "--ssh=false"
    ];
    # Applied on every boot, also after the first login.
    extraSetFlags = [
      "--hostname=beads"
      "--ssh=false"
    ];
  };
}
