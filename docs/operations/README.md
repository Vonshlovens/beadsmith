# Operations

Guides for running Beadsmith on a NixOS host built from this flake, written
against the maintainer's host `beads` (`fleet/hosts/beads`,
[ADR-0014](../../specs/decisions/0014-public-repo-nix-and-fleet.md)). Running
Beadsmith with Docker Compose instead is covered in
[server-deployment.md](../server-deployment.md).

| Guide                                          | Use it to                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| [host-beads.md](host-beads.md)                 | Know what runs on the host, reach it, change secrets, deploy and roll back |
| [install.md](install.md)                       | Install or reinstall NixOS on the VPS from the provider's template         |
| [backup-and-restore.md](backup-and-restore.md) | Take a consistent copy of every Beads database and restore it onto a host  |
| [recovery.md](recovery.md)                     | Get a host back when a deploy, the network or decryption goes wrong        |

Conventions: commands run on the operator's machine from a checkout of this
repository unless they say otherwise. Steps marked **(operator)** show or
enter secrets or use a web console. Addresses and other identifying values
are named by their secret in `fleet/secrets/fleet-addresses.yaml` (for
example `BEADS_PUBLIC_IPV4`) and decrypted into the shell when a command
needs them; never paste them into issues, docs or commits.
