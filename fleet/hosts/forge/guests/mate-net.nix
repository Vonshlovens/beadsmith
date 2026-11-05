# The `mate` guest's fixed facts, shared by the host modules that deal with
# it (../microvms.nix, ../model-proxy.nix, ../mate-runner.nix) and passed to
# the guest itself (./mate.nix). Everything here is public: addresses on a
# host-only link, and public keys.
{
  # Guest taps are named vm-<guest>; see tapPrefix in ../microvms.nix.
  tap = "vm-mate";
  # Locally administered, unicast.
  mac = "02:00:00:00:00:01";
  # The guest's /30 in the 10.100.0.0/24 guest pool.
  hostAddress = "10.100.0.1";
  guestAddress = "10.100.0.2";
  prefixLength = 30;

  # The host's model proxy for this guest (../model-proxy.nix): the only
  # host port the guest may open.
  modelProxyPort = 8443;

  # Public half of /var/lib/microvm-keys/mate_ed25519 on forge: root in the
  # guest, for `sudo mate-ssh`.
  controlKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB/zT5gwEHkOSaLALyOE2y76kEZwM2W2+gxTV5GL+Hhv forge-microvm-control-mate";
  # Public half of /var/lib/mate-runner/ssh/agent_ed25519 on forge: the
  # unprivileged `agent` user, for the First Mate runner.
  runnerKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPvBipoO/Jl56KPoyxqsOpG7xauWEOvslAWgHm+gUcbI forge-mate-runner";
  # The guest's SSH host key, which lives on its volume. Both host-side
  # clients pin it. Resetting the volume makes a new one: copy it from
  # `ssh-keyscan -t ed25519 10.100.0.2` on forge.
  hostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGVAYaPbymNC+5iLF/4Ymk/PFxpht82IB4gJ+ibIcOn9";
}
