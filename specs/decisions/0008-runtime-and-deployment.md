# 0008. Runtime and deployment

Date: 2026-08-16 (revised 2026-10-16: one public `compose.yaml`; revised
2026-10-27: Node, pnpm and Vite+ replace Deno; updated 2026-10-28: Cursor Cloud
bridge removed)

## Status

Amended by [0014](./0014-public-repo-nix-and-fleet.md): pins live in
`nix/overlay.nix`, and the published image is the flake's `image`.

accepted

## Context

Beadsmith is a SvelteKit app that must run the same way on a developer
loopback, an agent VM, and a self-hosted server next to Dolt.
The web process is a read/control plane
([0001](./0001-remote-sql-control-plane.md)); Dolt is a separate
database with its own container and credentials
([0003](./0003-dolt-read-plane.md)).

Until 2026-10 the repository also carried one operator's VPS kit (systemd
units, cutover and promote scripts, a native rollback unit, backup timers).
An open-source release needs one deployment a stranger can follow.

Cloud Agent VMs cannot reach the tailnet Dolt listener directly and
cannot use a TUN device. That problem is not the app container's job.

## Decision

We will run the app on Node with SvelteKit 2 / Svelte 5
(`@sveltejs/adapter-node`), install packages with pnpm, build, test and
lint with Vite+ (`vp`), and ship exactly one deployment: the root
`compose.yaml` configured by `.env`. Dolt stays a separate server.
Tailscale stays out of the image. Operator-specific process management
(systemd, cutover, backups) lives outside this repository.

Pins, kept identical everywhere so a later Nix build can reproduce them:

- Node 24.22.1: `.node-version` (read by Vite+ and `actions/setup-node`),
  `Dockerfile` (`node:24.22.1-bookworm-slim`); `engines.node` is the floor.
- pnpm 12.15.0: `packageManager` in `package.json` (read by
  `pnpm/action-setup`), `Dockerfile` (`npm install --global pnpm@12.15.0`).
- Vite+ 1.4.0: `vite-plus` and the `vite` alias to
  `@voidzero-dev/vite-plus-core` in `package.json`; Vitest 5.0.5 is the
  copy Vite+ bundles, listed directly so tests keep importing `vitest`.
- Every package version: `pnpm-lock.yaml`, installed with `--frozen-lockfile`
  in CI and the image.
- Package age: `pnpm-workspace.yaml` sets `minimumReleaseAge: 4320`
  (minutes, 3 days). pnpm refuses to resolve a version younger than that, so a
  compromised release has time to be caught and pulled first.
- Install scripts: only packages listed under `allowBuilds` in
  `pnpm-workspace.yaml` (today only esbuild) may run them; any other
  fails the install.

Operator commands (`package.json` scripts):

| Script              | Role                                                       |
| ------------------- | ---------------------------------------------------------- |
| `pnpm install`      | Install from `pnpm-lock.yaml`                              |
| `pnpm run check`    | `svelte-kit sync` + `svelte-check` + `vp check` (Oxlint)   |
| `pnpm run test`     | `vp test` (Vitest)                                         |
| `pnpm run build`    | `vp build` into `build/`                                   |
| `pnpm run dev`      | `vp dev` on `HOST=127.0.0.1`                               |
| `pnpm run serve`    | Build, then `node server.js` on `127.0.0.1:4321`           |
| `pnpm run audit`    | `pnpm audit --audit-level=high` (CI gate)                  |

`node server.js` serves adapter-node's `build/handler.js` on `HOST` and
`PORT`. It replaces adapter-node's `build/index.js`, which assumes
`https` unless `ORIGIN` or a trusted protocol header is set: this server
has no TLS, so it stamps every request `http` in a header it overwrites,
and a TLS proxy is handled by `BDX_PUBLIC_ORIGIN` as before. A non-loopback bind
requires accounts (`BETTER_AUTH_SECRET_FILE`,
[0011](./0011-accounts-and-roles.md)). Prettier stays the formatter
(`pnpm run format`) because it formats Svelte and sorts Tailwind classes;
`vp check` runs with `check.fmt` off.

