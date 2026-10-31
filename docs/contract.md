# Beadsmith — product and security contract

This document describes what the service does today and the security
properties it keeps. Beadsmith is a web dashboard and agent launcher over
Beads projects in a remote Dolt SQL server, not a local Beads client.
Architecture decisions live in [`specs/`](../specs/README.md).

## Product model

A project is a user database discovered from the configured remote Dolt SQL
server. System databases are excluded. The project identifier is opaque and
stable within the control plane; the raw database name is not a public access
identifier.

The web process has no authority to inspect local project directories or infer
project membership from a machine filesystem. It has no local-workspace
registration or linking.

A per-project catalog and membership gate
([public-access.md](./public-access.md)) is the target for sharing projects
selectively. **It is not implemented yet:** every signed-in account sees every
project the SQL credential can enumerate. Point the service at a Dolt user
that can see only the databases you mean to publish.

## Runtime and secret contract

The one operator entry point is `pnpm run serve`. The service needs a remote
Dolt connection supplied by its protected process environment:

| Setting                    | Requirement                                                                    |
| -------------------------- | ------------------------------------------------------------------------------ |
| `BEADS_DOLT_SERVER_HOST`   | Required for remote project discovery and reads.                               |
| `BEADS_DOLT_SERVER_PORT`   | Optional; defaults to the Dolt SQL port.                                       |
| `BEADS_DOLT_SERVER_USER`   | Optional SQL user.                                                             |
| `BEADS_DOLT_PASSWORD_FILE` | Preferred production secret source: a protected readable credential-file path. |
| `BEADS_DOLT_PASSWORD`      | Local/development fallback only; do not use as the production unit secret.     |

The resolver prefers `BEADS_DOLT_PASSWORD_FILE` and falls back to
`BEADS_DOLT_PASSWORD` only for a scoped local/development launch. The
production `compose.yaml` mounts `./secrets` read-only and sets
`BEADS_DOLT_PASSWORD_FILE=/run/secrets/dolt-password`.

The password is consumed only by the SQL connection configuration. It must not
be written to state, logs, URLs, browser storage, request payloads, or command
arguments. Operators must restart the service after rotating the credential so
new SQL connections use the newly injected file. There is no dotenv-file
loader or fallback to Windows Credential Manager, PowerShell, `secret-tool`,
or a process-memory credential entry screen.

A missing or rejected password is an unhealthy remote dependency. Discovery
must return a diagnosable, sanitized service error rather than silently
rendering an empty project set.

## Reading Beads data

Today the web process only reads Beads data. All reads use the remote SQL
client:

- database discovery and project metadata;
- issue lists, issue detail, dependencies, labels, comments, and events;
- counts and activity summaries;
- status probes needed to report remote availability.

Queries are parameterized, single-statement `SELECT` or `SHOW` operations.
The client uses a read-only SQL session where the server supports it and never
constructs SQL from user-controlled identifiers without strict validation.

The service-local state database may hold application settings, public catalog
metadata, membership data, and dispatch metadata when those features exist. It
must never hold a Dolt password or replace Dolt as the source of Beads issues.

## Changing Beads data

Issue changes today are made by agents that run `bd`, launched through
dispatch (below). Editing an issue directly from the UI is welcome future
work. Whatever write path it uses must keep what `bd` keeps: Beads' event
history, its change tracking, and correct Dolt commits.

## Agent dispatch

File, Tackle, comment, and discuss cross a durable, out-of-process boundary:

```text
browser / API request
  -> authorization and validation in beads-web
  -> durable dispatch record or queue
  -> separately deployed agent-worker claims work
  -> worker performs its owned Beads lifecycle action
  -> durable result/status available to the control plane
```

The control plane must record an opaque request ID, authenticated actor,
authorized project, operation, validated payload, idempotency key, and status
before acknowledging a request. The worker runs under its own identity and
credentials, separate from the web process. Retries are idempotent,
observable, and auditable.

The web process never executes an agent or proxies arbitrary commands. It
persists a request and launches an agent through the configured provider
(today a signed webhook runner; dispatch is provider-neutral); the agent runs
`bd` in its own environment.

## HTTP and UI boundary

