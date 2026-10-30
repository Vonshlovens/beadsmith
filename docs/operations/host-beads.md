# Host `beads`

A small KVM VPS (2 vCPU, 8 GB, 100 GB disk, BIOS boot) running
`nixosConfigurations.beads` from this flake.

## What runs

| Unit                              | What                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `beadsmith.service`               | `services.beadsmith` on `127.0.0.1:4321`, user `beads-web` (uid 901), state in `/var/lib/beads-web` |
| `docker-beads-dolt.service`       | Dolt sql-server (pinned image digest), host networking, data in `/srv/beads-dolt/data`              |
| `cloudflared.service`             | Cloudflare Tunnel: the only public way in, to Beadsmith behind Cloudflare Access                    |
| `tailscaled.service`              | Joins the tailnet as `beads` with `tag:beads-sql`; SSH and Dolt are reachable only here             |
| `beads-uplink.service`            | Applies the public addresses from sops as a networkd drop-in ([recovery](recovery.md))              |
| `restic-backups-beads-dolt.timer` | Nightly restic snapshot of every Dolt database (alongside the in-app backups)                       |
| `beadsmith-auto-update.timer`     | Push-to-deploy, once enabled (below)                                                                |

The firewall admits only Tailscale's WireGuard port from the internet; port
22 and 3306 only on `tailscale0` (and loopback). sshd allows `beads-admin`
with a key; there is no root login and no password anywhere.

## Reach it

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 beads-admin@beads
```

`IdentitiesOnly` matters when an SSH agent holds several keys: without it the
agent offers the others first and the server stops accepting attempts before
it gets to the right one. Authorized keys are in
`fleet/hosts/beads/users-ssh.nix`.

## Secrets

Everything secret, and every value that identifies the host, is in
sops-encrypted files under `fleet/secrets/`, encrypted to the operator's age
key and the host's (`.sops.yaml`):

| File                   | Holds                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `beads.yaml`           | Service passwords and tokens, the Beadsmith secrets, Cloudflare Access settings, the one-time Tailscale key |
| `fleet-addresses.yaml` | `BEADS_PUBLIC_HOST`, `BEADS_PUBLIC_IPV4`/`_PREFIX`/`_GATEWAY` and the same for IPv6                         |
| `beads-backup.yaml`    | The restic repository URL and the list of databases restic checkpoints                                      |
| `vm-test.yaml`         | Dummy values for the boot test, encrypted to the throwaway key `vm-test.agekey`                             |

Change one with `sops edit fleet/secrets/<file>` (or `sops set`), commit,
and let it deploy. `fleet/scripts/fill-secrets.sh` generates the Beadsmith
secrets, takes a new Tailscale key at a hidden prompt, and (`check`) lists
keys still holding placeholders, never printing a value. Every secret is
described in [`fleet/secrets/README.md`](../../fleet/secrets/README.md). Without a local `sops`, the
scripts run it from nixpkgs in Docker (`fleet/scripts/nix-docker.sh`).

The host decrypts with `/var/lib/sops-nix/key.txt`, placed at install
([install.md](install.md)). Keep the operator and host private keys in a
password manager.

## Deploy

**Push-to-deploy.** CI moves the `deploy` branch to a `main` revision only
after every check, the NixOS VM test and the image pass. The host polls that
branch every 10 seconds, builds exactly that revision (binary cache:
`beadsmith.cachix.org`), switches, and requires `/healthz` 204 plus its
required units twice, five seconds apart. Otherwise it switches back and
retries the revision after a backoff (30 s doubling to 15 min); a newer
revision goes first. (`nix/modules/auto-update.nix`,
`fleet/hosts/beads/auto-update.nix`.)

It stays off until the operator enables it, after the host's real secrets
are on `main`:

```bash
ssh beads-admin@beads 'sudo install -d -m 0700 /var/lib/beadsmith-auto-update && sudo touch /var/lib/beadsmith-auto-update/enabled && sudo systemctl start beadsmith-auto-update.timer beadsmith-auto-update.service; sudo beadsmith-auto-update status'
```

Expect `"phase": "healthy"` with `lastHealthy` equal to the `deploy` head.
The host reads the repository without credentials, so it must be public.

**By hand.** Stop the timer first so the two don't race:

```bash
ssh beads-admin@beads 'sudo systemctl stop beadsmith-auto-update.timer && sudo nixos-rebuild switch --flake github:Vonshlovens/beadsmith/deploy#beads'
```

To deploy a local tree that is not on GitHub, copy exactly what is committed
and build it as a path flake:

```bash
git archive --format=tar HEAD | ssh beads-admin@beads 'rm -rf ~/beads-flake && mkdir -p ~/beads-flake && tar -C ~/beads-flake -xf -'
ssh beads-admin@beads 'sudo nixos-rebuild switch --flake path:$HOME/beads-flake#beads'
```

**Roll back** with `sudo nixos-rebuild switch --rollback` (or pick an older
generation in GRUB, [recovery.md](recovery.md)). Rollback restores the
system, not data: `state.db` and Dolt keep what the newer release wrote.

**Health at a glance:**

```bash
ssh beads-admin@beads 'systemctl --failed --no-legend; systemctl is-active beadsmith docker-beads-dolt cloudflared tailscaled; curl -s -o /dev/null -w "healthz %{http_code}\n" http://127.0.0.1:4321/healthz; sudo beadsmith-auto-update status'
```

## Users and ids

`beads-web` has a fixed uid (901) and gid (986) so restored state keeps its
owner. NixOS never changes the uid of an account that already exists in
`/etc/passwd`; it only warns. To move an account to a new uid, stop the
service, `chown -R` its files to the new ids, remove the account's line from
`/etc/passwd` and `/etc/shadow`, and run `switch-to-configuration switch` so
activation creates it again with the declared uid. `services.beadsmith`
refuses to start while another account shares its uid.

## Backups

Two run side by side while the in-app backups prove themselves:

- in-app backups to an S3-compatible bucket, set up in Console → Backups
  ([docs/backups.md](../backups.md));
- the nightly restic job (`backup-restic.nix`), which stops Dolt for a few
  seconds, checkpoints every listed database and uploads a snapshot. Run it by
  hand and look at the result:

  ```bash
  ssh beads-admin@beads 'sudo systemctl start restic-backups-beads-dolt.service; sudo cat /var/lib/beads-dolt-backup/last-result.json'
  ```

For a full copy of the data and a restore onto a new host, see
[backup-and-restore.md](backup-and-restore.md).
