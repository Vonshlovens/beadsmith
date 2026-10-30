# Host `beads`: KVM VPS (2 vCPU, 8 GB, 100 GB virtio-scsi disk,
# SeaBIOS, i440fx, MBR disk). Moved from Ubuntu to this configuration on
# 2026-10-30 (docs/operations/host-beads.md).
{ ... }:
{
  imports = [
    ./hardware-configuration.nix
    ./networking.nix
    ./users-ssh.nix
    ./secrets.nix
    ./tailscale.nix
    ./dolt.nix
    ./beadsmith.nix
    ./cloudflared.nix
    ./backup-restic.nix
    ./auto-update.nix
  ];

  nixpkgs.hostPlatform = "x86_64-linux";
  networking.hostName = "beads";
  time.timeZone = "Etc/UTC";
  i18n.defaultLocale = "C.UTF-8";

  nix.settings = {
    experimental-features = [
      "nix-command"
      "flakes"
    ];
    # Admins can copy store paths for a hand deploy over Tailscale.
    trusted-users = [
      "root"
      "@wheel"
    ];
    # CI pushes every build to this cache, so the updater downloads the
    # system CI tested instead of compiling it on this small VPS.
    extra-substituters = [ "https://beadsmith.cachix.org" ];
    extra-trusted-public-keys = [
      "beadsmith.cachix.org-1:rTIq8/RTThaXp/fXvP3WhR9lcbENghg+di+8JlKwKXw="
    ];
  };
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 30d";
  };
  boot.loader.grub.configurationLimit = 20;

  # Small VPS, no swap today. zram gives some headroom for nix builds.
  zramSwap.enable = true;

  services.journald.extraConfig = ''
    SystemMaxUse=1G
  '';

  # The template ships cloud-init for the panel's root password and key;
  # this host is fully declared, so it stays off.
  services.cloud-init.enable = false;

  # Keep this at the release the host was first installed with.
  system.stateVersion = "26.05";
}
