# Beadsmith on host beads: services.beadsmith (nix/modules/beadsmith.nix) on
# loopback 127.0.0.1:4321. cloudflared is the only ingress. The host runs the
# `app` built from the same commit as this file, not a registry image.
{ config, lib, pkgs, ... }:
let
  s = config.sops.secrets;
  accessEnv = config.sops.templates."beads-web-access.env".path;
in
{
  services.beadsmith = {
    enable = true;
    # Fixed ids, so restored state keeps its owner. Not Ubuntu's uid 999:
    # NixOS had already given that to nscd here. 901 is
    # outside nixpkgs' fixed ids and far below where NixOS allocates system
    # users (counting down from 999); the group keeps Ubuntu's 986.
    uid = 901;
    gid = 986;
    credentials = {
      dolt-password = s.beads-web-dolt-password.path;
      better-auth-secret = s.beads-web-better-auth-secret.path;
      master-key = s.beads-web-master-key.path;
    };
    environment = {
      BEADS_DOLT_SERVER_HOST = "127.0.0.1";
      BEADS_DOLT_SERVER_PORT = "3306";
      BEADS_DOLT_SERVER_USER = "beads_web_reader";
      # No agent dispatch provider on this host yet (docs/file-tackle-dispatch.md).
      BDX_DISPATCH_PROVIDER = "none";
    };
    # BDX_ALLOWED_HOSTS, BDX_PUBLIC_ORIGIN (from BEADS_PUBLIC_HOST, kept out
    # of this public repository) and BDX_CF_ACCESS_ISSUER / _AUDIENCE /
    # _ALLOWED_EMAILS, rendered by sops-nix (secrets.nix).
    environmentFiles = [ accessEnv ];
  };

  systemd.services.beadsmith = {
    after = [ "docker-beads-dolt.service" ];
    wants = [ "docker-beads-dolt.service" ];
    # A placeholder Better Auth secret is long enough to be accepted, and a
    # known one would let anyone forge sessions. Refuse to start instead.
    # Runs as root (+), before systemd hands the files to the service user.
    serviceConfig.ExecStartPre = lib.mkBefore [
      "+${pkgs.writeShellScript "beadsmith-require-secrets" ''
        for f in ${
          lib.concatStringsSep " " (lib.attrValues config.services.beadsmith.credentials ++ [ accessEnv ])
        }; do
          if [ ! -r "$f" ]; then
            echo "$f is missing; did sops-nix decrypt fleet/secrets/beads.yaml?" >&2
            exit 1
          fi
          if ${pkgs.gnugrep}/bin/grep -q 'PLACEHOLDER' "$f"; then
            echo "$f still holds a placeholder; fill fleet/secrets/beads.yaml (docs/operations/host-beads.md)" >&2
            exit 1
          fi
        done
      ''}"
    ];
  };
}
