# 0003. Dolt read plane

Date: 2026-08-12

## Status

accepted. Account grants amended by
[0013](./0013-owner-account-and-global-readers.md).

## Context

Beads issue data lives in Dolt SQL databases, not in this application's
SQLite file and not in `.beads/issues.jsonl`. The web process needs one
private path to read that data
([0001](./0001-remote-sql-control-plane.md)).

The same Dolt server also serves agents that run `bd`. Those agents must not
share the web reader's credential, and this workspace must not start a second
local Dolt.

Driver errors and connection URLs can contain hosts, users, paths, and
password material. An empty `SHOW DATABASES` result can also look like
"auth failed" if the control plane is careless. The browser may see only a
fixed, sanitized failure class.

## Decision

We will read Beads data from one configured Dolt SQL server, with a
parameterized, single-statement, read-only client.

Connection settings come from the process environment:

| Setting                    | Role                                                                 |
| -------------------------- | -------------------------------------------------------------------- |
| `BEADS_DOLT_SERVER_HOST`   | Required. Absence means Dolt is not configured.                      |
| `BEADS_DOLT_SERVER_PORT`   | Optional; code default `3306`.                                       |
| `BEADS_DOLT_SERVER_USER`   | Optional; code default `root`. Production sets `beads_web_reader`.   |
| `BEADS_DOLT_PASSWORD_FILE` | Preferred production secret source.                                  |
| `BEADS_DOLT_PASSWORD`      | Local/development fallback only.                                     |

`resolveDoltPassword()` prefers the file and never places the password on
`ServerEnv`, in logs, URLs, argv, the state database, the browser, or API
bodies. The mysql2 pool receives it only in the connection config object
(`multipleStatements: false`). On each connection the client issues
`SET SESSION TRANSACTION READ ONLY` when the server supports it; older
servers may ignore that SET, and reads still proceed.

Queries are parameterized `SELECT` or `SHOW` with `?` placeholders. Database
names are validated (`^[a-z0-9_]{1,64}$`) and backtick-quoted; they are never
interpolated from untrusted strings.

Projects are user databases from `SHOW DATABASES`. System schemas
(`information_schema`, `mysql`, `performance_schema`, `sys`) and names
starting with `dolt_` are excluded. The opaque project id is `d_<database>`
(for example `d_beads_web`).

Failure classes are only:

- `credential_unavailable` — protected password missing, empty, or unreadable
- `authentication_rejected` — reachable SQL rejected the configured login
- `unreachable` — transport failure to the private endpoint
- `unknown` — any other dependency failure that cannot be classified safely

Classification uses the credential error type and documented driver codes, never
the error message string. A reachable empty catalog is a successful discovery
with zero projects, not a credential failure.

Canonical **agent** SQL (separate from this web reader): MagicDNS host
`beads`, TCP `3306`, user `beads_bd_writer`, database `beads_web`, as in
`.beads/metadata.json`. Never run `bd dolt start` in this workspace; that
would start a local Dolt instead of the tailnet server.

Grants ([0013](./0013-owner-account-and-global-readers.md)): the reader has
`SELECT ON *.*`, so a new project needs no grant to appear; that includes
`mysql.user`, which is why every account has a long random password.
`beads_bd_writer` has `ALL ON *.*` and is used only from the owner's
machines; any other agent gets an account scoped to projects.

## Consequences

The web unit on the VPS speaks to colocated Dolt (typically `127.0.0.1:3306`
as `beads_web_reader`, SELECT only). The owner's machines speak to
`beads:3306` as `beads_bd_writer`, which administers the server. Those
identities must not be swapped: the reader has no lifecycle grants, and the
writer's password never reaches the web unit.

`/api/status` publishes a failed ping as `dolt.failure_kind`. Failed project
discovery returns `error.failure_kind` in the unavailable envelope. Neither
envelope includes host, port, user, database, credential path, or driver text.

Empty-but-authenticated discovery stays empty. Operators diagnose privilege
or catalog gaps; they do not rotate the password solely because no user
databases appeared.

## Alternatives considered

**Browser- or dotenv-supplied Dolt URL.** Rejected: the
password must not enter request payloads, dotenv files, or desktop helpers.

**Treat an empty catalog as `credential_unavailable`.** Rejected: it hides
real privilege/discovery problems and panics operators into rotating a
working secret.

**Give cloud agents the private Dolt listener or the web password.** Rejected
in `docs/agent-access.md`. Lifecycle stays `bd` in the agent workspace; the
web password stays off that runtime.

## Implementation notes

Shipped:

- Schema compatibility: `src/lib/server/dolt/schema.ts`
  checks every column the read plane selects via `information_schema`,
  reports `local_metadata.bd_version` and the newest `schema_migrations`
  entry, and raises `UnsupportedSchemaError` (sanitized `unavailable`) for
  a project missing a column. Results are cached five minutes and cleared
  on project refresh. CI `bd-compat` matrix seeds databases with released
  bd versions (`scripts/ci/seed-beads-db.sh`) and runs
  `src/lib/server/dolt/compat.test.ts`.

- Password resolver: `src/lib/server/dolt-password.ts`, tests in
  `src/lib/server/dolt-password.test.ts`. `ServerEnv` in
  `src/lib/server/env.ts` deliberately omits the password
  (`src/lib/server/env.test.ts`).
- Client: `src/lib/server/dolt/client.ts` (`createDoltClient`, `poolQuery`,
  `toDoltConnectionError`, `isUserDatabase`, `quoteDatabase`). Tests in
  `src/lib/server/dolt/client.test.ts`.
- Discovery ids and failure mapping: `src/lib/server/discovery.ts`,
  `src/lib/server/discovery.test.ts`.
- Public type: `DoltFailureKind` in `src/lib/types.ts`. Status probe:
  `src/lib/server/status.ts`, `src/lib/server/status.test.ts`.
- Contract failure taxonomy: `docs/contract.md`. Reader vs writer SQL users:
  `docs/server-deployment.md`.
- Agent metadata (not used by the web pool): `.beads/metadata.json`
  (`dolt_server_host: beads`, `dolt_server_user: beads_bd_writer`,
  `dolt_database: beads_web`).

Code default user `root` is not the production account. Same-VPS units set
`BEADS_DOLT_SERVER_USER=beads_web_reader` and
`BEADS_DOLT_PASSWORD_FILE` via systemd/Compose credentials.

Related: [0004](./0004-service-local-sqlite.md) (must not hold issue rows or
the Dolt password).
