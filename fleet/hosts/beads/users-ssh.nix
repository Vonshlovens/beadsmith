# beads-admin: SSH key only, passwordless sudo. No root login, no
# passwords anywhere. sshd listens on all addresses but the firewall only
# admits port 22 on tailscale0 (networking.nix).
#
# Recovery without SSH: the provider's browser console shows the GRUB menu,
# so an older generation can always be booted. Nobody can log in on the
# console (no passwords), by design; the provider's recovery mode can mount the
# disk if the tailnet is ever unreachable.
{ ... }:
{
  users.mutableUsers = false;
  users.users.root.hashedPassword = "!";

  users.users.beads-admin = {
    isNormalUser = true;
    # Same uid as on Ubuntu, so restored files keep their owner.
    uid = 1000;
    extraGroups = [ "wheel" ];
    openssh.authorizedKeys.keys = [
      # The key the Ubuntu host authorized.
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBEeLyC/iAv3Xys0Ppaeex4HE5xEA9v18jI/TDT+KIAq beads-admin"
      # A second operator key. Tailscale SSH is off here, so these keys are
      # the only way in.
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPs8pL8dtk3nui9BtjQFUh4KiheXddoM5nGImAqwEdMK beads-admin-2"
    ];
  };

  security.sudo = {
    enable = true;
    execWheelOnly = true;
    wheelNeedsPassword = false;
  };

  services.openssh = {
    enable = true;
    openFirewall = false;
    settings = {
      PermitRootLogin = "no";
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      X11Forwarding = false;
      AllowUsers = [ "beads-admin" ];
    };
  };
}
