# forge-admin: SSH by key only, passwordless sudo. Unlike `beads` the users
# stay mutable, because this machine has a keyboard: set a console password
# once at install with `passwd`. Root never logs in, and sshd refuses
# passwords, so the console password is not reachable over the network.
{ ... }:
{
  users.users.root.hashedPassword = "!";

  users.users.forge-admin = {
    isNormalUser = true;
    extraGroups = [
      "wheel"
      "networkmanager"
    ];
    openssh.authorizedKeys.keys = [
      # The operator keys already authorized on `beads`. Public keys.
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBEeLyC/iAv3Xys0Ppaeex4HE5xEA9v18jI/TDT+KIAq beads-admin"
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
    # Only reachable over the tailnet; see tailscale.nix.
    openFirewall = false;
    settings = {
      PermitRootLogin = "no";
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      X11Forwarding = false;
      AllowUsers = [ "forge-admin" ];
    };
  };
}
