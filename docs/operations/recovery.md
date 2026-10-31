# Recovery

## A deploy broke the host

Push-to-deploy switches back by itself when `/healthz` or a required unit
fails, and backs off before trying that revision again. Fix forward with a
new commit on `main`. To take over by hand, stop the timer and roll back:

```bash
ssh beads-admin@beads 'sudo systemctl stop beadsmith-auto-update.timer; sudo beadsmith-auto-update status; sudo nixos-rebuild switch --rollback'
```

Start the timer again when `main` is good. Rollback restores the system, not
data.

## The host is not on the tailnet

SSH and Dolt are reachable only over Tailscale, and nobody can log in on the
console (no passwords). Open the provider's browser console, reboot, and pick
an older generation in GRUB (the GRUB menu is on the serial and VGA
consoles). Generation 1 after an install is the provider's template, with the
root password you set; from there, fix and rebuild ([install.md](install.md)).
The provider's recovery mode can also mount the disk.

Common causes:

- **Tailscale key.** The one-time auth key was used or expired before the
  first login. Generate a new one, `fleet/scripts/fill-secrets.sh tailscale`,
  rebuild.
- **The node registered as `beads-1`.** The old machine was still in the
  admin console. Remove both, then let the host log in again.
- **No network.** `beads-uplink.service` writes the public addresses from
  `fleet/secrets/fleet-addresses.yaml` into
  `/run/systemd/network/10-wan.network.d/`. When that document cannot be read
  it applies the recovery copy `/var/lib/beads-host/uplink.conf`; when neither
  exists the uplink stays down. Write the copy again with
  `fleet/scripts/uplink-recovery.sh root@<BEADS_PUBLIC_IPV4>` from a system
  that has public SSH (the template generation).

## Secrets did not decrypt

`/run/secrets` is empty or Beadsmith refuses to start with "missing" or
"placeholder". Check that `/var/lib/sops-nix/key.txt` is the host key
(`600 root`, 184 bytes) and that the file on the deployed revision is
encrypted to it (`.sops.yaml`). Beadsmith refuses to start on a placeholder
on purpose: a known Better Auth secret would let anyone forge sessions.

## Beadsmith refuses to start: shared uid

`uid N of beads-web is shared with: …` means another account holds
Beadsmith's uid, so it could read Beadsmith's state. Move `beads-web` as
described in [host-beads.md](host-beads.md#users-and-ids).

## Lost the last admin's password

On the host, run the accounts task as the service user against its state
directory. It asks for the new password twice and signs the account out:

```bash
ssh -t -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 beads-admin@beads
app=$(systemctl show -p WorkingDirectory --value beadsmith)
node=$(systemctl show -p ExecStart --value beadsmith | sed -E 's/.*path=([^ ;]+).*/\1/')
cd "$app" && sudo -u beads-web env BDX_STATE_DIR=/var/lib/beads-web HOME=/var/lib/beads-web "$node" scripts/accounts.ts set-password you@example.com
```

`list` and `promote <email>` run the same way (README, Accounts).
