# Server Deployment: Remote SQL Control Plane

- **Status:** Remote read/control-plane baseline. Every route needs a
  Beadsmith account ([ADR-0011](../specs/decisions/0011-accounts-and-roles.md));
  Cloudflare Access is an optional outer layer
  ([ADR-0005](../specs/decisions/0005-bind-policy-and-cloudflare-access.md)).
  Per-project membership is still proposed: every account sees every project.
- **Companions:** [contract.md](./contract.md),
  [public-access.md](./public-access.md),
  [agent-access.md](./agent-access.md), and
  [server-access.html](./server-access.html).

## Intent

Deploy one Beadsmith service with [`compose.yaml`](../compose.yaml) on the
same machine as, or over a private path to, an existing Dolt sql-server. It reads Beads projects through remote SQL, provides
a secure control-plane surface, and has no local Beads workspace, CLI, desktop
credential-helper, or dotenv-loader dependency.

The service is not a lifecycle writer. A future lifecycle request must cross a
durable dispatch boundary to a separately deployed agent-worker. This keeps the
public/control-plane process from inheriting agent or Beads execution authority.

## Topology

```text
Browser (account sign-in)       Agent reader
  |                               |
  | HTTPS                         | HTTPS + one Access service token
  v                               v
Tunnel or reverse proxy (optionally Cloudflare Access)
  |
  v
Beadsmith remote SQL control plane
  |                         \
  | read-only SQL             \ durable, authorized dispatch requests
  v                             v
Dolt server                  separate agent-worker
                                  |
                                  v
                          worker-owned Beads lifecycle tooling
```

Agent reads are specified in [agent-access.md](./agent-access.md): today one
Access service token. Do not substitute a public Dolt listener, a `bd` binary
in this process, or a Bypass Access policy.

The tunnel (or reverse proxy) is the only public ingress. The application and
Dolt SQL listener stay loopback- or private-network-only. Accounts decide who
a person is and what role they have; Cloudflare transport and identity are not
a substitute for that. Restricting which projects an account sees still needs
the catalog and membership model in [public-access.md](./public-access.md).

## Cloudflare Access (optional)

Without Access, a public hostname needs only `BDX_ALLOWED_HOSTS` (and
`BDX_PUBLIC_ORIGIN` behind a TLS-terminating proxy): people sign in at `/auth`.

When `BDX_CF_ACCESS_ISSUER` and `BDX_CF_ACCESS_AUDIENCE` are set, every request,
sign-in included and even from loopback, must also carry a valid Cloudflare
Access **application** token in `Cf-Access-Jwt-Assertion`. The app fetches the
team JWKS from the configured team origin, selects by `kid`, verifies the RS256
signature, and checks issuer, audience, `exp`, `nbf`, and future `iat`. JWKS are
cached briefly and an unknown key forces one refresh. A malformed or unavailable
JWKS or token fails closed with a generic 403. Setting only one of the two is a
startup failure.

Which people get through Access is the Access policy's job; inside, they still
need an account. A token with an empty `sub` is a service token: it passes only
when its `common_name` is listed in `BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS`,
and then only for GET/HEAD under `/api` as a read-only member, with no cookie,
no HTML, and no writes ([agent-access.md](./agent-access.md)). The Client secret
never enters this repository or the web process. Issuer, audience and Client IDs
are configuration, not secrets. The Tunnel connector token is a protected
Cloudflare credential and never belongs in this repository or the service
environment file.

`/healthz` is the only route that needs neither account nor Access. It returns
an empty `204` only when both the TCP peer and HTTP Host are loopback; it never
creates a session, resolves an application route, or exposes data. Preserve the
public Host header through cloudflared (do not configure `httpHostHeader` or an
Origin Rule that rewrites it to `127.0.0.1`).

