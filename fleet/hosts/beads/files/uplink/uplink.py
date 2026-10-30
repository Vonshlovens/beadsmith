"""Render the public uplink of host beads from fleet/secrets/fleet-addresses.yaml.

The repository is public, so the VPS addresses live only in that SOPS
document (ghuntley/overalls ADR-0233). This script is the one place that
turns them into a systemd-networkd drop-in:

  uplink.py render ENV_FILE                 print the drop-in, or exit 1
  uplink.py apply ENV_FILE DROPIN RECOVERY  write the drop-in under /run and
                                            keep a root-only recovery copy

ENV_FILE holds KEY=value lines (the sops-nix template on the host, or a
decrypted copy on the owner's Mac). `apply` falls back to the recovery copy
when the document is missing or malformed, so a SOPS failure never strands
the host. It never prints an address.
"""

import ipaddress
import os
import sys
import tempfile

KEYS = (
    "BEADS_PUBLIC_IPV4",
    "BEADS_PUBLIC_IPV4_PREFIX",
    "BEADS_PUBLIC_IPV4_GATEWAY",
    "BEADS_PUBLIC_IPV6",
    "BEADS_PUBLIC_IPV6_PREFIX",
    "BEADS_PUBLIC_IPV6_GATEWAY",
)


class Invalid(Exception):
    pass


def read_env(path):
    values = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            key, sep, value = line.partition("=")
            if not sep:
                raise Invalid("a line without '='")
            values[key.strip()] = value.strip()
    missing = [k for k in KEYS if not values.get(k)]
    if missing:
        raise Invalid("missing " + ", ".join(missing))
    return values


def address(value, version, name):
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        raise Invalid(f"{name} is not an address") from None
    if ip.version != version or str(ip) != value:
        raise Invalid(f"{name} is not a canonical IPv{version} address")
    if ip.is_unspecified or ip.is_loopback or ip.is_multicast or ip.is_link_local:
        raise Invalid(f"{name} is not unicast")
    return ip


def interface(values, family):
    version = 4 if family == "IPV4" else 6
    ip = address(values[f"BEADS_PUBLIC_{family}"], version, f"BEADS_PUBLIC_{family}")
    prefix = values[f"BEADS_PUBLIC_{family}_PREFIX"]
    if not prefix.isdigit() or not 8 <= int(prefix) <= (30 if version == 4 else 128):
        raise Invalid(f"BEADS_PUBLIC_{family}_PREFIX is out of range")
    iface = ipaddress.ip_interface(f"{ip}/{prefix}")
    gateway = address(
        values[f"BEADS_PUBLIC_{family}_GATEWAY"], version, f"BEADS_PUBLIC_{family}_GATEWAY"
    )
    if gateway not in iface.network or gateway == ip:
        raise Invalid(f"BEADS_PUBLIC_{family}_GATEWAY is not on the link")
    return iface, gateway


def render(values):
    v4, gw4 = interface(values, "IPV4")
    v6, gw6 = interface(values, "IPV6")
    return (
        "# Written by beads-uplink from fleet/secrets/fleet-addresses.yaml.\n"
        "[Network]\n"
        f"Address={v4}\n"
        f"Address={v6}\n"
        "\n[Route]\n"
        f"Gateway={gw4}\n"
        "\n[Route]\n"
        f"Gateway={gw6}\n"
    )


def write_file(path, text, mode):
    os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def apply(env_file, dropin, recovery):
    try:
        text = render(read_env(env_file))
        source = "document"
    except (OSError, Invalid) as e:
        print(f"beads-uplink: fleet-addresses unusable ({e})", file=sys.stderr)
        try:
            with open(recovery, encoding="utf-8") as f:
                text = f.read()
        except OSError:
            print(f"beads-uplink: no recovery copy at {recovery}; uplink stays down", file=sys.stderr)
            return 1
        source = "recovery copy"
    write_file(dropin, text, 0o644)
    if source == "document":
        os.makedirs(os.path.dirname(recovery), mode=0o700, exist_ok=True)
        write_file(recovery, text, 0o600)
    print(f"beads-uplink: applied the {source}")
    return 0


def main(argv):
    if len(argv) == 3 and argv[1] == "render":
        try:
            sys.stdout.write(render(read_env(argv[2])))
        except (OSError, Invalid) as e:
            print(f"beads-uplink: {e}", file=sys.stderr)
            return 1
        return 0
    if len(argv) == 5 and argv[1] == "apply":
        return apply(argv[2], argv[3], argv[4])
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