Host-side scripts (`scripts/*.ts`) run on Node from source with type
stripping: `node scripts/accounts.ts`, or with
`--import ./scripts/ts-resolve.mjs` when they import `src/` files that
name siblings `./x.js`. The image carries `scripts/accounts.ts` and its
imports.

`compose.yaml` has two network modes, both chosen in `.env`:

- **Bridge (default):** publishes `127.0.0.1:${BEADSMITH_PORT}`; the
  process binds `0.0.0.0` inside the container, so accounts are
  required ([0011](./0011-accounts-and-roles.md)).
- **Host:** `BEADSMITH_NETWORK=host` and `BEADSMITH_BIND=127.0.0.1`; the
  process binds host loopback for a same-machine tunnel or proxy;
  accounts are optional there ([0005](./0005-bind-policy-and-cloudflare-access.md)).

Secrets are files in `./secrets/`, mounted read-only at `/run/secrets`;
the process reads `BEADS_DOLT_PASSWORD_FILE` and optional
`BDX_DISPATCH_WEBHOOK_SECRET_FILE`, never raw production environment values.
Service-local SQLite lives in `./data/`
([0004](./0004-service-local-sqlite.md)). The container runs as
`BEADSMITH_UID:BEADSMITH_GID`, the owner of both directories.

A green push to `main` publishes `ghcr.io/<owner>/<repo>:<git-sha>` (and
`:latest`). Upgrading is pinning that tag in `.env`, then
`docker compose pull && docker compose up -d`.

Agents that run `bd` reach private Dolt through their runner's own network
(for example the tailnet). That bridge is not inside the beads-web app
container. Never run `bd dolt start` against this workspace; that
would start a local Dolt, not the tailnet `beads` server.

## Consequences

HTTP is published on loopback only; a tunnel or proxy is the only public
ingress. Upgrading is an operator step, not a merge side effect. Rolling
back is pinning the previous tag. An operator who wants systemd units,
cutover scripts, or Dolt backups maintains them outside this repository.

Agents that need `bd` get Dolt access from their runner. Isolated agents
that only need the cross-repo catalog must not be handed that private SQL
listener instead
([0009](./0009-edge-identity-and-catalog-gate.md)).

## Alternatives considered

**Stay on Deno (2026-08 to 2026-10).** Deno ran the server through
`@deno/svelte-adapter`, which the built server imported at start, so the
image had to carry dev dependencies and run with `--cached-only` to stay
offline. Node with adapter-node is the runtime SvelteKit documents and
tests first, pnpm has a built-in package-age gate and build-script
allowlist, and
Vite+ puts dev, build, test and lint behind one pinned package.

**Native Deno systemd as ongoing production.** Replaced on 2026-08-16
by Compose + GHCR so a server runs the same image CI publishes. The
native rollback unit was dropped from the repository on 2026-10-16.

**Per-environment Compose files and overlays.** Retired on 2026-10-16
(`deploy/compose.yml`, `compose.cursor-dispatch.yml`, root
`docker-compose.yml`). Network mode and optional secrets are `.env`
choices in one file instead.

**Dolt in the beads-web Compose file.** Rejected: the database already
runs as `beads-dolt` with its own backup and privilege model. The web
stack only opens a read-only SQL connection.

**Tailscale (or `bd`) in the app image.** Rejected: the control plane
has no Beads execution authority and must not join the tailnet as a
side effect of serving HTTP.

## Implementation notes

Shipped:

- Pins: `.node-version`, `package.json` (`packageManager`, `engines`),
  `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `Dockerfile`, `.github/workflows/ci.yml`.
  Scripts: `package.json`. Server entry: `server.js`. Config: `vite.config.ts`, `vitest.config.ts`,
  `svelte.config.ts`.
- Deployment: `compose.yaml`, `.env.example`, `Dockerfile`. CI image
  publish: `image` job in `.github/workflows/ci.yml`.
- Operator docs: `README.md`, `docs/server-deployment.md`.
- Contract secret wording (file preferred): `docs/contract.md`. Read
  that as the password-file interface; the supported process manager is
  Compose.

Related: [0003](./0003-dolt-read-plane.md) (reader credential, never
start a local Dolt), [0005](./0005-bind-policy-and-cloudflare-access.md)
(loopback bind + tunnel).