Cloudflare documents this origin-side validation flow and recommends the
assertion header over the browser cookie because the header is not optional on
the origin request. See
[Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

## Trusted public origin behind the Tunnel's HTTP loopback hop

Cloudflare terminates browser HTTPS, then `cloudflared` connects to this app
over plain HTTP on loopback while preserving the public `Host` header. Left
uncorrected, the adapter computes `event.url.origin` from that plain-HTTP hop
(`http://beads.example.com`) while a legitimate browser sends
`Origin: https://beads.example.com`, so `hooks.server.ts`'s same-origin
check would reject every real browser mutation (theme persistence, project
refresh) once published.

The fix is a narrow, explicitly configured contract, not a loosened check:
`BDX_PUBLIC_ORIGIN` names the exact `scheme://host` the browser sees for one
host. `src/hooks.server.ts` uses it only to correct the Origin comparison's
expected value when the request's already-validated `Host` header matches
that configured hostname exactly; every other request keeps the strict
`event.url.origin` comparison unchanged. The override is derived solely from
the raw `Host` header and this static configuration value — `X-Forwarded-Proto`,
`X-Forwarded-Host`, `Forwarded`, and any other client-supplied header are never
read, so a caller cannot make the check accept anything but the one origin the
operator configured. `src/lib/server/env.ts` parses `BDX_PUBLIC_ORIGIN` with
the same fail-closed rigor as the other public-host settings: omitting it
preserves today's strict behavior, and a malformed value or a hostname absent
from `BDX_ALLOWED_HOSTS` refuses to start rather than silently falling back.
It is non-secret configuration for `.env`, alongside `BDX_ALLOWED_HOSTS`, for
example `BDX_PUBLIC_ORIGIN=https://beads.example.com`.

**Mandatory post-route acceptance test:** automated tests exercise this
contract at the hook/adapter boundary and can pass before the Tunnel route
exists, but they do not prove the deployed stack together — cloudflared's
actual headers, TLS termination, and the running service. Once the protected
route exists, publication is not complete until a real browser performs an
actual mutation (theme toggle or the project-refresh action) through
`https://beads.example.com` and it succeeds. Read-only page rendering is
not a substitute for this check: a page can render correctly while every POST
still fails the Origin/CSRF gate.

## Service boundary

The `beads-web` service account needs only:

- a local or private network path to the configured Dolt SQL endpoint;
- a writable service-local state directory;
- protected read access to its runtime configuration and secrets.

It must not receive a workspace mount, a `bd` executable, broad user-home
access, or access to Windows Credential Manager, PowerShell, `secret-tool`, or
another desktop secret provider. In production, the password comes exclusively
from its protected `BEADS_DOLT_PASSWORD_FILE` credential-file configuration.

The separately deployed worker has its own identity, storage/queue access,
credentials, audit policy, and operational ownership. Do not solve worker
dispatch by widening the web process's permissions.

## Configuration and secrets

Inventory and protect the actual values for:

| Concern           | Required configuration                                                                  | Owner                          |
| ----------------- | --------------------------------------------------------------------------------------- | ------------------------------ |
| Dolt connectivity | host, port, user, protected `BEADS_DOLT_PASSWORD_FILE`                                  | server operator                |
| Web runtime       | state path (holds `auth-secret`), accepted hosts, public origin                         | server operator                |
| Edge              | tunnel credential, public hostname, Access audience                                     | Cloudflare administrator       |
| Public policy     | catalog entries, memberships, roles                                                     | instance/project administrator |
| Worker dispatch   | Webhook runner URL and shared secret (`BDX_DISPATCH_WEBHOOK_SECRET_FILE`) on the server | server operator                |

Secrets must be supplied by a service manager or approved secret manager. They
must not be committed, baked into an image, placed in Compose literals, logged,
stored in the service state database, supplied in URLs, or entered through a
routine browser workflow. `compose.yaml` mounts `./secrets/` read-only at
`/run/secrets` and sets `BEADS_DOLT_PASSWORD_FILE=/run/secrets/dolt-password`,
so the password never enters the container environment. The container runs as
`BEADSMITH_UID:BEADSMITH_GID`, which must own `./secrets/` (mode `0700`, files
`0600`) and `./data/`.

`BEADS_DOLT_PASSWORD` remains only a short-lived local/dev fallback, not the
production deployment mechanism.

After a credential rotation, restart the service (`docker compose restart`)
so its SQL connections use the new credential. A changed source file does not
update a running service.

## Compose deployment

[`compose.yaml`](../compose.yaml) and [`.env.example`](../.env.example) are the
only supported deployment. **Dolt is never a service in that file**, and a
tunnel connector such as cloudflared runs as its own service.

| Mode                 | `.env`                                               | Bind                                                            |
| -------------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| Bridge (default)     | nothing extra                                        | container `0.0.0.0`, published on `127.0.0.1:${BEADSMITH_PORT}` |
| Host, behind a proxy | `BEADSMITH_NETWORK=host`, `BEADSMITH_BIND=127.0.0.1` | host loopback                                                   |

Sign-in is the same in both: on first start Beadsmith generates
`data/auth-secret` and, while no account exists, `data/setup-token`. The first
visit to `/auth` asks for that token and creates the admin account (ADR-0011).
If the last admin's password is lost, `docker compose exec beadsmith node
scripts/accounts.ts set-password <email>` sets a new one (README, Accounts).

Point the tunnel or reverse proxy at `127.0.0.1:${BEADSMITH_PORT}` and keep
the public `Host` header. Upgrade by changing `BEADSMITH_IMAGE` to a new tag,
then `docker compose pull && docker compose up -d`. CI publishes
`ghcr.io/<owner>/<repo>:<git-sha>` and `:latest` on each green push to `main`;
pin the SHA tag rather than `:latest`.

## Lifecycle boundary

Direct SQL lifecycle writes are disabled. The following actions are not web
service capabilities: create, update, close, reopen, delete, comment, labels,
and dependencies.

For a future worker flow, require all of the following before exposing a user
control:

1. Validate and authorize an intent in the control plane.
2. Persist an idempotent dispatch record before acknowledging it.
3. Let a separately supervised worker claim the record.
4. Persist sanitized result and audit transitions for retry and review.
5. Keep the web service unable to run agent/Beads tooling even after the worker
   is deployed.

Direct SQL compatibility work is documented in
[sql-migration.md](./sql-migration.md). It is a future approval gate, not a
shortcut around the worker boundary.

## Public access gates

Every account sees every project the SQL reader can see; members read, admins
also manage the console and launch agents. Before inviting anyone who should
not see every project, the catalog and membership model in
[public-access.md](./public-access.md) has to exist. Trusted-HTTPS-origin
handling has code and automated tests (see "Trusted public origin behind the
Tunnel's HTTP loopback hop" above); each new deployment still needs the
real-browser mutation acceptance test before it counts as published.

Do not enable a public hostname until all of these are true:

1. The remote SQL service and its secret injection have been exercised against a
   disposable or staging Beads database.
2. The application reports missing/rejected SQL credentials as a sanitized
   dependency failure rather than an empty catalog.
3. The first admin account exists (the setup token is consumed) and sign-up is
   closed unless you mean to open it.
4. If Cloudflare Access fronts the host, its application and policy are verified
   before the production Tunnel route is created, and issuer and audience are
   configured here.
5. Dolt backup and restore, health, revocation, logging, and rollback
   exercises are complete. Dolt backups belong to the Dolt operator, not this
   service.
6. Any lifecycle dispatch system has a distinct worker identity, durable queue
   semantics, idempotency, and audit evidence.

## Operations

Health monitoring should distinguish application failure, tunnel failure,
missing/rejected SQL credentials, Dolt reachability, incompatible schema,
authorization denial, and worker-dispatch failure. Logs need request IDs and
sanitized error classes; they must not contain passwords, raw tokens, or
unapproved database metadata.

Rollback disables the public route or stops the web service without altering
Dolt issue data. Preserve relevant service/worker audit records, then restore a
known-good application release only after checking application-owned state
compatibility.

## Historical compatibility note

Earlier deployment material described local-workspace and CLI-mediated paths.
Those paths are retired from the web service. They remain relevant only when
designing the separate agent-worker's compatibility and safety controls.
