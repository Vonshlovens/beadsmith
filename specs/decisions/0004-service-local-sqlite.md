# 0004. Service-local SQLite

Date: 2026-08-11 (updated 2026-08-25, 2026-10-17, 2026-10-17 accounts, 2026-10-28 provider-neutral dispatch, 2026-10-28 todos)

## Status

accepted

## Context

The web process still needs durable application state that is not Beads
issue data: UI preferences, and later control-plane records such as File
and Tackle dispatch. Putting that state in Dolt would mix product settings
with issue history and would use the Beads credential for non-Beads rows.
Putting issue rows or the Dolt password in a local file would recreate a
second Beads database on the VPS and break
[0003](./0003-dolt-read-plane.md).

`docs/contract.md` allows the service-local database to hold application
settings, public catalog metadata, membership data, and dispatch metadata
when those features exist. Catalog and membership are not shipped. The
schema must not grow issue tables or credential columns in the meantime.

## Decision

We will keep service-local application state in SQLite under `BDX_STATE_DIR`,
in a file named `state.db`, accessed with `@libsql/client`.

Directory resolution (`resolveStateDir` in `src/lib/server/env.ts`):

1. `BDX_STATE_DIR` if set
2. else `$XDG_STATE_HOME/beads-web`
3. else `~/.local/state/beads-web`

The reviewable table list lives in `src/lib/server/state/schema.ts` (Drizzle
sqlite-core). The runtime does not run drizzle-kit push or migrate.
`src/lib/server/state/db.ts` opens `file:${stateDir}/state.db` and applies
`CREATE TABLE IF NOT EXISTS` for the known tables.

Today the database has nine application tables plus four account tables:

- `settings` — key/value application preferences. The shipped key is
  `ui.theme` (`system` | `light` | `dark`); `dispatch.armed` is the global
  File/Tackle kill switch and defaults to armed when absent.
- `dispatch_requests` — File/Tackle control-plane metadata: opaque request
  id, idempotency key (unique), project id, Dolt database name of the
  targeted request, operation, actor, payload JSON, status, provider, optional
  agent id/url/run id, sanitized error, timestamps. (Startup renamed the
  first provider's `cursor_`-prefixed columns from 2026-10-28; that step was
  removed on 2026-10-30 once every install had run it.)
- `dispatch_turns` — per-mission conversation turns:
  request id, role (`operator` | `agent`), sanitized display text, optional
  run id and terminal status, timestamp. Never the launch prompt or worker
  logs ([0006](./0006-durable-agent-dispatch.md)).
- `tackle_repository_maps` — operator-edited project-to-GitHub checkout
  mapping (`url`, optional ref normalized to an empty string, and automatic-PR
  preference). Environment/file maps remain the higher-precedence override.
- `file_checkout_maps` — optional per-project File checkout (`url`, `ref`
  only). No PR flag and no env overlay. Missing row → no checkout; the runner
  uses its default. Present-but-invalid row
  fails File launch closed (does not fall back). Distinct from Tackle maps.
- `dispatch_project_allows` — per-project booleans controlling whether File
  and Tackle may launch. Missing rows default to allowing both operations.
- `backup_runs` — backup run history: id, trigger, status, timestamps,
  database count, bytes, bucket location, pruned count, sanitized error
  ([0010](./0010-in-app-backups.md)).
- `todos`, `todo_comments` — the admin todo list: title,
  markdown body, priority P0–P4, `due_at`, JSON `tags`, status
  (`open` | `done` | `archived`), `completed_at`, manual `sort_key`, and
  reference-only routing columns (`routed_project_id`, `routed_dispatch_id`,
  `routed_issue_id`), plus a comment thread per todo. Application-owned rows,
  not Beads issues; urgency is derived from priority and due date
  (`src/lib/todos/urgency.ts`) and never stored. `/api/todos` is admin-only,
  reads included. No separate ADR: this is another table in the same file.
- `auth_user`, `auth_session`, `auth_account`, `auth_verification` —
  Better Auth accounts, sessions, sign-in methods (password as a scrypt hash),
  and short-lived verification values ([0011](./0011-accounts-and-roles.md)).
  The `settings` key `auth.signup` (`open` | `closed`) is the self sign-up
  switch.

