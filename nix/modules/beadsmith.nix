# services.beadsmith: the flake's own `app` package run by systemd, the way
# ghuntley/overalls runs its services (a `{ packages }:` module per service,
# imported by the host). No registry, no image digest: the host runs whatever
# commit of this repo it was built from (system.configurationRevision).
#
# Secrets reach the process only as systemd credentials: root-owned files
# (from sops-nix) that systemd copies into /run/credentials/beadsmith.service
# for the service user, pointed at by the app's *_FILE settings
# (docs/configuration.md).
{ packages, overlay }:
{ config, lib, pkgs, ... }:
let
  inherit (lib) mkOption mkEnableOption mkIf types;
  cfg = config.services.beadsmith;
  # nix/overlay.nix applied to this host's pkgs, without touching
  # nixpkgs.overlays (read-only in VM tests and for hosts that pass pkgs).
  toolchain = lib.fix (self: overlay (pkgs // self) pkgs);
  credentialDir = "/run/credentials/beadsmith.service";
  # BEADS_DOLT_PASSWORD_FILE etc., by credential name.
  credentialEnv = {
    dolt-password = "BEADS_DOLT_PASSWORD_FILE";
    better-auth-secret = "BETTER_AUTH_SECRET_FILE";
    master-key = "BDX_SECRET_KEY_FILE";
  };
in
{
  options.services.beadsmith = {
    enable = mkEnableOption "Beadsmith, the Beads web console";
    package = mkOption {
      type = types.package;
      default = packages.${pkgs.stdenv.hostPlatform.system}.app;
      description = "The flake's app package; its app/ directory holds server.js.";
    };
    nodejs = mkOption {
      type = types.package;
      default = toolchain.beadsmith-nodejs-slim;
      defaultText = lib.literalExpression "beadsmith-nodejs-slim from nix/overlay.nix";
      description = "Node runtime, the same one the OCI image uses (nix/overlay.nix).";
    };
    host = mkOption {
      type = types.str;
      default = "127.0.0.1";
    };
    port = mkOption {
      type = types.port;
      default = 4321;
    };
    stateDirectory = mkOption {
      type = types.str;
      default = "/var/lib/beads-web";
      description = "BDX_STATE_DIR. Created and owned by the service user.";
    };
    user = mkOption {
      type = types.str;
      default = "beads-web";
    };
    uid = mkOption {
      type = types.nullOr types.int;
      default = null;
      description = "Fixed uid, for a state directory restored from another host.";
    };
    gid = mkOption {
      type = types.nullOr types.int;
      default = null;
    };
    environment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      description = "Non-secret settings (BEADS_DOLT_SERVER_HOST, BDX_ALLOWED_HOSTS, ...).";
    };
    environmentFiles = mkOption {
      type = types.listOf types.path;
      default = [ ];
    };
    credentials = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = { dolt-password = "/run/secrets/beads-web-dolt-password"; };
      description = ''
        Secret files by credential name. Known names (${lib.concatStringsSep ", " (lib.attrNames credentialEnv)})
        also set the matching *_FILE variable.
      '';
    };
  };

  config = mkIf cfg.enable {
    # A uid shared with another account shares every file it can touch.
    assertions = [
      {
        assertion =
          cfg.uid == null
          || lib.all (u: u.name == cfg.user || u.uid != cfg.uid) (lib.attrValues config.users.users);
        message = "services.beadsmith.uid ${toString cfg.uid} is already another user's uid";
      }
    ];
    users.groups.${cfg.user} = lib.optionalAttrs (cfg.gid != null) { inherit (cfg) gid; };
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.user;
      home = cfg.stateDirectory;
    } // lib.optionalAttrs (cfg.uid != null) { inherit (cfg) uid; };
    systemd.tmpfiles.rules = [ "d ${cfg.stateDirectory} 0750 ${cfg.user} ${cfg.user} -" ];

    systemd.services.beadsmith = {
      description = "Beadsmith";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      environment = {
        NODE_ENV = "production";
        HOST = cfg.host;
        PORT = toString cfg.port;
        BODY_SIZE_LIMIT = "64K";
        BDX_STATE_DIR = cfg.stateDirectory;
        HOME = cfg.stateDirectory;
      }
      // lib.mapAttrs' (name: _: lib.nameValuePair credentialEnv.${name} "${credentialDir}/${name}")
        (lib.filterAttrs (name: _: credentialEnv ? ${name}) cfg.credentials)
      // cfg.environment;
      serviceConfig = {
        # Users NixOS numbers itself escape the assertion above (on host beads,
        # nscd already held uid 999), so check the live account database first.
        ExecStartPre = [
          "${pkgs.writeShellScript "beadsmith-own-uid" ''
            uid=$(${pkgs.coreutils}/bin/id -u ${cfg.user})
            others=$(${pkgs.getent}/bin/getent passwd | ${pkgs.gawk}/bin/awk -F: -v u="$uid" -v me=${cfg.user} '$3 == u && $1 != me { print $1 }')
            if [ -n "$others" ]; then
              echo "uid $uid of ${cfg.user} is shared with: $others" >&2
              exit 1
            fi
          ''}"
        ];
        Type = "simple";
        User = cfg.user;
        Group = cfg.user;
        WorkingDirectory = "${cfg.package}/app";
        ExecStart = "${cfg.nodejs}/bin/node server.js";
        EnvironmentFile = cfg.environmentFiles;
        LoadCredential = lib.mapAttrsToList (name: path: "${name}:${path}") cfg.credentials;
        Restart = "on-failure";
        RestartSec = "5s";
        UMask = "0077";

        # The image ran --read-only with a /tmp tmpfs; this is the same shape.
        ReadWritePaths = [ cfg.stateDirectory ];
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        NoNewPrivileges = true;
        ProtectControlGroups = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectClock = true;
        ProtectHostname = true;
        LockPersonality = true;
        RestrictSUIDSGID = true;
        RestrictRealtime = true;
        SystemCallArchitectures = "native";
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
        RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
      };
      # Up only once /healthz answers, like the image-smoke job in CI.
      postStart = ''
        for _ in $(seq 1 60); do
          ${pkgs.curl}/bin/curl --fail --silent --show-error http://${cfg.host}:${toString cfg.port}/healthz && exit 0
          sleep 1
        done
        exit 1
      '';
    };
  };
}
