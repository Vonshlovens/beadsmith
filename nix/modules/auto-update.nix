# services.beadsmithAutoUpdate: push-to-deploy for a NixOS host built from this
# flake, after ghuntley/overalls' auto-update module (ADR-0036). The host polls
# one branch of the public repository, builds exactly that revision, switches,
# verifies health and rolls back on failure (nix/auto-update/).
#
# CI fast-forwards the branch (default `deploy`) only after main is green, so
# the host never needs inbound access, a deploy key or a GitHub token, and an
# agent ships by getting a PR merged.
{ config, lib, pkgs, ... }:
let
  inherit (lib) mkOption mkEnableOption mkIf types;
  cfg = config.services.beadsmithAutoUpdate;
  updater = pkgs.writeShellApplication {
    name = "beadsmith-auto-update";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.curl
      pkgs.git
      pkgs.jq
      pkgs.util-linux # flock
      config.nix.package
      config.systemd.package
    ];
    text = builtins.readFile ../auto-update/beadsmith-auto-update.sh;
  };
in
{
  options.services.beadsmithAutoUpdate = {
    enable = mkEnableOption "automatic NixOS updates from a branch CI advances";
    repository = mkOption {
      type = types.str;
      example = "https://github.com/Vonshlovens/beadsmith";
      description = "Public git URL of the flake. No credentials in it.";
    };
    branch = mkOption {
      type = types.str;
      default = "deploy";
      description = "Branch CI moves to a revision only after it passed.";
    };
    flakeAttr = mkOption {
      type = types.str;
      default = config.networking.hostName;
      defaultText = lib.literalExpression "config.networking.hostName";
      description = "nixosConfigurations.<name> to build.";
    };
    interval = mkOption {
      type = types.str;
      default = "10s";
      description = "Poll interval (systemd time span); up to 2 s of jitter is added.";
    };
    healthUrl = mkOption {
      type = types.str;
      default = "http://127.0.0.1:${toString config.services.beadsmith.port}/healthz";
      defaultText = lib.literalExpression ''"http://127.0.0.1:''${services.beadsmith.port}/healthz"'';
      description = "Must answer 204 after a switch.";
    };
    requiredUnits = mkOption {
      type = types.listOf types.str;
      default = [ "beadsmith.service" ];
      description = "Units that must be active after a switch.";
    };
    healthTimeout = mkOption {
      type = types.int;
      default = 120;
      description = "Seconds to reach two healthy observations after a switch.";
    };
  };

  config = mkIf cfg.enable {
    environment.systemPackages = [ updater ];

    systemd.services.beadsmith-auto-update = {
      description = "Deploy the newest passed revision of ${cfg.repository}";
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      # Survive its own switch, like nixos-upgrade.service.
      restartIfChanged = false;
      unitConfig.X-StopOnRemoval = false;
      environment = {
        REPOSITORY = cfg.repository;
        BRANCH = cfg.branch;
        FLAKE_ATTR = cfg.flakeAttr;
        HEALTH_URL = cfg.healthUrl;
        HEALTH_TIMEOUT = toString cfg.healthTimeout;
        HEALTH_INTERVAL = "5";
        REQUIRED_UNITS = lib.concatStringsSep " " cfg.requiredUnits;
        STATE_DIR = "/var/lib/beadsmith-auto-update";
        HOME = "/var/lib/beadsmith-auto-update";
      };
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${updater}/bin/beadsmith-auto-update run";
        StateDirectory = "beadsmith-auto-update";
        StateDirectoryMode = "0700";
        # A build can take a while on a small host; a switch must not be cut off.
        TimeoutStartSec = "2h";
      };
    };

    systemd.timers.beadsmith-auto-update = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "1min";
        OnUnitInactiveSec = cfg.interval;
        RandomizedDelaySec = "2s";
      };
    };
  };
}
