# Nightly restic backup of the Dolt tree to the existing Backblaze B2 repo,
# kept for an overlap with the in-app backups. After a week of green in-app
# runs, remove it from configuration.nix, its secrets from secrets.nix and
# fleet/secrets/, then the B2 bucket and keys.
#
# Same repository, schedule and retention as the Ubuntu timer and
# /opt/beads-dolt-backup/bin/beads-dolt-backup.sh. Snapshots from this host
# carry host "beads" instead of the old Ubuntu hostname, so `forget
# --group-by host,paths` keeps the old host's snapshots as their own group.
#
# The repository URL (it names the bucket) and the database list are in
# fleet/secrets/beads-backup.yaml, not here: this repository is public.
#
# Not ported: the weekly restore-test timer. Restore-test by hand with
# `restic restore latest --tag beads-dolt` if needed during the overlap.
{ config, pkgs, ... }:
let
  stateDir = "/var/lib/beads-dolt-backup";
  helper = pkgs.writeShellApplication {
    name = "beads-dolt-backup";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.gnused
      pkgs.jq
      pkgs.mariadb # `mysql` client, as on Ubuntu (MariaDB client)
      pkgs.restic
      pkgs.systemd
      pkgs.inetutils # hostname
    ];
    text = builtins.readFile ./files/backup/beads-dolt-backup.sh;
  };
in
{
  services.restic.backups.beads-dolt = {
    repositoryFile = config.sops.secrets.beads-dolt-backup-restic-repository.path;
    passwordFile = config.sops.secrets.beads-dolt-backup-restic-password.path;
    environmentFile = config.sops.templates."restic-b2.env".path;
    # The repo exists. Fail loudly on a wrong URL instead of creating one.
    initialize = false;

    paths = [ "${stateDir}/work/snapshot-current" ];
    extraBackupArgs = [
      "--tag beads-dolt"
      "--compression auto"
    ];
    pruneOpts = [
      "--tag beads-dolt"
      "--group-by host,paths"
      "--keep-daily 14"
      "--keep-weekly 8"
      "--keep-monthly 12"
    ];
    timerConfig = {
      OnCalendar = "*-*-* 03:00:00";
      RandomizedDelaySec = "30min";
      Persistent = true;
    };

    backupPrepareCommand = "${helper}/bin/beads-dolt-backup prepare";
    backupCleanupCommand = "${helper}/bin/beads-dolt-backup cleanup";
  };

  systemd.services.restic-backups-beads-dolt = {
    environment = {
      DOLT_UNIT = "docker-beads-dolt.service";
      DOLT_DATA_ROOT = "/srv/beads-dolt/data";
      DOLT_SERVERCFG_DIR = "/srv/beads-dolt/servercfg.d";
      DOLT_SECUREFILE_PATH = "/srv/beads-dolt/securefile";
      DOLT_ENTRYPOINT_PATH = "/srv/beads-dolt/entrypoint.sh";
      # DOLT_DATABASES comes from beads-dolt-backup.env (secrets.nix): the
      # databases beads_backup can SELECT from. A database in the data dir but
      # without that grant is in every snapshot but not in the checkpoint;
      # listing it first would fail every run.
      DOLT_SQL_HOST = "127.0.0.1";
      DOLT_SQL_PORT = "3306";
      DOLT_SQL_USER = "beads_backup";
      DOLT_SQL_PASSWORD_FILE = config.sops.secrets.beads-dolt-backup-sql-password.path;
      BACKUP_STATE_DIR = stateDir;
      CONTAINER_READY_TIMEOUT = "60";
    };
    unitConfig.OnFailure = [ "beads-dolt-backup-alert@%n.service" ];
    serviceConfig = {
      EnvironmentFile = [ config.sops.templates."beads-dolt-backup.env".path ];
      StateDirectory = "beads-dolt-backup";
      StateDirectoryMode = "0700";
      UMask = "0077";
      TimeoutStartSec = "30m";
    };
  };

  # Same as the Ubuntu alert unit: a greppable critical journal line.
  systemd.services."beads-dolt-backup-alert@" = {
    description = "Alert for failed unit %i";
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.util-linux}/bin/logger -p daemon.crit -t beads-dolt-backup-alert \"ALERT: %i failed. Check: systemctl status %i; journalctl -u %i -n 100.\"";
    };
  };
}
