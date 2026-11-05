# Tailscale. The first login is interactive so no auth key has to exist in
# the repository:
#
#   sudo tailscale up --hostname=forge --ssh=false
#
# Later boots reuse /var/lib/tailscale. SSH and the dispatch runner are
# reachable on tailscale0 only; nothing is open on the LAN.
{ config, ... }:
{
  services.tailscale = {
    enable = true;
    port = 41641;
    openFirewall = false;
  };

  networking.firewall = {
    enable = true;
    trustedInterfaces = [ config.services.tailscale.interfaceName ];
    allowedUDPPorts = [ config.services.tailscale.port ];
  };
}
