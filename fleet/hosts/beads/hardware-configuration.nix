# Hardware and boot for the KVM VPS.
#
# Survey (Ubuntu, 2026-10-18): QEMU i440fx with SeaBIOS (legacy BIOS boot,
# no UEFI firmware), one 100 GB virtio-scsi disk at /dev/sda with a GPT that
# has a 4 MB "BIOS boot" partition, virtio-net, a cidata (cloud-init) CD-ROM.
#
# CHECK AFTER THE PANEL REINSTALL, BEFORE THE FIRST `switch` (docs/operations/install.md,
# step 2): the provider's NixOS template writes its own
# /etc/nixos/hardware-configuration.nix and boot settings in
# /etc/nixos/configuration.nix. Compare them with this file:
#   - fileSystems."/" (label or UUID) and any /boot or /boot/efi mount;
#   - boot.loader.grub.device (expect /dev/sda) or a systemd-boot/EFI setup;
#   - swapDevices.
# If they differ, copy the template's values here (keep the comments) and
# rebuild before switching. A wrong root device makes the next boot drop to
# the initrd emergency shell; pick the previous generation in GRUB from the
# provider's browser console to recover.
{ modulesPath, ... }:
{
  imports = [ (modulesPath + "/profiles/qemu-guest.nix") ];

  boot.initrd.availableKernelModules = [
    "ata_piix"
    "uhci_hcd"
    "virtio_pci"
    "virtio_scsi"
    "sd_mod"
    "sr_mod"
  ];

  boot.loader.grub = {
    enable = true;
    device = "/dev/sda";
    # GRUB menu on the serial console and the VGA console, so a previous
    # generation can be chosen from the provider's browser console.
    extraConfig = ''
      serial --unit=0 --speed=115200
      terminal_input serial console
      terminal_output serial console
    '';
  };
  boot.kernelParams = [
    "console=ttyS0,115200"
    "console=tty1"
  ];

  # The label NixOS disk images use for the root filesystem. Confirm against
  # the template (see above).
  fileSystems."/" = {
    device = "/dev/disk/by-label/nixos";
    fsType = "ext4";
  };

  swapDevices = [ ];

  # The provider's panel drives the VM through the QEMU guest agent (graceful
  # shutdown, panel actions); the NixOS template enables it too. Checked
  # against the template on 2026-10-30: BIOS, MBR, GRUB on /dev/sda, root
  # by-label nixos ext4, as above.
  services.qemuGuest.enable = true;
}
