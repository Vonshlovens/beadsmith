# Secrets, decrypted by sops-nix at activation into /run/secrets (tmpfs).
#
# secrets/beads.yaml is encrypted to two age keys (see .sops.yaml): the
# owner's admin key and this host's key. The host key is generated ahead of
# time and placed at /var/lib/sops-nix/key.txt during the reinstall
# (docs/operations/install.md), so the first activation can already decrypt.
#
# The first group keeps the names the host's earlier Ubuntu install used in
# /etc/credstore; the rest arrived with NixOS.
{ config, ... }:
let
  root = { };
  # Root-owned: systemd hands them to Beadsmith as credentials
  # (services.beadsmith.credentials), so the service user never reads
  # /run/secrets directly.
  beadsWeb = {
    restartUnits = [ "beadsmith.service" ];
  };
in
{
  sops = {
    defaultSopsFile = ../../secrets/beads.yaml;
    age = {
      keyFile = "/var/lib/sops-nix/key.txt";
      # Only the pre-generated key; never derive one from the SSH host key.
      sshKeyPaths = [ ];
      generateKey = false;
    };
    gnupg.sshKeyPaths = [ ];

    secrets = {
      # --- /etc/credstore, 1:1 ---------------------------------------------
      # Dolt root@localhost password, read by the Dolt entrypoint.
      beads-dolt-root-password = root // {
        restartUnits = [ "docker-beads-dolt.service" ];
      };
      # Beadsmith's SELECT-only SQL user (beads_web_reader).
      beads-web-dolt-password = beadsWeb;
      # Cloudflare tunnel connector token.
      cloudflared-tunnel-token = root // {
        restartUnits = [ "cloudflared.service" ];
      };
      # restic: SQL checkpoint user, B2 application key, repo password.
      beads-dolt-backup-sql-password = root;
      beads-dolt-backup-b2-key-id = root;
      beads-dolt-backup-b2-app-key = root;
      beads-dolt-backup-restic-password = root;
      # Not secret, but identifying: kept out of the public tree.
      beads-dolt-backup-restic-repository = root // {
        sopsFile = ../../secrets/beads-backup.yaml;
      };
      beads-dolt-backup-databases = root // {
        sopsFile = ../../secrets/beads-backup.yaml;
      };
      # Not used by any service on this host; kept so /run/secrets mirrors
      # the old credstore and the values live in one encrypted place.
      beads-bd-writer-password = root;
      beads-dolt-agent-password = root;

      # --- new with NixOS ---------------------------------------------------
      # Tailscale auth key (reusable: no; tags: tag:beads-sql). Only used
      # on first login; later boots reuse /var/lib/tailscale.
      tailscale-auth-key = root;
      # BETTER_AUTH_SECRET_FILE: 32+ random characters.
      beads-web-better-auth-secret = beadsWeb;
      # BDX_SECRET_KEY_FILE: 32 bytes as base64 or hex.
      beads-web-master-key = beadsWeb;
      # Cloudflare Access settings, today in /etc/beads-web/beads-web.env.
      # Not secrets as such, but the owner supplies them (docs/operations/host-beads.md).
      beads-web-cf-access-issuer = root;
      beads-web-cf-access-audience = root;
      beads-web-cf-access-allowed-emails = root;
      # The public hostname behind the tunnel, kept out of this public repo.
      BEADS_PUBLIC_HOST = root // {
        sopsFile = ../../secrets/fleet-addresses.yaml;
      };
    };

    templates."beads-web-access.env" = {
      content = ''
        BDX_ALLOWED_HOSTS=${config.sops.placeholder.BEADS_PUBLIC_HOST}
        BDX_PUBLIC_ORIGIN=https://${config.sops.placeholder.BEADS_PUBLIC_HOST}
        BDX_CF_ACCESS_ISSUER=${config.sops.placeholder.beads-web-cf-access-issuer}
        BDX_CF_ACCESS_AUDIENCE=${config.sops.placeholder.beads-web-cf-access-audience}
        BDX_CF_ACCESS_ALLOWED_EMAILS=${config.sops.placeholder.beads-web-cf-access-allowed-emails}
      '';
      restartUnits = [ "beadsmith.service" ];
    };

    templates."beads-dolt-backup.env".content = ''
      DOLT_DATABASES=${config.sops.placeholder.beads-dolt-backup-databases}
    '';

    # restic reads the B2 application key from the environment.
    templates."restic-b2.env".content = ''
      AWS_ACCESS_KEY_ID=${config.sops.placeholder.beads-dolt-backup-b2-key-id}
      AWS_SECRET_ACCESS_KEY=${config.sops.placeholder.beads-dolt-backup-b2-app-key}
    '';
  };
}
