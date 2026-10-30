# 0001. Remote SQL control plane

Date: 2026-08-11

## Status

accepted

## Context

Beadsmith is the user-visible product. The git repository, Deno package
identity, environment variable prefix, Compose service names, and on-disk
state directory are still `beads-web`. `src/lib/product.ts` exports
`PRODUCT_NAME = 'Beadsmith'` and warns not to use that string as a directory,
host, or credential filename.

Beads keeps its issues in Dolt SQL databases. A dashboard over them can either
read those databases over SQL from a server, or act as a desktop client that
finds `.beads` workspaces on disk and drives `bd`. The second shape makes
project membership depend on which checkouts a machine happens to have and
gives a network service filesystem and process authority it does not need.

## Decision

We will run Beadsmith as a server that reads Beads projects from one
configured remote Dolt SQL server. A project is a user database on that
server.

The one operator entry point is `deno task serve`. The web process does not
inspect local project directories, register or link workspaces, or treat a
filesystem path as a Beads project. It has no dotenv-file loader and no
desktop credential helper. The Dolt password arrives from the process
environment (`BEADS_DOLT_PASSWORD_FILE` preferred; `BEADS_DOLT_PASSWORD` as a
local/development fallback).

Status always reports `mode: 'remote'`.

## Consequences

Browsers and the iOS client see project and issue reads plus sanitized
status. Today Beads changes (create, claim, close, comment) are made by agents
that run `bd` against the Dolt server, launched through dispatch
([0006](./0006-durable-agent-dispatch.md)). Editing issues from the web UI is
a welcome future feature; it needs a write path that keeps Beads' events and
Dolt commits correct.

That a service credential can enumerate a database does not make that
database visible to a browser. A per-project catalog and membership gate is
the target ([0009](./0009-edge-identity-and-catalog-gate.md),
`docs/public-access.md`); it is not built yet, so every signed-in account sees
every SQL-visible project.

## Alternatives considered

**Desktop client over local workspaces.** Discover `.beads` directories, link
them to remote databases, and fall back to a `bd` binary. Rejected: it widens
the web process's filesystem and execution authority, mixes desktop credential
helpers into a server, and makes project membership an accident of whoever
mounted a checkout.

**Filesystem as catalog.** Infer projects from `.beads` directories on disk.
Rejected: the server must not require a workspace mount or a home directory
scan, and local JSONL is not the source of truth.

## Implementation notes

- Product string: `src/lib/product.ts` (`PRODUCT_NAME`), tests in
  `src/lib/product.test.ts`.
- Contract: `docs/contract.md`. Deployment: `docs/server-deployment.md`.
- Status snapshot: `src/lib/server/status.ts` always sets `mode: 'remote'`
  (`src/lib/types.ts`).
- Discovery: `src/lib/server/discovery.ts` (`discoverProjects`,
  `remoteProjects`), tests in `src/lib/server/discovery.test.ts`.

Related decisions: [0003](./0003-dolt-read-plane.md) (the SQL reader),
[0004](./0004-service-local-sqlite.md) (service-local state, not Beads data),
[0009](./0009-edge-identity-and-catalog-gate.md) (SQL visibility is not
publication).
