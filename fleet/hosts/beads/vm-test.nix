# Boot test only: the beads host with throwaway secrets, for
#   nixos-rebuild build-vm --flake .#beads-vm
# or `nix build .#packages.aarch64-linux.beads-vm` on a Mac (README.md).
#
# Differences from the real host, all inside the VM variant:
#   - secrets/vm-test.yaml, encrypted to secrets/vm-test.agekey, which is
#     committed on purpose (dummy values only);
#   - DHCP on eth0 instead of the static public address;
#   - serial console, and a self-test that writes its checks to ttyS0 and to
#     the runner's xchg dir ($TMPDIR/xchg/selftest.txt), then powers off, so
#     a headless run ends by itself.
# Expected in the VM: tailscaled-autoconnect and beadsmith may fail (dummy
# auth key, no Dolt data), docker-beads-dolt is skipped (no restored data).
# The VM boots its kernel directly, so GRUB and fileSystems are not tested.
{ lib, pkgs, ... }:
let
  report = pkgs.writeShellScript "vm-selftest-report" ''
    echo "=== VM-SELFTEST BEGIN ==="
    echo "--- hostname: $(cat /proc/sys/kernel/hostname)"
    echo "--- system state: $(systemctl is-system-running)"
    echo "--- failed units:"; systemctl --failed --no-legend --plain
    for u in sshd.service docker tailscaled tailscaled-autoconnect beads-uplink \
             docker-beads-dolt beadsmith cloudflared \
             restic-backups-beads-dolt.timer; do
      printf -- '--- %-36s active=%s\n' "$u" "$(systemctl is-active "$u")"
    done
    echo "--- docker-beads-dolt condition:"; systemctl show -p ConditionResult docker-beads-dolt
    echo "--- beadsmith last lines:"; journalctl -u beadsmith -n 6 --no-pager -o cat
    echo "--- cloudflared last lines:"; journalctl -u cloudflared -n 3 --no-pager -o cat
    echo "--- sops/activation journal:"; journalctl -b --no-pager -o short-monotonic | grep -iE 'sops|secret|activat' | grep -v vm-selftest | head -40
    echo "--- secret mounts:"; findmnt -rn -o TARGET,FSTYPE | grep -E '^/run/secrets' || echo "no /run/secrets* mount"
    echo "--- /run/secrets:"; ls -l /run/secrets/ | grep -v '^total'
    echo "--- rendered templates:"; ls -l /run/secrets/rendered/
    echo "--- placeholder guard:"; grep -l '^PLACEHOLDER' /run/secrets/* 2>/dev/null || echo "no placeholders"
    echo "--- listeners:"; ss -ltnu
    echo "--- filter INPUT (nixos-fw):"; iptables -S nixos-fw
    echo "--- raw PREROUTING:"; iptables -t raw -S PREROUTING; ip6tables -t raw -S PREROUTING
    echo "--- sshd:"; sshd -T 2>/dev/null | grep -Ei '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|allowusers) '
    echo "--- sudo:"; grep -h 'wheel' /etc/sudoers
    echo "--- root password field: $(getent shadow root | cut -d: -f2)"
    echo "--- beads-web user: $(id beads-web)"
    echo "--- timers:"; systemctl list-timers --no-pager --all | grep -E 'restic|NEXT'
    echo "=== VM-SELFTEST END ==="
  '';
in
{
  virtualisation.vmVariant = {
    virtualisation = {
      memorySize = 2048;
      cores = 2;
      diskSize = 4096;
      graphics = false;
    };

    sops.defaultSopsFile = lib.mkForce ../../secrets/vm-test.yaml;
    # Secrets that live in other files on the real host.
    sops.secrets.beads-dolt-backup-restic-repository.sopsFile = lib.mkForce ../../secrets/vm-test.yaml;
    sops.secrets.beads-dolt-backup-databases.sopsFile = lib.mkForce ../../secrets/vm-test.yaml;
    sops.secrets.BEADS_PUBLIC_HOST.sopsFile = lib.mkForce ../../secrets/vm-test.yaml;
    # DHCP below instead of fleet/secrets/fleet-addresses.yaml.
    beads.uplink.enable = false;
    # A boot test must not deploy anything.
    services.beadsmithAutoUpdate.enable = lib.mkForce false;
    # sops-nix refuses a key file in the store, so put the throwaway key where
    # the real host keeps its key, just before sops-nix decrypts.
    system.activationScripts.vmTestSopsKey = {
      deps = [ "specialfs" ];
      text = ''
        install -D -m 0600 ${../../secrets/vm-test.agekey} /var/lib/sops-nix/key.txt
      '';
    };
    system.activationScripts.setupSecrets.deps = [ "vmTestSopsKey" ];

    systemd.network.networks."10-wan" = lib.mkForce {
      matchConfig.Name = "eth0";
      networkConfig.DHCP = "yes";
    };

    # agetty on ttyS0 would hang up the report's terminal.
    systemd.services."serial-getty@ttyS0".enable = false;

    systemd.services.vm-selftest = {
      description = "Write boot checks to the serial console, then power off";
      wantedBy = [ "multi-user.target" ];
      path = with pkgs; [
        coreutils
        gnugrep
        iproute2
        iptables
        openssh
        systemd
        getent
        util-linux
      ];
      serviceConfig.Type = "simple";
      script = ''
        set +e
        for _ in $(seq 1 180); do
          case "$(systemctl is-system-running)" in running|degraded) break ;; esac
          sleep 5
        done
        ${report} 2>&1 | tee /tmp/xchg/selftest.txt > /dev/ttyS0
        sync
        sleep 2
        systemctl poweroff
      '';
    };
  };
}
