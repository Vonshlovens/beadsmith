# Run closed on a shelf: closing the lid must not suspend the machine, and
# the OLED panel should not sit on a static console.
{ ... }:
{
  services.logind.settings.Login = {
    HandleLidSwitch = "ignore";
    HandleLidSwitchExternalPower = "ignore";
    HandleLidSwitchDocked = "ignore";
  };

  # Blank the text console after 60 seconds idle (a blanked OLED draws no
  # power and does not burn in). A graphical session handles its own idle.
  boot.kernelParams = [ "consoleblank=60" ];

  # Nothing may suspend or hibernate it, whatever asks (logind, a key, a
  # program). Note that a `nixos-rebuild switch` does not restart
  # systemd-logind, so changed lid settings apply only after a reboot.
  systemd.targets.sleep.enable = false;
  systemd.targets.suspend.enable = false;
  systemd.targets.hibernate.enable = false;
  systemd.targets.hybrid-sleep.enable = false;

  # Intel thermal management; the chassis is thin and the CPU is a laptop part.
  services.thermald.enable = true;

  # Battery charge limit is a BIOS setting on this model (Dell BIOS: Battery
  # Configuration), not something the kernel exposes.
}
