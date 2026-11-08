# Beadsmith on host beads: services.beadsmith (nix/modules/beadsmith.nix) on
# loopback 127.0.0.1:4321. cloudflared is the only ingress. The host runs the
# `app` built from the same commit as this file, not a registry image.
{ config, lib, pkgs, ... }:
let
  s = config.sops.secrets;
  accessEnv = config.sops.templates."beads-web-access.env".path;
  e2bEnv = config.sops.templates."beads-web-e2b.env".path;
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
      mate-runner-secret = s.beads-web-mate-runner-secret.path;
      e2b-api-key = s.beads-web-e2b-api-key.path;
      e2b-claude-oauth-token = s.beads-web-e2b-claude-oauth-token.path;
      e2b-dolt-accounts = s.beads-web-e2b-dolt-accounts.path;
      e2b-tailscale-oauth-secret = s.beads-web-e2b-tailscale-oauth-secret.path;
      e2b-github-app-key = s.beads-web-e2b-github-app-key.path;
    };
    environment = {
      BEADS_DOLT_SERVER_HOST = "127.0.0.1";
      BEADS_DOLT_SERVER_PORT = "3306";
      BEADS_DOLT_SERVER_USER = "beads_web_reader";
      # Missions run in E2B sandboxes (docs/sand-e2b.md). First Mate chats
      # go to forge's mate runner by default, or to a sandbox when the chat
      # picks Sand under "Runs on".
      BDX_DISPATCH_PROVIDER = "e2b";
      BDX_MATE_RUNNERS = "remote,e2b";
      # The template sandbox/e2b/build-template.ts builds (its default name).
      BDX_E2B_TEMPLATE = "beadsmith-agent";
    };
    # BDX_ALLOWED_HOSTS, BDX_PUBLIC_ORIGIN (from BEADS_PUBLIC_HOST, kept out
    # of this public repository) and BDX_CF_ACCESS_ISSUER / _AUDIENCE /
    # _ALLOWED_EMAILS and BDX_MATE_RUNNER_URL, rendered by sops-nix (secrets.nix).
    # BDX_E2B_TAILSCALE_OAUTH_CLIENT_ID and BDX_E2B_GITHUB_APP_ID, likewise.
    environmentFiles = [
      accessEnv
      e2bEnv
    ];
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
          lib.concatStringsSep " " (lib.attrValues config.services.beadsmith.credentials ++ [
            accessEnv
            e2bEnv
          ])
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