The service exposes project and issue views, agent dispatch, the operator
console, and sanitized status. With accounts enabled (`BETTER_AUTH_SECRET_FILE`,
[ADR-0011](../specs/decisions/0011-accounts-and-roles.md)) browser callers
sign in to a Beadsmith account and every route except `/auth` and the
allowlisted `/api/auth/*` endpoints needs that session. Without accounts the
service serves one implicit operator on loopback, optionally behind
Cloudflare Access. Access, when configured, is checked first in both modes.
Isolated cloud agents cannot complete a browser flow and must not be given
the private Dolt listener instead; the origin accepts one allowlisted Access
service-token principal for GET/HEAD `/api` as specified in
[agent-access.md](./agent-access.md) (operator Cloudflare policy still
required). That principal is a read-only member.

Roles: `admin` may use `/console`, every `/api/console/*` route (backups and
accounts included), and File/Tackle/comment launch, cancel, and follow-up.
`member` may read, manage its own session and password, set the theme, and
refresh projects. Any other API write requires admin. The last admin cannot
be removed or demoted. The first account needs the one-time setup token from
the state directory; self sign-up is closed afterwards unless an admin opens
it. `/api/auth/*` exposes only `get-session`, `sign-in/email`,
`sign-up/email`, `sign-out`, and `change-password`.

`GET /api/console` is the operator-console read: discovered catalog projects,
Tackle map presence (`url` / `ref` / `auto_create_pr` / `source` when mapped),
optional File checkout (`url` / `ref` when mapped), per-project File vs Tackle
allow, Tackle coverage counts, redacted Dolt/dispatch health, and a read-only
Access panel.
`dispatch.enabled` means a dispatch provider is configured **and** dispatch
is globally armed; `dispatch.provider` names it (`webhook`, `none`). Split fields `key_configured` and `armed` are also public
(no secret values). The Access panel may list
already-configured emails, service-token Client IDs, allowed hosts, a parsed
`*.cloudflareaccess.com` issuer host, and whether audience is configured. It
must not include JWTs, the audience tag value, Client secrets, Dolt hosts,
ports, users, passwords, API keys, credential/config file paths, or the
account secret's name or value. Bind/Access completeness is a class
(`incomplete`, `invalid_email`, `public_host_unprotected`,
`public_origin_error`, `bind_unprotected`, …), not a `checkBindPolicy` string.
The console cannot add or remove emails or service-token IDs. The console is
sessionful like the rest of `/api` and admin-only.

`GET /api/console/accounts` lists accounts (id, email, name, role, disabled,
created) and the sign-up switch; never password hashes or sessions.
`PUT /api/console/accounts` `{signup_open}` sets the switch. `POST
/api/console/accounts/users` `{email, name, role, password}` creates an
account with an initial password; `PATCH .../users/:id` `{role?, password?}`
changes a role or sets a new password (which signs that account out);
`DELETE .../users/:id` removes it. Extra keys fail closed.

`PUT` / `DELETE /api/console/projects/:id/tackle-map` persist or clear a
service-local SQLite map `{url, ref?, auto_create_pr?}`. Extra keys fail
closed. Env/file maps remain an override and cannot be changed through this
API. Dispatch POST still cannot pass a repository.

`PUT` / `DELETE /api/console/projects/:id/file-map` persist or clear an
optional per-project File checkout `{url, ref?}`. Extra keys (including
`auto_create_pr`) fail closed. No map → File launches without a checkout and
the runner uses its default. A valid map launches that
url/ref with `autoCreatePR` false. A present-but-invalid map refuses launch
and does not fall back. File maps are distinct from Tackle maps.

`PUT /api/console/dispatch` `{armed}` is the global File/Tackle kill switch
(independent of the provider configuration). `PUT /api/console/projects/:id/allow`
`{file, tackle}` is per-project allow. Extra keys fail closed. Policy lives in
service-local SQLite, not Beads Dolt, and is not accepted from File/Tackle
POST bodies. Unmapped Tackle still fails closed even when Tackle is allowed.

`GET /api/ready` is the cross-project Ready deck: open issues with no open
`blocks` dependencies, merged across catalog projects the session can see,
sorted by priority then recency. Parent-child, related, and discovered-from
edges do not hide an issue. Tackle from that page uses the existing
`POST /api/projects/:id/dispatch` path.

The service does not expose routes for:

