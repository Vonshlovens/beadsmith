# Deployment secrets

Only sops ciphertext and public documentation belong here. Every file is
encrypted with [age](https://age-encryption.org) to the recipients in
[`.sops.yaml`](../../.sops.yaml); their private keys never enter the
repository, a build or the Nix store. Values are never written in docs,
issues or commits: name them by key. See
[host-beads.md](../../docs/operations/host-beads.md#secrets) for editing and
deploying, and [ADR-0014](../../specs/decisions/0014-public-repo-nix-and-fleet.md)
for why this lives in a public repository.

## Recipients

| Key          | Private key lives                                                        | Decrypts                                         |
| ------------ | ------------------------------------------------------------------------ | ------------------------------------------------ |
| `admin`      | the operator's password manager and `~/.config/sops/age/keys.txt`        | `beads.yaml`, `fleet-addresses.yaml`, `beads-backup.yaml` |
| `host_beads` | `/var/lib/sops-nix/key.txt` on host `beads` (placed at install), and the password manager | the same three files                             |
| `vm_test`    | [`vm-test.agekey`](vm-test.agekey), committed on purpose                 | `vm-test.yaml` only                              |

If a private key leaks, every value it can decrypt, in every past revision,
is exposed: rotate those values, issue a new key, and re-encrypt
(`sops updatekeys`).

## `beads.yaml`

Decrypted by sops-nix into `/run/secrets` at activation
([`secrets.nix`](../hosts/beads/secrets.nix)). Beadsmith gets its values as
systemd credentials, never by reading `/run/secrets` itself.

| Key                                   | What                                                                 | Rotate                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `beads-dolt-root-password`            | Dolt `root@localhost`, read by the Dolt entrypoint                   | Change in Dolt, then here; restart `docker-beads-dolt`                                     |
| `beads-web-dolt-password`             | Beadsmith's SELECT-only SQL user                                     | Change in Dolt, then here                                                                  |
| `beads-bd-writer-password`            | The writer account the operator's machines use for `bd`              | Change in Dolt, here, and in each machine's `~/.config/beads/credentials`                  |
| `beads-dolt-agent-password`           | Spare SQL account password kept with the others; no service uses it  | Drop once the account is gone                                                              |
| `beads-dolt-backup-sql-password`      | The restic checkpoint's SQL user                                     | Change in Dolt, then here                                                                  |
| `beads-dolt-backup-b2-key-id`, `-app-key` | Backblaze B2 application key for restic                          | New key in Backblaze, then here; delete the old key                                        |
| `beads-dolt-backup-restic-password`   | The restic repository password                                       | `restic key add` / `key remove`, then here                                                 |
| `cloudflared-tunnel-token`            | Cloudflare Tunnel connector token, the only ingress                  | Rotate in the Cloudflare dashboard, then here                                              |
| `tailscale-auth-key`                  | One-time, pre-approved, `tag:beads-sql`; only used at first login    | `fill-secrets.sh tailscale` before a reinstall ([install.md](../../docs/operations/install.md)) |
| `beads-web-better-auth-secret`        | Signs Beadsmith sessions                                             | New value signs everyone out; `fill-secrets.sh generate` only fills placeholders           |
| `beads-web-master-key`                | Encrypts credentials Beadsmith stores (backup bucket keys)           | A new key makes stored credentials unreadable: re-enter them after rotating               |
| `beads-web-cf-access-issuer`, `-audience`, `-allowed-emails` | Cloudflare Access settings for Beadsmith    | Change in Cloudflare, then here                                                            |

## `fleet-addresses.yaml`

The host's public addresses and hostname, kept out of plain Nix the way
ghuntley/overalls does (its ADR-0233). `beads-uplink.service` applies them
with a recovery copy ([networking.nix](../hosts/beads/networking.nix)), and
Beadsmith's allowed host and origin come from `BEADS_PUBLIC_HOST`.

| Key                                                          | What                                        |
| ------------------------------------------------------------ | ------------------------------------------- |
| `BEADS_PUBLIC_HOST`                                          | The public hostname behind the tunnel       |
| `BEADS_PUBLIC_IPV4`, `_IPV4_PREFIX`, `_IPV4_GATEWAY`         | Static IPv4 uplink from the provider        |
| `BEADS_PUBLIC_IPV6`, `_IPV6_PREFIX`, `_IPV6_GATEWAY`         | Static IPv6 uplink from the provider        |

Update after the provider changes them; a reinstall keeps them.

## `beads-backup.yaml`

Not secret, but identifying: the restic repository URL (it names the bucket)
and the space-separated list of databases the restic job checkpoints
([backup-restic.nix](../hosts/beads/backup-restic.nix)).

## `vm-test.yaml`

Dummy values for every key above, for the boot test (`.#beads-vm`). Its key,
`vm-test.agekey`, is committed and decrypts nothing else; never deploy the VM
variant.
