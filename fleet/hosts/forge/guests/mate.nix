# Guest `mate`: the Beads sandbox First Mate will talk to
# (specs/decisions/0015-scoped-agent-sandboxes.md). For now it is a minimal
# NixOS under Firecracker: a read-only store disk, one writable volume, a
# routed tap, and SSH from the host. No agent, no credentials: none may ever
# be put in this image, its environment or its volume (rule 6 of ADR-0015).
#
# `net` and `stateDir` come from ../microvms.nix, which owns the addressing.
{ net, stateDir }:
{ pkgs, ... }:
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
  services.openssh = {
    enable = true;
    settings = {
      PermitRootLogin = "prohibit-password";
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      X11Forwarding = false;
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
  ];

  # The store disk is read-only; nothing in the guest builds or installs.
  nix.enable = false;

  system.stateVersion = "26.05";
}
