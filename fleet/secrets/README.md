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
| `admin`      | the operator's password manager and `~/.config/sops/age/keys.txt`        | `beads.yaml`, `fleet-addresses.yaml`, `beads-backup.yaml`, `forge.yaml` |
| `host_beads` | `/var/lib/sops-nix/key.txt` on host `beads` (placed at install), and the password manager | the same three files                             |
| `host_forge` | `/var/lib/sops-nix/key.txt` on host `forge`, and the password manager    | `forge.yaml` only |
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
| `beads-dolt-backup-sql-password`      | The restic checkpoint's SQL user                                     | Change in Dolt, then here                                                                  |
| `beads-dolt-backup-b2-key-id`, `-app-key` | Backblaze B2 application key for restic                          | New key in Backblaze, then here; delete the old key                                        |
| `beads-dolt-backup-restic-password`   | The restic repository password                                       | `restic key add` / `key remove`, then here                                                 |
| `cloudflared-tunnel-token`            | Cloudflare Tunnel connector token, the only ingress                  | Rotate in the Cloudflare dashboard, then here                                              |
| `tailscale-auth-key`                  | One-time, pre-approved, `tag:beads-sql`; only used at first login    | `fill-secrets.sh tailscale` before a reinstall ([install.md](../../docs/operations/install.md)) |
| `beads-web-better-auth-secret`        | Signs Beadsmith sessions                                             | New value signs everyone out; `fill-secrets.sh generate` only fills placeholders           |
| `beads-web-master-key`                | Encrypts credentials Beadsmith stores (backup bucket keys)           | A new key makes stored credentials unreadable: re-enter them after rotating               |
| `beads-web-mate-runner-secret`        | Signs First Mate requests to the runner                             | Rotate together with `mate-runner-secret` in `forge.yaml`; restart both services          |
| `beads-web-mate-runner-url`           | Runner HTTPS origin, with no path prefix                            | Update when the runner origin changes; restart Beadsmith                                 |
| `beads-web-cf-access-issuer`, `-audience`, `-allowed-emails` | Cloudflare Access settings for Beadsmith    | Change in Cloudflare, then here                                                            |
| `beads-web-e2b-api-key`               | Sand: E2B team API key ([docs/sand-e2b.md](../../docs/sand-e2b.md))  | New key in E2B's dashboard, then here; restart Beadsmith                                  |
| `beads-web-e2b-claude-oauth-token`    | Sand: Claude subscription token (`claude setup-token`)               | New token, then here; E2B's egress injects it, sandboxes never hold it                    |
| `beads-web-e2b-dolt-accounts`         | Sand: JSON of per-project `sbx_<database>` Dolt accounts            | `ALTER USER` as root, then here; one account per database, never `*.*`                    |
| `beads-web-e2b-tailscale-oauth-client-id`, `-secret` | Sand: Tailscale OAuth client that mints per-run keys | Revoke and recreate in Tailscale admin (Auth Keys: write, `tag:beads-sandbox`)            |
| `beads-web-e2b-github-app-id`, `-key` | Sand: GitHub App for per-run, one-repository tokens                 | Generate a new private key on the App, then here; delete the old key                      |

Planned, for the console's model pool
([ADR-0022](../../specs/decisions/0022-underclass-model-gateway.md)); add
them before host beads' configuration names them:

| Key                             | What                                                                  | Rotate                                                        |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| `beads-web-underclass-url`      | `BDX_UNDERCLASS_URL`: forge's tailnet HTTPS origin for Underclass, port 10000 | Update when forge's tailnet name changes; restart Beadsmith  |
| `beads-web-underclass-ui-token` | Underclass's UI token, the same value as `underclass-ui-token` in `forge.yaml` | Rotate on forge first, then here; restart both services      |

The `beads_bd_writer` password is deliberately not here: it lives only on the
operator's machines and in their password manager
([ADR-0013](../../specs/decisions/0013-owner-account-and-global-readers.md)).
To rotate it, change it in Dolt as root, then in each machine's
`~/.config/beads/credentials` and keychain.

## `forge.yaml`

Decrypted on host forge by its own age key at `/var/lib/sops-nix/key.txt`
([`runtime.nix`](../hosts/forge/runtime.nix)); services get the values as
systemd credentials. Operations: [host-forge.md](../../docs/operations/host-forge.md).

| Key                    | What                                                                                     | Rotate                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `underclass-proxy-key` | Underclass's proxy key; only the guest's model filter sends it                           | New value, restart `underclass` and `mate-model-proxy`                      |
| `underclass-ui-token`  | Underclass's UI and admin API token; Beadsmith's console holds a copy                    | New value, restart `underclass`; then update `beads-web-underclass-ui-token` |
| `mate-runner-secret`   | Signs First Mate requests to the runner                                                  | Together with `beads-web-mate-runner-secret` in `beads.yaml`                |

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
