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
  boot.initrd.systemd.services.initrd-nixos-activation.serviceConfig = {
    StandardOutput = lib.mkForce "journal+console";
    StandardError = lib.mkForce "journal+console";
  };
  boot.kernelParams = [ "i8042.nopnp=0" ];

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
    "L+ ${stateMount}/home/work/AGENTS.md - - - - /etc/agent-instructions"
    "L+ ${stateMount}/home/work/CLAUDE.md - - - - /etc/agent-instructions"
  ];
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
    (writeShellScriptBin "mate-supervise" ''
      export XDG_RUNTIME_DIR=/run/user/$(id -u)
      export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
      exec ${systemd}/bin/systemd-run --user --quiet --pipe --wait --collect \
        --service-type=exec --property=KillMode=control-group \
        --property=TimeoutStopSec=2s --property=SendSIGKILL=yes \
        --working-directory="$PWD" \
        ${beadsmith-nodejs}/bin/node ${./chat-supervisor.mjs} "$@"
    '')
    (writeShellScriptBin "mate-claude" ''
      exec /run/current-system/sw/bin/mate-supervise \
        /run/current-system/sw/bin/mate-claude-inner "$@"
    '')
    (writeShellScriptBin "mate-claude-inner" ''
      export HOME=${stateMount}/home
      export ANTHROPIC_BASE_URL=http://${net.hostAddress}:${toString net.modelProxyPort}
      export CLAUDE_CODE_OAUTH_TOKEN=guest-placeholder
      export DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1
      export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1
      unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
      exec ${claude-code}/bin/claude "$@"
    '')
  ];

  # The store disk is read-only; nothing in the guest builds or installs.
  nix.enable = false;

  system.stateVersion = "26.05";
}
