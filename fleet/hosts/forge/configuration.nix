# Host `forge`: a laptop (Intel Core i7-7700HQ, 16 GiB, one NVMe, x86_64)
# that Beadsmith dispatch routes agent work to. Built on the machine itself:
#   sudo nixos-rebuild switch --flake .#forge
# ./hardware-configuration.nix is `nixos-generate-config --show-hardware-config`
# from the installed machine.
#
# Nothing in this directory is secret or identifying: the SSH keys are public
# keys, the tailnet login is interactive, and there is no address or token.
# Anything that is (the dispatch webhook secret, the Dolt password) goes in a
# sops file encrypted to a host age key, as fleet/hosts/beads/secrets.nix does.
{ pkgs, ... }:
{
  imports = [
    ./hardware-configuration.nix
    ./users-ssh.nix
    ./tailscale.nix
    ./power.nix
    # ./nvidia.nix is not imported: no NVIDIA device enumerates on PCI (the
    # model normally ships one, so it may be off in the BIOS). Import it
    # once `lspci` shows the GPU, with its real bus ids.
  ];

  # The firmware boots in legacy BIOS mode, so GRUB goes in the disk's MBR
  # (as the installer set it up), not an EFI system partition.
  boot.loader.grub = {
    enable = true;
    device = "/dev/nvme0n1";
  };

  nixpkgs.hostPlatform = "x86_64-linux";
  networking.hostName = "forge";
  # Wi-Fi and Ethernet are both managed here; join a network once with
  # `nmcli`, after which the connection is remembered.
  networking.networkmanager.enable = true;
  time.timeZone = "Etc/UTC";
  i18n.defaultLocale = "C.UTF-8";

  # Firmware blobs for the Wi-Fi chip and the iGPU.
  hardware.enableRedistributableFirmware = true;

  nix.settings = {
    experimental-features = [
      "nix-command"
      "flakes"
    ];
    trusted-users = [
      "root"
      "@wheel"
    ];
    # Same cache CI pushes to for the beads host.
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

  zramSwap.enable = true;

  # git: the repository is cloned here and switched from (see the header).
  # pciutils: `lspci`, to check for the NVIDIA GPU before importing nvidia.nix.
  environment.systemPackages = with pkgs; [
    git
    pciutils
  ];

  # Keep this at the release the machine was first installed with.
  system.stateVersion = "26.05";
}
