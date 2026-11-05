# forge's microVM guests (microvm.nix host module, imported for forge only in
# flake.nix). Each guest is a Firecracker VM with its own tap and a routed
# point-to-point subnet; nothing is bridged, so NetworkManager keeps the
# uplink and the guest never sees the LAN segment. ADR-0015 is the why: a
# sandbox is a VM, sandboxes do not reach each other, and keys stay outside.
#
# Control channel: `sudo mate-ssh [command]` runs a command in `mate` as root
# over its tap, with a key that exists only on forge. Create it once (already
# done on the running machine; the public half is `controlKey` below):
#
#   sudo install -d -m 0700 /var/lib/microvm-keys
#   sudo ssh-keygen -t ed25519 -N "" -C forge-microvm-control-mate \
#     -f /var/lib/microvm-keys/mate_ed25519
#
# Lifecycle: `systemctl {status,restart,stop} microvm@mate`; the console log
# is `journalctl -u microvm@mate`. The guest's writable disk is
# /var/lib/microvms/mate/agent.img; deleting it (with the guest stopped)
# resets the guest's state, SSH host key included.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (config.microvm) stateDir;

  # Guest taps are named vm-<guest>. NetworkManager ignores them and the
  # firewall below matches them by this prefix.
  tapPrefix = "vm-";
  # Every guest subnet is a /30 inside this /24: 10.100.0.4k+1 is the host's
  # side, +2 the guest's. Clear of the usual home LANs (10.0.0.0/24,
  # 192.168.x.0/24) and of the tailnet's 100.64.0.0/10.
  guestPool = "10.100.0.0/24";

  keyDir = "/var/lib/microvm-keys";

  mate = import ./guests/mate-net.nix;

  # Guest traffic is filtered by a table of its own rather than by switching
  # the host firewall to nftables: networking.nftables.enable would replace
  # the iptables firewall and flush the ruleset, Tailscale's chains included,
  # which is how SSH reaches this machine. This table sits beside them (the
  # host's iptables is the nf_tables backend), touches only traffic that
  # enters from a guest tap or is forwarded, and a drop here is final whatever
  # the other tables accept.
  #
  # Forwarding was off before guests existed, so the forward chain drops
  # everything except guest egress and its replies.
  firewall = pkgs.writeText "microvm-guests.nft" ''
    table inet microvm-guests
    delete table inet microvm-guests

    table inet microvm-guests {
      # Where a guest may not go: private, shared (CGNAT, the tailnet),
      # loopback, link-local, multicast and reserved ranges.
      set nonpublic4 {
        type ipv4_addr
        flags interval
        elements = {
          0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,
          169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16,
          198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4
        }
      }

      chain input {
        type filter hook input priority filter - 10; policy accept;
        iifname "${tapPrefix}*" jump guest-to-host
      }

      # The host opens connections to guests (SSH); guests open none to the
      # host, except a ping to their gateway and the scoped model proxy.
      chain guest-to-host {
        ct state established,related accept
        meta nfproto ipv4 icmp type echo-request fib daddr . iif type local accept
        iifname "${mate.tap}" ip saddr ${mate.guestAddress} ip daddr ${mate.hostAddress} tcp dport ${toString mate.modelProxyPort} accept
        counter drop
      }

      chain forward {
        type filter hook forward priority filter - 10; policy drop;
        ct state established,related accept
        iifname "${tapPrefix}*" jump guest-egress
        counter
      }

      # Temporary: the open internet, until the key proxy exists and egress
      # can be narrowed to it.
      chain guest-egress {
        meta nfproto != ipv4 counter drop
        fib saddr . iif oif missing counter drop
        oifname "${tapPrefix}*" counter drop
        ip daddr ${guestPool} counter drop
        ip daddr @nonpublic4 counter drop
        ct state new accept
        counter drop
      }

      chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;
        ip saddr ${guestPool} oifname != "${tapPrefix}*" masquerade
      }
    }
  '';
  nft = "${pkgs.nftables}/bin/nft";

  # A clean stop. microvm.nix's Firecracker shutdown sends Ctrl-Alt-Del and
  # then waits on the API socket with socat, which returns at once, so
  # systemd killed the VM while the guest was still shutting down (its
  # volume not yet unmounted). Wait for Firecracker itself to exit instead:
  # the guest's reboot ends it. systemd's stop timeout (microvm.host.
  # startupTimeout) still applies if the guest never gets there.
  cleanStop =
    name: vm:
    lib.nameValuePair "microvm@${name}" {
      serviceConfig.ExecStop = [
        ""
        (pkgs.writeShellScript "microvm-stop-${name}" ''
          ${pkgs.curl}/bin/curl -sf --unix-socket ${stateDir}/${name}/${vm.config.config.microvm.socket} \
            -X PUT http://localhost/actions \
            -d '{ "action_type": "SendCtrlAltDel" }' || exit 0
          while ${pkgs.coreutils}/bin/kill -0 "$MAINPID" 2>/dev/null; do
            ${pkgs.coreutils}/bin/sleep 0.5
          done
        '')
      ];
    };
