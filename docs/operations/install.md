# Install or reinstall the host

Puts `nixosConfigurations.beads` on the VPS from the provider's NixOS
template. A reinstall wipes the disk: take a copy of the data first
([backup-and-restore.md](backup-and-restore.md)) and restore it afterwards.
Dolt and Beadsmith are down from the moment the old services stop until the
restore is verified, about 30–60 minutes.

Set these once per shell (the address comes from sops, never from a doc):

```bash
export IP=$(fleet/scripts/uplink-recovery.sh --print-ip)
r() { ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 "root@$IP" "$@"; }
```

## Before you start

- The flake builds the host: CI's `beads-toplevel` check is green for the
  revision you will install.
- `fleet/scripts/fill-secrets.sh check` shows no placeholders except, before
  a fresh login, `tailscale-auth-key`.
- **(operator)** The tailnet policy grants 3306 to `tag:beads-sql`, and you can
  create auth keys with that tag.
- The machine that holds the age keys can SSH with the key
  `fleet/hosts/beads/users-ssh.nix` authorizes. Tailscale SSH is off on this
  host, so that key is the only way in.

## 1. Reinstall (operator)

Provider panel → VPS → OS → Plain OS → NixOS → Change OS. Set a root password
(password manager) and add your SSH public key. If you forgot the key, after
the install: `ssh-copy-id -i ~/.ssh/id_ed25519.pub "root@$IP"` with that
password. The host key is new; accept it with the full word `yes`.

## 2. Compare the template with the flake

```bash
r 'nixos-version; ls /sys/firmware/efi >/dev/null 2>&1 && echo UEFI || echo BIOS; fdisk -l /dev/sda | grep -i disklabel; lsblk -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINTS; ip -br link'
r 'cat /etc/nixos/configuration.nix' > /tmp/template-configuration.nix
```

`fleet/hosts/beads/hardware-configuration.nix` expects BIOS, an MBR disk,
GRUB on `/dev/sda`, root `by-label/nixos` (ext4), one NIC `eth0`, and the
QEMU guest agent the panel uses. If the template differs, copy its values
into that file before building. Check that the live addresses match
`fleet/secrets/fleet-addresses.yaml` without printing them:

```bash
live=$(r 'ip -o addr show dev eth0; ip route; ip -6 route')
BEADS_MOUNT_KEYS=1 fleet/scripts/nix-docker.sh nix --quiet shell nixpkgs/nixos-26.05#sops -c sops decrypt --output-type dotenv fleet/secrets/fleet-addresses.yaml \
  | while IFS='=' read -r k v; do case $k in *_IPV4|*_IPV6|*_GATEWAY) grep -qF -- "$v" <<<"$live" && echo "match $k" || echo "MISMATCH $k";; esac; done
```

On a mismatch, `sops edit fleet/secrets/fleet-addresses.yaml`.

## 3. Tailscale (operator), in this order

1. Admin console → Machines → the old `beads` → Remove. Do this before the new
   node logs in, or it registers as `beads-1` and every client breaks.
2. Settings → Keys → Generate auth key: not reusable, not ephemeral,
   pre-approved, tag `tag:beads-sql`, expiry 1 day.
3. `fleet/scripts/fill-secrets.sh tailscale` (hidden prompt), then
   `fleet/scripts/fill-secrets.sh check`. Commit the encrypted file.

## 4. Host key and network recovery copy

```bash
r 'install -d -m 0700 /var/lib/sops-nix && umask 077 && cat > /var/lib/sops-nix/key.txt' < ~/.config/sops/age/beads-host.agekey
r 'stat -c "%a %U %s" /var/lib/sops-nix/key.txt'      # 600 root 184
fleet/scripts/uplink-recovery.sh "root@$IP"            # 10 /var/lib/beads-host/uplink.conf
```

The recovery copy gives the first boot a network even if decryption fails
([recovery.md](recovery.md)). Without public SSH, use the panel's browser
console: `install -d -m 0700 /var/lib/sops-nix; umask 077; cat >
/var/lib/sops-nix/key.txt`, paste the key from the password manager, Ctrl-D.

## 5. Build on the box

Copy exactly what is committed, and build with the project's binary cache so
the small VPS downloads instead of compiling:

```bash
git archive --format=tar HEAD | r 'rm -rf /root/beads-flake && mkdir -p /root/beads-flake && tar -C /root/beads-flake -xf -'
r 'NIX_CONFIG="experimental-features = nix-command flakes
extra-substituters = https://beadsmith.cachix.org
extra-trusted-public-keys = beadsmith.cachix.org-1:rTIq8/RTThaXp/fXvP3WhR9lcbENghg+di+8JlKwKXw=" nixos-rebuild boot --flake path:/root/beads-flake#beads'
```

`boot`, not `switch`: the new system takes over at the reboot, and GRUB
keeps the template as generation 1.

## 6. Reboot

Open the panel's browser console, then `r 'systemctl reboot'`. Root login
and public SSH are gone from here. Within a couple of minutes the node is on
the tailnet as `beads`:

```bash
ssh-keygen -R beads
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 beads-admin@beads 'hostname; tailscale ip -4; systemctl is-system-running; systemctl --failed --no-legend; sudo grep -l PLACEHOLDER /run/secrets/* /run/secrets/rendered/* || echo "no placeholders"'
```

Expect `beads`, a `100.x` address (clients use the name, so its value does not
matter), `running`, no failed units, no placeholders. `docker-beads-dolt` is
inactive until restored data exists, and Beadsmith runs on an empty state
directory. If the node never appears, see [recovery.md](recovery.md).

## 7. Restore and verify

Restore the data, start the services and diff against the checkpoint:
[backup-and-restore.md](backup-and-restore.md#restore-onto-a-host). Then:

- open the public site: Cloudflare Access, then Beadsmith;
- from outside the tailnet, `nc -vz -w 5 "$IP" 22` and port 3306 time out;
- run the restic job once ([host-beads.md](host-beads.md#backups));
- remove `/var/lib/beads-web.fresh` and the copied flake;
- enable push-to-deploy ([host-beads.md](host-beads.md#deploy)).

On a fresh state directory Beadsmith asks for a first admin: read the token
with `ssh beads-admin@beads 'sudo cat /var/lib/beads-web/setup-token'` and
paste it at `/auth`.
