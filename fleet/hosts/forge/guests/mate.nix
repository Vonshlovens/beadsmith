# Guest `mate`: the Beads sandbox First Mate will talk to
# (specs/decisions/0015-scoped-agent-sandboxes.md). For now it is a minimal
# NixOS under Firecracker with a read-only store, persistent agent volume,
# and host-controlled SSH. Real model and signing credentials stay on the host
# (rule 6 of ADR-0015 and ADR-0016).
#
# `net` and `stateDir` come from ../microvms.nix, which owns the addressing.
{ net, stateDir }:
{ pkgs, lib, ... }:
let
  # Where agent state lives. The only writable disk that survives a restart;
  # the root filesystem is rebuilt from the store disk on every boot.
  stateMount = "/var/lib/agent";
  home = "${stateMount}/home";
  # The chat workdir trusted and onboarded, as the E2B template does for its
  # own directories (claudeFirstRunFiles in src/lib/server/e2b/image.ts).
  claudeState = {
    hasCompletedOnboarding = true;
    theme = "dark";
    projects."${home}/work" = {
      hasTrustDialogAccepted = true;
      hasCompletedProjectOnboarding = true;
    };
  };
in
{
  microvm = {
    hypervisor = "firecracker";
    vcpu = 2;
    mem = 4096;
    # No shares under Firecracker, so the guest's closure is an erofs image
    # (microvm.storeDiskType's default) the host builds with the runner.
    interfaces = [
      {
        type = "tap";
        id = net.tap;
        inherit (net) mac;
      }
    ];
    volumes = [
      {
        # Created sparse (truncate, then mkfs) on first start.
        image = "${stateDir}/agent.img";
        label = "agent";
        mountPoint = stateMount;
        fsType = "ext4";
        size = 20 * 1024; # MiB
      }
    ];
  };

  # The host stops a guest with Firecracker's SendCtrlAltDel, which the guest
  # only sees through its i8042 keyboard controller. Firecracker declares
  # that controller in ACPI (PNP0303), but microvm.nix boots it with
  # `i8042.nopnp`, so the driver probes the legacy IRQ, fails, and a stop
  # kills the guest without a shutdown (losing unsynced writes on the
  # volume). The later parameter wins.
  boot.kernelParams = [ "i8042.nopnp=0" ];

  # Show the initrd's activation output on the console, so a failed boot is
  # visible in `journalctl -u microvm@mate` on the host.
  boot.initrd.systemd.services.initrd-nixos-activation.serviceConfig = {
    StandardOutput = lib.mkForce "journal+console";
    StandardError = lib.mkForce "journal+console";
  };

  # Static, IPv4 only. The host routes and NATs; see ../microvms.nix.
  networking.enableIPv6 = false;
  networking.useNetworkd = true;
  systemd.network.networks."10-uplink" = {
    matchConfig.MACAddress = net.mac;
    address = [ "${net.guestAddress}/${toString net.prefixLength}" ];
    gateway = [ net.hostAddress ];
    networkConfig.LinkLocalAddressing = "no";
  };
  # Public resolvers until the sandbox has a resolver of its own.
  networking.nameservers = [
    "9.9.9.9"
    "1.1.1.1"
  ];

  # Control channel: root over SSH, by the key forge keeps in
  # /var/lib/microvm-keys (see ../microvms.nix). No password anywhere.
  users.mutableUsers = false;
  users.users.root = {
    hashedPassword = "!";
    openssh.authorizedKeys.keys = [ net.controlKey ];
  };
  users.users.agent = {
    isNormalUser = true;
    linger = true;
    home = "${stateMount}/home";
    createHome = true;
    openssh.authorizedKeys.keys = [ net.runnerKey ];
  };
  systemd.tmpfiles.rules = [
    "d ${stateMount}/home 0700 agent users -"
    "d ${stateMount}/home/work 0700 agent users -"
    "d ${stateMount}/home/.claude 0700 agent users -"
    "d ${stateMount}/home/.config 0700 agent users -"
    "d ${stateMount}/home/.config/herdr-core 0700 agent users -"
    # hc types nothing on its own: these terminals have no hc parent, and
    # nothing but the runner should type into the agent (ADR-0021 rule 1).
    "L+ ${stateMount}/home/.config/herdr-core/config.toml - - - - /etc/agent-hc.toml"
    "L+ ${stateMount}/home/work/AGENTS.md - - - - /etc/agent-instructions"
    "L+ ${stateMount}/home/work/CLAUDE.md - - - - /etc/agent-instructions"
  ];
  environment.etc."agent-hc.toml".text = "notes = false\n";
  environment.etc.agent-instructions.text = "You are First Mate, a Beads assistant. This sandbox currently has model access only. Do not claim Beads or repository access. Ask the operator when a requested action needs unavailable access. Never seek credentials or bypass network boundaries.\n";
  services.openssh = {
    enable = true;
    settings = {
      PermitRootLogin = "prohibit-password";
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      X11Forwarding = false;
      AllowTcpForwarding = false;
      AllowAgentForwarding = false;
      PermitTunnel = false;
      ClientAliveInterval = 15;
      ClientAliveCountMax = 2;
    };
    # The host key lives on the volume, so it stays the same across restarts
    # and the host can pin it.
    hostKeys = [
      {
        type = "ed25519";
        path = "${stateMount}/ssh/ssh_host_ed25519_key";
      }
    ];
  };
  systemd.services.sshd-keygen.unitConfig.RequiresMountsFor = [ stateMount ];
  systemd.services.sshd.unitConfig.RequiresMountsFor = [ stateMount ];

  environment.systemPackages = with pkgs; [
    curl
    git
    ripgrep
    beadsmith-nodejs
    beadsmith-hc
    # What a chat's hc terminal runs (MATE_AGENT_CLAUDE in ../runtime.nix):
    # Claude Code with the model gateway and a placeholder token, the real
    # credential added on the host (ADR-0015 rule 6).
    (writeShellScriptBin "mate-claude" ''
      export HOME=${home}
      export ANTHROPIC_BASE_URL=http://${net.hostAddress}:${toString net.modelProxyPort}
      export CLAUDE_CODE_OAUTH_TOKEN=guest-placeholder
      export DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1
      export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1
      unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
      exec ${claude-code}/bin/claude "$@"
    '')
  ];

  # The agent's terminal server (ADR-0021 rule 1): one hc core as `agent`,
  # on hc's default Unix socket under its 0700 runtime directory, never a
  # port. A user service (lingering, so it starts at boot) rather than the
  # core `hc connect` would start inside the runner's SSH session: that one
  # would die with the session, and with it every chat's CLI. Over SSH the
  # runner's `hc connect` finds this core through the same runtime
  # directory.
  #
  # Every terminal's program, and whatever it starts, lives in this
  # service's cgroup. `hc kill` (chat delete, eviction, runner shutdown)
  # ends the CLI and everything in its session, escalating past programs
  # that ignore SIGTERM; a descendant that detaches into a session of its
  # own outlives the chat until the core stops, when KillMode=control-group
  # ends it. Programs inherit this environment, so PATH is the system's.
  systemd.user.services.hc-core = {
    description = "hc terminal server for the First Mate agent";
    wantedBy = [ "default.target" ];
    unitConfig.ConditionUser = "agent";
    path = [ "/run/current-system/sw" ];
    serviceConfig = {
      # `hc server start` returns once the core is up and leaves it running,
      # as the E2B sandbox uses it (sandbox/e2b/beadsmith-run).
      Type = "oneshot";
      RemainAfterExit = true;
      WorkingDirectory = "${home}/work";
      ExecStart = "${pkgs.beadsmith-hc}/bin/hc server start --json";
      ExecStop = "${pkgs.beadsmith-hc}/bin/hc server stop --json";
      KillMode = "control-group";
      TimeoutStopSec = "10s";
      SendSIGKILL = true;
    };
  };

  # Claude Code's first-run dialogs (onboarding, folder trust for the chat
  # workdir, the bypass-permissions warning) answered before any launch:
  # the runner fails a launch that is `blocked` before its first turn rather
  # than pressing keys (ADR-0021 rule 2). Merged into the files on the
  # volume, which Claude Code keeps writing, so its own state survives.
  systemd.services.agent-claude-first-run = {
    description = "Pre-accept Claude Code's first-run dialogs for the agent";
    wantedBy = [ "multi-user.target" ];
    after = [ "systemd-tmpfiles-setup.service" ];
    unitConfig.RequiresMountsFor = [ stateMount ];
    serviceConfig = {
      Type = "oneshot";
      User = "agent";
      Group = "users";
      UMask = "0077";
    };
    script = ''
      merge() {
        file=$1 patch=$2
        [ -s "$file" ] || echo '{}' >"$file"
        ${pkgs.jq}/bin/jq --argjson patch "$patch" '. * $patch' "$file" >"$file.new"
        mv "$file.new" "$file"
      }
      merge ${home}/.claude.json ${lib.escapeShellArg (builtins.toJSON claudeState)}
      merge ${home}/.claude/settings.json ${lib.escapeShellArg (builtins.toJSON { skipDangerousModePermissionPrompt = true; })}
    '';
  };

  # The store disk is read-only; nothing in the guest builds or installs.
  nix.enable = false;

  system.stateVersion = "26.05";
}