- local workspace registration, scanning, linking, or discovery roots;
- credential entry, credential deletion, or credential-provider inspection,
  except the write-only backup destination keys and passphrase in the operator
  console, stored encrypted ([ADR-0010](../specs/decisions/0010-in-app-backups.md)),
  and Beadsmith account passwords, stored only as one-way hashes
  ([ADR-0011](../specs/decisions/0011-accounts-and-roles.md));
- raw database administration or arbitrary server discovery.

The dispatch API accepts only a small validated request schema and returns a
request/status representation, never a shell command, database credential, or
raw worker log. The design is in
[file-tackle-dispatch.md](./file-tackle-dispatch.md).

`GET /api/projects/:id/dispatch/:requestId/stream` proxies a provider's live
events as a canonical `user` / `assistant` / `thinking` / `tool_call` /
`result` / `error` event union, or replays the stored result when the provider
has none. The browser renders that union only. The proxy ignores unknown
runner fields, drops tool args/results and ANSI/PTY, and never includes
provider credentials, the launch prompt, or raw worker logs.

`POST /api/projects/:id/dispatch/:requestId/cancel` cancels the active agent
run. `POST /api/projects/:id/dispatch/:requestId/follow-up` `{text}` starts a
new run on the same agent id. Follow-up text is the only free-form field and
is size-capped; extra keys, repository, model, and shell are rejected. A `409`
`conflict` means the agent is still busy. The composer is disabled while the
durable status is `launched` or `running`.

`GET /api/projects/:id/dispatch/:requestId/turns` returns the mission's
conversation: the operator's request and follow-ups, and each finished run's
sanitized reply. It is scoped to the owning project and never includes the
launch prompt, raw worker logs, or credentials. `operation: "discuss"`
(`intent`: `discuss` | `elaborate` | `close`, optional `message`) asks an
agent to talk an issue through, rewrite it, or close it; the agent makes any
Beads change with `bd`.

## Security invariants

1. The web runtime does not ship with or invoke `bd` today; issue changes go
   through dispatched agents.
2. The web runtime has no local workspace mount or broad home-directory read
   requirement.
3. SQL is parameterized; identifiers are strictly validated, never built from
   user input.
4. The protected credential file is the production password source;
   `BEADS_DOLT_PASSWORD` is only a scoped local/development fallback.
5. The application maintains Host-header, origin, CSRF, session, CSP,
   rate-limit, request-size, and secret-scrubbing defenses.
6. Target, **not implemented yet**: requests are authorized against a curated
   project catalog before a database name, count, activity item, or error can
   reveal project existence. Today every signed-in account sees every
   SQL-visible project.
7. A dispatch request is authorized before enqueue; a worker action is never
   directly triggered by untrusted browser input.

## Observability and failure behavior

### Fixed safe failure classes

Status and discovery use only these fixed, sanitized failure classes:

- `credential_unavailable` — the protected password was missing, empty, or
  could not be read by the service;
- `authentication_rejected` — the reachable SQL service rejected the configured
  login;
- `unreachable` — the service could not establish a connection to the private
  Dolt endpoint; and
- `unknown` — any other dependency failure that cannot safely be classified.

On a failed ping, `/api/status` publishes the class as
`dolt.failure_kind`; a failed project discovery returns it as
`error.failure_kind` in the normal unavailable envelope. The four classes must
never include password material, raw session tokens, host, port, user,
database, credential path, driver text, or unapproved database metadata. They
describe a dependency failure only: a reachable empty catalog remains a
separate discovery/privilege diagnosis, not a failure class.

Worker dispatch status is separate from SQL availability: `queued`,
`launching`, `launched`, `running`, `succeeded`, `cancelled`, and `failed` are
durable workflow states, not inferred from a browser connection. The control
plane follows the provider's run state and stores only sanitized result
metadata in its service-local SQLite database.

## Testing requirements

At minimum, tests must demonstrate:

1. Remote project and issue reads work with the configured SQL credential and
   do not execute a local CLI.
2. Credential-unavailable, authentication-rejected, unreachable, and unknown
   paths surface only their fixed sanitized class instead of an empty discovery
   result or raw driver detail.
3. No web route accesses workspace paths or invokes a desktop credential
   helper.
4. Once the catalog gate exists, catalog and membership checks prevent
   cross-project enumeration.
5. A dispatch request is validated, authorized, persisted idempotently, and
   processed only by the distinct agent-worker identity.
