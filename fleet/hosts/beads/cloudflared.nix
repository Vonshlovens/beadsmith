# Cloudflare Tunnel connector for Beadsmith (BEADS_PUBLIC_HOST), token-based like
# the systemd unit the host ran under Ubuntu. The
# tunnel's public hostname -> http://127.0.0.1:4321 route and the Access
# application live in the Cloudflare dashboard, not here.
#
# The token reaches the process only as a LoadCredential file, never argv or
# environment. (services.cloudflared in nixpkgs wants a credentials JSON per
# tunnel ID, so this is a plain unit instead.)
{ config, pkgs, ... }:
{
  systemd.services.cloudflared = {
    description = "cloudflared connector for Beadsmith";
    wants = [ "network-online.target" ];
    after = [
      "network-online.target"
      "beadsmith.service"
    ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "simple";
      DynamicUser = true;
      LoadCredential = "tunnel-token:${config.sops.secrets.cloudflared-tunnel-token.path}";
      ExecStart = "${pkgs.cloudflared}/bin/cloudflared --no-autoupdate tunnel run --token-file %d/tunnel-token";
      Restart = "on-failure";
      RestartSec = "5s";
      StateDirectory = "cloudflared";
      StateDirectoryMode = "0750";
      Environment = "HOME=/var/lib/cloudflared";
      UMask = "0077";

      NoNewPrivileges = true;
      PrivateTmp = true;
      PrivateDevices = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      ProtectControlGroups = true;
      ProtectKernelTunables = true;
      ProtectKernelModules = true;
      ProtectKernelLogs = true;
      ProtectClock = true;
      ProtectHostname = true;
      LockPersonality = true;
      RestrictSUIDSGID = true;
      CapabilityBoundingSet = "";
      AmbientCapabilities = "";
      RestrictAddressFamilies = [
        "AF_UNIX"
        "AF_INET"
        "AF_INET6"
        "AF_NETLINK"
      ];
    };
  };
}