in
{
  microvm.vms.mate.config = import ./guests/mate.nix {
    net = mate;
    stateDir = "${stateDir}/mate";
  };

  networking.firewall.interfaces.${mate.tap}.allowedTCPPorts = [ mate.modelProxyPort ];

  networking.networkmanager.unmanaged = [ "interface-name:${tapPrefix}*" ];

  # Guests reach the internet through the host (IPv4 only; IPv6 forwarding
  # stays off).
  boot.kernel.sysctl."net.ipv4.ip_forward" = 1;

  systemd.services = {
    # The tap is created by microvm-tap-interfaces@mate; give it the host's
    # side of the /30 and no IPv6.
    "microvm-tap-interfaces@mate".serviceConfig.ExecStartPost = [
      "${pkgs.procps}/bin/sysctl -q -w net.ipv6.conf.${mate.tap}.disable_ipv6=1"
      "${pkgs.iproute2}/bin/ip addr replace ${mate.hostAddress}/${toString mate.prefixLength} dev ${mate.tap}"
    ];

    # Loaded before any interface comes up, like the host firewall, and
    # required by every guest: a guest does not run without its filter.
    # Reloading replaces the table in one transaction.
    microvm-guest-firewall = {
      description = "nftables filter and NAT for microVM guests";
      wantedBy = [ "sysinit.target" ];
      wants = [ "network-pre.target" ];
      before = [
        "network-pre.target"
        "shutdown.target"
      ];
      after = [ "systemd-modules-load.service" ];
      conflicts = [ "shutdown.target" ];
      requiredBy = map (name: "microvm@${name}.service") (lib.attrNames config.microvm.vms);
      unitConfig.DefaultDependencies = false;
      reloadIfChanged = true;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${nft} -f ${firewall}";
        ExecReload = "${nft} -f ${firewall}";
        ExecStop = "${nft} delete table inet microvm-guests";
      };
    };
  }
  // lib.mapAttrs' cleanStop config.microvm.vms;

  systemd.tmpfiles.rules = [
    "d ${keyDir} 0700 root root -"
    # Garbage-collection roots for each guest's runner (its kernel, initrd,
    # store disk and, through them, its whole closure). `current` is also in
    # the host's own closure, but `booted` (what a running guest started
    # from) is not once the host moves on, so without these the weekly
    # `nix.gc` could delete a running guest's store disk.
    "d /nix/var/nix/gcroots/microvm 0755 root root -"
  ]
  ++ lib.concatMap (name: [
    "L+ /nix/var/nix/gcroots/microvm/${name} - - - - ${stateDir}/${name}/current"
    "L+ /nix/var/nix/gcroots/microvm/booted-${name} - - - - ${stateDir}/${name}/booted"
  ]) (lib.attrNames config.microvm.vms);

  environment.systemPackages = [
    (pkgs.writeShellScriptBin "mate-ssh" ''
      exec ${pkgs.openssh}/bin/ssh \
        -i ${keyDir}/mate_ed25519 -o IdentitiesOnly=yes \
        -o UserKnownHostsFile=${keyDir}/known_hosts \
        -o StrictHostKeyChecking=accept-new \
        -o BatchMode=yes \
        root@${mate.guestAddress} "$@"
    '')
  ];
}
