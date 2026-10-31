# Public network and firewall.
#
# This repository is public, so the VPS's addresses are not written here
# (ghuntley/overalls ADR-0233). They live only in
# fleet/secrets/fleet-addresses.yaml, encrypted to the owner and this host:
# BEADS_PUBLIC_IPV4, _IPV4_PREFIX, _IPV4_GATEWAY and the same for IPV6.
# The provider hands the VPS those static values through cloud-init; an OS
# reinstall keeps them.
#
# beads-uplink validates them and writes a systemd-networkd drop-in under
# /run, plus a root-only recovery copy in /var/lib/beads-host/uplink.conf.
# When the document cannot be read it applies the recovery copy, so a SOPS
# failure does not strand the host. The runbook writes the first copy at
# install (fleet/scripts/uplink-recovery.sh). Docs name addresses by secret.
{ config, lib, pkgs, ... }:
let
  cfg = config.beads.uplink;
  keys = [
    "BEADS_PUBLIC_IPV4"
    "BEADS_PUBLIC_IPV4_PREFIX"
    "BEADS_PUBLIC_IPV4_GATEWAY"
    "BEADS_PUBLIC_IPV6"
    "BEADS_PUBLIC_IPV6_PREFIX"
    "BEADS_PUBLIC_IPV6_GATEWAY"
  ];
  envFile = config.sops.templates."fleet-addresses.env".path;
  dropin = "/run/systemd/network/10-wan.network.d/50-addresses.conf";
  recovery = "/var/lib/beads-host/uplink.conf";
in
{
  options.beads.uplink.enable = lib.mkOption {
    type = lib.types.bool;
    default = true;
    description = "Configure eth0 from fleet/secrets/fleet-addresses.yaml.";
  };

  config = lib.mkMerge [
    {
      networking.useDHCP = false;
      networking.useNetworkd = true;
      # One NIC; keep the name eth0 like the template and the old host.
      networking.usePredictableInterfaceNames = false;

      systemd.network.networks."10-wan" = {
        matchConfig.Name = "eth0";
        # Public resolvers; the provider's own is left out on purpose.
        dns = [
          "1.1.1.1"
          "8.8.4.4"
        ];
        networkConfig.IPv6AcceptRA = false;
        linkConfig.RequiredForOnline = "routable";
      };

      services.resolved.enable = true;

      networking.firewall = {
        enable = true;
        # Tailscale WireGuard, the only public port (same as ufw today).
        allowedUDPPorts = [ 41641 ];
        allowedTCPPorts = [ ];
        # SSH and Dolt SQL only over the tailnet.
        interfaces.tailscale0.allowedTCPPorts = [
          22
          3306
        ];
        # Dolt uses host networking (dolt.nix), so these INPUT rules guard
        # 3306. Also drop anything that arrives on the public NIC addressed to
        # the tailnet ranges, so only tailscale0 can carry tailnet traffic.
        extraCommands = ''
          iptables -t raw -D PREROUTING -i eth0 -d 100.64.0.0/10 -j DROP 2>/dev/null || true
          iptables -t raw -A PREROUTING -i eth0 -d 100.64.0.0/10 -j DROP
          ip6tables -t raw -D PREROUTING -i eth0 -d fd7a:115c:a1e0::/48 -j DROP 2>/dev/null || true
          ip6tables -t raw -A PREROUTING -i eth0 -d fd7a:115c:a1e0::/48 -j DROP
        '';
        extraStopCommands = ''
          iptables -t raw -D PREROUTING -i eth0 -d 100.64.0.0/10 -j DROP 2>/dev/null || true
          ip6tables -t raw -D PREROUTING -i eth0 -d fd7a:115c:a1e0::/48 -j DROP 2>/dev/null || true
        '';
      };
    }

    (lib.mkIf cfg.enable {
      sops.secrets = lib.genAttrs keys (_: {
        sopsFile = ../../secrets/fleet-addresses.yaml;
        restartUnits = [ "beads-uplink.service" ];
      });
      sops.templates."fleet-addresses.env" = {
        content = lib.concatMapStrings (k: "${k}=${config.sops.placeholder.${k}}\n") keys;
        restartUnits = [ "beads-uplink.service" ];
      };

      systemd.services.beads-uplink = {
        description = "Public uplink addresses from fleet-addresses.yaml";
        wantedBy = [ "multi-user.target" ];
        before = [ "network-online.target" ];
        after = [ "systemd-networkd.service" ];
        wants = [ "systemd-networkd.service" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          UMask = "0077";
        };
        script = ''
          ${pkgs.python3}/bin/python3 -I ${./files/uplink/uplink.py} apply \
            ${envFile} ${dropin} ${recovery}
          ${pkgs.systemd}/bin/networkctl reload
          ${pkgs.systemd}/bin/networkctl reconfigure eth0
        '';
      };
    })
  ];
}