The `settings` key `backup.config` holds the backup destination. Its access
key, secret key, and passphrase are sealed with AES-256-GCM under the master
key from `BDX_SECRET_KEY_FILE` (or a generated `secret.key`); this is the one
place `state.db` holds a reversible credential. Account passwords are stored
only as one-way hashes (0011).

Schema comment in `schema.ts`: Beads issue documents, workspace paths, and
credentials never enter this database. Project ids in repository and policy
rows are control-plane references only. They are not a project catalog and
not issue rows.

This database must never hold Dolt passwords, dispatch provider secrets, or Beads
issue documents, and holds backup credentials only in sealed form. Idempotency for File/Tackle lives here: a replay with the
same key and the same payload returns the original record and does not
launch a second agent (`src/lib/server/dispatch/store.ts`).

## Consequences

Theme preference, dispatch safety policy, operator-edited Tackle mappings, and
optional File checkout maps survive process restart without touching Dolt. Dispatch status survives so
retries stay auditable. Losing `state.db` loses those application settings and
in-flight dispatch records; it does not lose Beads issues.

When catalog and membership features exist, they may be added to this
database as application-owned tables. That is a future schema change, not
a description of the current file. Until then, project lists come from the
Dolt reader ([0003](./0003-dolt-read-plane.md)) and the interim Access
email allowlist ([0005](./0005-bind-policy-and-cloudflare-access.md)).

Production Compose bind-mounts `/var/lib/beads-web` into the web container
and sets `BDX_STATE_DIR` accordingly.

## Alternatives considered

**Cache issues or project rows in SQLite.** Rejected: Dolt remains the
source of Beads data. A local replica would go stale and would become a
second credential surface.

**Store settings in Dolt.** Rejected: UI theme is not Beads history and
must not require the writer role or a Dolt commit.

## Implementation notes

Shipped:

- Drizzle schema (source of truth for review):
  `src/lib/server/state/schema.ts`.
- Runtime open/init: `src/lib/server/state/db.ts` (`STATE_SCHEMA_SQL`,
  `stateDbPath`, `getStateStore`, `getDispatchStore`). drizzle-kit config
  only: `drizzle.config.ts`.
- Env: `BDX_STATE_DIR`, plus `XDG_STATE_HOME` / `HOME` fallbacks
  (`src/lib/server/env.ts`, `src/lib/server/env.test.ts`).
- Theme write path: `src/routes/api/settings/theme/+server.ts`, tests in
  `src/routes/api/settings/theme/server.test.ts`. HTML shell reads `ui.theme`
  in `src/hooks.server.ts`.
- Dispatch persistence, policy, mapping, and idempotency:
  `src/lib/server/dispatch/store.ts`, `src/lib/server/dispatch/policy.ts`,
  `src/lib/server/dispatch/tackle-maps.ts`,
  `src/lib/server/dispatch/file-maps.ts`, and
  `src/lib/server/dispatch/service.ts`. Tests:
  `src/lib/server/state/db.test.ts` (the five-table allowlist),
  `src/lib/server/dispatch/store.test.ts`,
  `src/lib/server/dispatch/policy.test.ts`,
  `src/lib/server/dispatch/tackle-maps.test.ts`, and
  `src/lib/server/dispatch/file-maps.test.ts`.
- Todos: `src/lib/server/todos/store.ts` (`TODO_SCHEMA_SQL`, `createTodoStore`),
  `src/routes/api/todos/`, `src/lib/todos/urgency.ts`. Tests alongside, plus
  the member 403 cases in `src/hooks.accounts.test.ts`.
- Contract: `docs/contract.md` (read policy: local state must never hold a
  Dolt password or replace Dolt as the source of issues).
- Operator: `README.md`, `docs/server-deployment.md`.

Not shipped:

- `projects`, `project_memberships`, or `audit_events` tables. Conceptual
  model only in `docs/public-access.md`. Accounts exist (0011); per-project
  membership does not.

Related: [0006](./0006-durable-agent-dispatch.md) (dispatch records),
[0005](./0005-bind-policy-and-cloudflare-access.md)
(no-accounts sessions are in-memory), [0011](./0011-accounts-and-roles.md)
(account sessions are in this file).
