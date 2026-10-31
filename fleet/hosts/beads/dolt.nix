# Dolt sql-server: the same container production ran on Ubuntu
# (/srv/beads-dolt/compose.yaml), now an oci-container.
#
# Layout under /srv/beads-dolt is fixed, so a data tarball
# (docs/operations/backup-and-restore.md) and restic snapshots restore in place:
#   data/                 the Dolt data dir (restored, never generated here)
#   entrypoint.sh         installed from the flake on every start
#   servercfg.d/config.yaml  installed from the flake on every start
#   securefile/           empty; secure_file_priv points here
#
# Host networking: Dolt listens on 0.0.0.0:3306 in the host's namespace, so
# the NixOS firewall decides who reaches it (loopback and tailscale0 only,
# networking.nix). Docker port publishing would DNAT past those INPUT rules
# and need the Tailscale address written here.
#
# Upgrade Dolt separately from the move: change the digest,
# rebuild, and keep the previous generation for rollback.
{ config, lib, pkgs, ... }:
let
  root = "/srv/beads-dolt";
  installConfig = pkgs.writeShellScript "beads-dolt-install-config" ''
    set -eu
    install -d -m 0750 -o root -g root ${root} ${root}/servercfg.d ${root}/securefile
    install -m 0700 -o root -g root ${./files/dolt/entrypoint.sh} ${root}/entrypoint.sh
    install -m 0640 -o root -g root ${./files/dolt/config.yaml} ${root}/servercfg.d/config.yaml
  '';
in
{
  virtualisation.docker = {
    enable = true;
    autoPrune = {
      enable = true;
      dates = "weekly";
    };
  };
  virtualisation.oci-containers.backend = "docker";

  virtualisation.oci-containers.containers.beads-dolt = {
    # dolthub/dolt-sql-server:2.1.8, the exact build production runs.
    image = "dolthub/dolt-sql-server@sha256:96786c6553f8852cb24c18fc2c856a17d1bf3f9232426991eafab4167e7192f6";
    entrypoint = "/usr/local/bin/beads-dolt-entrypoint";
    volumes = [
      "${root}/data:/var/lib/dolt"
      "${root}/servercfg.d:/etc/dolt/servercfg.d:ro"
      "${root}/securefile:/etc/dolt/securefile:ro"
      "${root}/entrypoint.sh:/usr/local/bin/beads-dolt-entrypoint:ro"
      "${config.sops.secrets.beads-dolt-root-password.path}:/run/secrets/dolt-root-password:ro"
    ];
    extraOptions = [
      "--network=host"
      # Compose had stop_grace_period: 60s.
      "--stop-timeout=60"
    ];
  };

  systemd.services.docker-beads-dolt = {
    unitConfig = {
      # Never let Dolt initialise an empty server: start only once the
      # restored data dir (with its SQL users) is in place.
      ConditionPathExists = "${root}/data/.doltcfg/privileges.db";
    };
    serviceConfig = {
      ExecStartPre = lib.mkBefore [ "${installConfig}" ];
      RestartSec = "10s";
    };
  };
}
