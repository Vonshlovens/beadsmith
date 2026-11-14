# Guest `mate`: the Beads sandbox First Mate will talk to
# (specs/decisions/0015-scoped-agent-sandboxes.md). For now it is a minimal
# NixOS under Firecracker with a read-only store, persistent agent volume,
# and host-controlled SSH. Real model and signing credentials stay on the host
# (rule 6 of ADR-0015 and ADR-0016).
#
# `net` and `stateDir` come from ../microvms.nix, which owns the addressing.
{ net, stateDir }:
{ config, pkgs, lib, ... }:
let
  # Guest state that survives a restart (the SSH host key); the root
  # filesystem is rebuilt from the store disk on every boot.
  stateMount = "/var/lib/agent";
  # Where chats' homes live: systemd keeps each DynamicUser unit's
  # StateDirectory under /var/lib/private (root:root 0700), so that is a
  # volume of its own.
  privateMount = "/var/lib/private";
  # Each chat's home is <chatHomes>/<instance> (ADR-0023), the path the
  # runner uses too (MATE_AGENT_CHAT_HOMES in ../runtime.nix). systemd
  # keeps it owned by `nobody` on disk and maps it to the chat's user inside
  # the chat's unit, where /var/lib/private holds only that chat's home. No
  # bind or symlink: Claude Code files a transcript under its working
  # directory's real path, which the runner computes.
  chatHomes = "${privateMount}/mate-chats";
  # The runner's only command (its key is forced to it): `connect <session>`
  # starts the chat's unit and speaks hc's protocol to its core as the chat's
  # user; `discard <session>` stops the unit and removes its home.
  mateChat = pkgs.writeShellApplication {
    name = "mate-chat";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.util-linux
      config.systemd.package
    ];
    text = ''
      request=''${SSH_ORIGINAL_COMMAND:-}
      verb=''${request%% *}
      session=''${request#* }
      # The whole argument, one line: a lowercase UUID as Beadsmith makes them.
      if ! [[ $session =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
        echo "mate-chat: expected connect|discard <session id>" >&2
        exit 64
      fi
      instance=$(printf '%s' "$session" | sha256sum | cut -c1-24)
      unit="mate-chat@$instance.service"
      case $verb in
      connect)
        systemctl start "$unit"
        uid=$(id -u "mc-$instance")
        gid=$(id -g "mc-$instance")
        exec setpriv --reuid="$uid" --regid="$gid" --clear-groups \
          --inh-caps=-all --bounding-set=-all --no-new-privs \
          env -i PATH=/run/current-system/sw/bin \
          HOME="/run/mate-chat/$instance" XDG_RUNTIME_DIR="/run/mate-chat/$instance" \
          ${pkgs.beadsmith-hc}/bin/hc connect
        ;;
      discard)
        systemctl stop "$unit"
        # Nothing to clean (a chat that never ran here) is not a failure;
        # a home still there afterwards is.
        systemctl clean --what=state --what=runtime "$unit" 2>/dev/null || true
        if [ -e "${privateMount}/mate-chats/$instance" ]; then
          echo "mate-chat: the chat's home is still there" >&2
          exit 1
        fi
        ;;
      *)
        echo "mate-chat: expected connect|discard <session id>" >&2
        exit 64
        ;;
      esac
    '';
  };
  # Claude Code onboarded, as the E2B template does
  # (claudeFirstRunFiles in src/lib/server/e2b/image.ts); the chat's workdir
  # is trusted by mate-chat-setup, which knows its path.
  claudeState = {
    hasCompletedOnboarding = true;
    theme = "dark";
  };
  claudeProject = {
    hasTrustDialogAccepted = true;
    hasCompletedProjectOnboarding = true;
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
      {
        # Chats' homes (transcripts, working files, configuration).
        image = "${stateDir}/chats.img";
        label = "chats";
        mountPoint = privateMount;
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
  #
  # The First Mate runner's key is also root's, but `restrict`ed to the
  # mate-chat helper below whatever it asks: the runner can start and reach a
  # chat's core, or discard a chat, and nothing else.
  users.mutableUsers = false;
  users.users.root = {
    hashedPassword = "!";
    openssh.authorizedKeys.keys = [
      net.controlKey
      ''restrict,command="${mateChat}/bin/mate-chat" ${net.runnerKey}''
    ];
  };
  systemd.tmpfiles.rules = [
    # systemd's boundary between DynamicUser state and everyone else; the
    # volume's root comes up 0755.
    "d ${privateMount} 0700 root root -"
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
      # HOME is the chat's home, from its unit (mate-chat@ below).
      export ANTHROPIC_BASE_URL=http://${net.hostAddress}:${toString net.modelProxyPort}
      export CLAUDE_CODE_OAUTH_TOKEN=guest-placeholder
      export DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1
      export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1
      unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
      exec ${claude-code}/bin/claude "$@"
    '')
  ];

  # One chat (ADR-0023): its own hc core (ADR-0021 rule 1) and everything
  # that core starts, as a Unix identity of its own. The instance is the
  # first 24 hex digits of the SHA-256 of the chat's CLI session id
  # (mate-chat, below); the user is `mc-<instance>`, allocated by systemd
  # while the unit runs (DynamicUser), and its home is mapped to whatever
  # UID it gets, so a chat resumes after a restart.
  #
  # The chat's home is its StateDirectory, <chatHomes>/<instance>. Inside the
  # unit /var/lib/private shows only that one home; outside it, it is
  # root-only (0700). The guest's state volume (the old shared home, the SSH
  # host key) is hidden behind an empty read-only tmpfs. /proc shows only the chat's own processes, /tmp is its
  # own, and a different UID cannot signal another chat's processes or reach
  # its core's socket in /run/mate-chat/<instance> (0700).
  #
  # Every terminal's program, and whatever it starts, lives in this unit's
  # cgroup: `hc kill` (eviction, runner shutdown) ends a CLI and its
  # session; stopping the unit (mate-chat discard, on delete) ends the rest.
  systemd.services."mate-chat@" = {
    description = "First Mate chat %i: its hc core and agent";
    path = [ "/run/current-system/sw" ];
    unitConfig.RequiresMountsFor = [
      stateMount
      privateMount
    ];
    environment = {
      HOME = "${chatHomes}/%i";
      # Where hc puts its socket; mate-chat connects through the same one.
      XDG_RUNTIME_DIR = "/run/mate-chat/%i";
    };
    serviceConfig = {
      DynamicUser = true;
      User = "mc-%i";
      StateDirectory = "mate-chats/%i";
      StateDirectoryMode = "0700";
      RuntimeDirectory = "mate-chat/%i";
      RuntimeDirectoryMode = "0700";
      TemporaryFileSystem = "${stateMount}:ro";
      UMask = "0077";
      ProtectProc = "invisible";
      ProtectHostname = true;
      ProtectClock = true;
      ProtectKernelTunables = true;
      ProtectKernelModules = true;
      ProtectKernelLogs = true;
      ProtectControlGroups = true;
      PrivateDevices = true;
      LockPersonality = true;
      RestrictRealtime = true;
      CapabilityBoundingSet = "";
      # `hc server start` returns once the core is up and leaves it running,
      # as the E2B sandbox uses it (sandbox/e2b/beadsmith-run).
      Type = "oneshot";
      RemainAfterExit = true;
      WorkingDirectory = "${chatHomes}/%i";
      # Claude Code's first-run dialogs (onboarding, folder trust for the
      # chat workdir, the bypass-permissions warning) answered before any
      # launch: the runner fails a launch that is `blocked` before its first
      # turn rather than pressing keys (ADR-0021 rule 2). Merged into the
      # chat's files, which Claude Code keeps writing, so its own state
      # survives. hc types nothing on its own: these terminals have no hc
      # parent, and nothing but the runner should type into the agent.
      ExecStartPre = pkgs.writeShellScript "mate-chat-setup" ''
        set -eu
        mkdir -p "$HOME/work" "$HOME/.claude" "$HOME/.config/herdr-core"
        ln -sfn /etc/agent-hc.toml "$HOME/.config/herdr-core/config.toml"
        ln -sfn /etc/agent-instructions "$HOME/work/AGENTS.md"
        ln -sfn /etc/agent-instructions "$HOME/work/CLAUDE.md"
        merge() {
          file=$1 patch=$2
          [ -s "$file" ] || echo '{}' >"$file"
          ${pkgs.jq}/bin/jq --argjson patch "$patch" '. * $patch' "$file" >"$file.new"
          mv "$file.new" "$file"
        }
        merge "$HOME/.claude.json" ${lib.escapeShellArg (builtins.toJSON claudeState)}
        merge "$HOME/.claude.json" "$(${pkgs.jq}/bin/jq -n --arg dir "$HOME/work" \
          --argjson project ${lib.escapeShellArg (builtins.toJSON claudeProject)} \
          '{projects: {($dir): $project}}')"
        merge "$HOME/.claude/settings.json" ${lib.escapeShellArg (builtins.toJSON { skipDangerousModePermissionPrompt = true; })}
      '';
      ExecStart = "${pkgs.beadsmith-hc}/bin/hc server start --json";
      ExecStop = "${pkgs.beadsmith-hc}/bin/hc server stop --json";
      KillMode = "control-group";
      TimeoutStopSec = "10s";
      SendSIGKILL = true;
    };
  };

  # The store disk is read-only; nothing in the guest builds or installs.
  nix.enable = false;

  system.stateVersion = "26.05";
}
