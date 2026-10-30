# 0014. Public repo with its host, one Nix toolchain, Nix-built image

Date: 2026-10-29

## Status

accepted. Amends [0008](./0008-runtime-and-deployment.md): the published
image is built by Nix, the pins live in `nix/overlay.nix`, and the
maintainer's host is declared in this repository.

## Context

Beadsmith was developed in a private repository and published as a one-commit
snapshot by `scripts/public-export.sh`, which stripped `fleet/`, `.sops.yaml`,
`.beads/`, `ios/` and marked blocks. The owner wants to develop in public,
laid out the way ghuntley/overalls is: host declarations and sops-encrypted
secrets in the public repository, and the toolchain, image and machine tests
from one flake.

## Decision

- **One public repository**, `Vonshlovens/beadsmith`, started from a scrubbed
  root commit. The private history stays in the archived `beads-web`. The
  export script and its exclude list are gone; `scripts/public-scan.sh`
  (gitleaks, trufflehog, a private denylist) checks what git would publish.
- **Host in the repo, secrets in sops** (overalls layout): `fleet/hosts/beads`
  and `fleet/secrets/*.yaml`, encrypted to the owner's and the host's age
  keys. Values that identify the host and are not needed at evaluation time
  are secrets too (overalls ADR-0233): the public addresses and hostname
  (`fleet-addresses.yaml`), the backup bucket and database list
  (`beads-backup.yaml`). The host applies its uplink from them at runtime,
  with a recovery copy. Dolt uses host networking so the firewall, not a
  Tailscale address literal, limits 3306 to `lo` and `tailscale0`.
- **`.beads/` is not tracked.** Which Dolt server holds this repo's issues is
  the maintainer's configuration; `scripts/bd-setup.sh` installs it per
  checkout. `ios/` moved to the private `Vonshlovens/beadsmith-ios`.
- **One toolchain definition**, `nix/overlay.nix`: `beadsmith-nodejs`,
  `beadsmith-pnpm` (the native `@pnpm/exe` release, since nixpkgs lags),
  `beadsmith-dolt`, `beadsmith-bd`. New attribute names only, so nothing else
  in nixpkgs rebuilds. Consumers: `flake.nix` (packages, checks, image,
  `services.beadsmith`), `devenv.nix` (shell, `devenv test`, git hooks), the
  VM test. `checks.toolchain` fails when the overlay disagrees with
  `.node-version` or `packageManager`.
- **Backpressure**: `checks.check`/`checks.test` (`pnpm run check`/`test` in
  the sandbox), `checks.vm` (`runNixOSTest`: Beadsmith and Dolt boot, bd
  init/create/ready work, `/healthz` is 204), `checks.beads-toplevel` (the
  host closure builds). CI runs them; the VM test runs under KVM.
- **The published image is `packages.image`** (`dockerTools`), pushed with
  skopeo as `ghcr.io/<owner>/<repo>:<sha>` and `:latest` after the checks
  and the VM test pass on `main`. The name `compose.yaml` pulls is unchanged.
  The Dockerfile stays so `docker compose ... --build` and the quickstart work
  without Nix.
- **Binary cache**: Cachix, named by the repository variable `CACHIX_CACHE`
  and pushed with the `CACHIX_AUTH_TOKEN` secret; without them CI builds
  everything itself.

## Consequences

- Anything committed is public at once; run `scripts/public-scan.sh` before a
  push that touches `fleet/` or docs about the host.
- Earlier history (and DNS) may still name what is now in sops; the archived
  private repo is where that history lives.
- Toolchain bumps are an overlay edit plus `.node-version` or `packageManager`;
  `checks.toolchain` rejects one without the other.
- A fresh clone on the maintainer's machines needs `scripts/bd-setup.sh`
  before `bd` works.

## Implementation notes

`flake.nix`, `nix/overlay.nix`, `nix/tests/beadsmith.nix`,
`nix/toolchain-check.nix`, `devenv.nix`, `devenv.yaml`,
`.github/workflows/ci.yml`, `.github/actions/nix/action.yml`,
`fleet/hosts/beads/networking.nix`, `fleet/hosts/beads/files/uplink/uplink.py`,
`scripts/public-scan.sh`, `scripts/bd-setup.sh`.
