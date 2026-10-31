# Public Access and Project Authorization Proposal

- **Status:** Authentication is implemented: every route needs a Beadsmith
  account with an `admin` or `member` role
  ([ADR-0011](../specs/decisions/0011-accounts-and-roles.md)), optionally
  behind Cloudflare Access
  ([ADR-0005](../specs/decisions/0005-bind-policy-and-cloudflare-access.md)).
  Authorization is not: every account sees every project the SQL reader can
  see. The catalog and membership design below is the gate before anyone who
  should see only some projects gets an account. Agents read through one
  Access service token ([agent-access.md](./agent-access.md)).
- **Companions:** [server-deployment.md](./server-deployment.md),
  [contract.md](./contract.md), [agent-access.md](./agent-access.md), and
  [server-access.html](./server-access.html).

## Objective

Allow authenticated people to read only the Beads projects granted to them
through the remote SQL control plane. Keep four authorities separate:

1. **Authentication:** who made the request.
2. **Authorization:** which catalog projects and control-plane actions that
   person may use.
3. **Control-plane privilege:** the remote SQL resources the web service may
   read.
4. **Lifecycle execution:** a separately deployed agent-worker that owns any
   future Beads lifecycle action.

Membership never grants raw Dolt SQL, host access, local filesystem access, or
agent-worker capability.

## Non-goals

- Publishing every database the service credential can enumerate.
- Giving a browser raw SQL, a CLI, an agent command channel, or a host shell.
- Treating a shared static token as an individual identity.
- Letting a control-plane process perform direct SQL lifecycle mutations.
- Using a browser credential screen or desktop credential helper for the
  service's Dolt password.

## Identity model

A person is a Beadsmith account: email, display name, role, and a scrypt
password hash in the service-local `state.db`. Sessions are Better Auth's
signed `__Host-bdx_session` cookie, checked against the database on every
request, so a role change or removal applies at once. Accounts are always on;
there is no anonymous or implicit-operator mode.

### Implemented authentication boundary

`src/hooks.server.ts` runs, in order: Host allowlist, Origin and fetch-metadata
checks, the optional Cloudflare Access check, the `x-bdx-request` CSRF header on
mutations, the account session, the role check, and rate limits. Everything but
`/healthz`, the sign-in page, and `/api/auth/*` needs a signed-in account.

Cloudflare Access is optional. With `BDX_CF_ACCESS_ISSUER` and
`BDX_CF_ACCESS_AUDIENCE` set, each request must also carry an Access
application JWT signed by the team's JWKS, with matching issuer and audience
and valid time claims. The app trusts only the verified token, never a
forwarded identity header. Which people pass is the Access policy's job; inside
they still need an account. A token with an empty `sub` whose `common_name` is
listed in `BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS` is a machine principal
(`kind: service_token`): a read-only member for GET/HEAD `/api` with no session
cookie. It cannot mint a cookie, load HTML, or call mutating routes. The Client
secret never reaches the origin.

Every account currently sees the complete discovered catalog. The app discovers
remote projects through its SQL reader, so the curated catalog and membership
checks below remain the gate before selective sharing.

## Curated project catalog

The remote control plane may discover databases for operator purposes, but that
is not a public directory. Public reads must go through an explicit catalog that
maps an opaque public project key to an internal remote project reference.

| Public field               | Meaning                           | May be sent to an authorized browser? |
| -------------------------- | --------------------------------- | ------------------------------------- |
| project_key                | Opaque stable public identifier.  | Yes                                   |
| display_name               | Human-facing project name.        | Yes                                   |
| enabled                    | Whether the project is available. | Only after membership filtering       |
| internal_project_reference | Server-side resolver reference.   | No                                    |
| dolt_database              | Server database name.             | No by default                         |

An instance administrator explicitly creates and disables catalog entries. A new
remote database never becomes visible simply because the service can read it.

## Authorization data model

The access-control database is application-owned, durable, backed up, and
separate from Beads issue data. A conceptual minimum model is:

    users
      id
      external_subject (unique)
      email
      display_name
      status

    projects
      id
      public_key (unique)
      display_name
      internal_project_reference
      enabled

    project_memberships
      user_id
      project_id
      role
      granted_by
      granted_at
      revoked_at

    audit_events
      actor_user_id
      project_id
      action
      result
      occurred_at
      request_id

The implementation may use different names, but it must preserve a unique active
membership per user/project and an auditable grant/revocation trail.

## Roles and dispatch

| Role                   | Read assigned projects | Request future lifecycle dispatch | Membership management | Service administration |
| ---------------------- | ---------------------- | --------------------------------- | --------------------- | ---------------------- |
| Viewer                 | Yes                    | No                                | No                    | No                     |
| Contributor            | Yes                    | Only approved operations          | No                    | No                     |
| Project administrator  | Yes                    | Approved operations               | Assigned project      | No                     |
| Instance administrator | Catalog scope          | As explicitly approved            | All catalog projects  | Operator-only          |

The table does not enable lifecycle mutations. It defines the authorization
decision a future dispatch request would need before it enters a durable queue.
The exact operation matrix, including destructive actions, requires separate
review.

## Enforcement rules

Authorization occurs server-side before project resolution reveals metadata or
performs a remote SQL read.

| Request class                              | Required check                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| Sign-in entry                              | Account session (and a valid Access JWT when Access is configured).        |
| Project listing                            | Active catalog entry and active membership.                                |
| Project read                               | Viewer or stronger membership.                                             |
| Cross-project activity                     | Filter every source project before aggregation.                            |
| Lifecycle dispatch request                 | Authorized operation, validated payload, idempotency key, durable enqueue. |
| Membership change                          | Project administrator for that project, or instance administrator.         |
| Service configuration and remote discovery | Operator-only; never ordinary public routes.                               |
| Status                                     | Redacted user-safe status, or instance-administrator only.                 |

For a project a caller cannot see, return a non-enumerating response such
as 404. Reserve 403 for a known project where membership exists but authority
does not. Errors must not disclose other project names or database names.

## Durable agent-worker boundary

The web service has no direct SQL lifecycle capability. A future request must:

1. be authorized and validated by the control plane;
2. be persisted with actor, project, operation, request ID, and idempotency key
   before acknowledgement;
3. be claimed by a separate worker identity;
4. produce durable, sanitized status and audit evidence.

The browser never selects a worker command, CLI argument, or SQL statement. The
control plane must not proxy an agent process. The worker's Beads/agent
compatibility and its retries are an independent operational boundary.

## Access lifecycle

### Grant

An authorized administrator grants a role to a verified identity subject. An
invitation flow, if added, must match the verified subject and make ambiguous
email changes reviewable.

### Revocation

Revoking membership takes effect on the next request. Disabling a project
removes it from every list and blocks reads and dispatch requests regardless of
retained membership. Suspending a user blocks all projects.

### Audit

Record access-control changes and successful or denied privileged operations.
Operational logs may use opaque IDs and request IDs; credentials, raw tokens,
and unnecessary database metadata remain excluded. Dispatch audit must connect
the authorized request to the worker outcome without leaking worker internals.

## Security scenarios to test

1. An authenticated user cannot list, read, search, or receive activity from an
   unassigned project.
2. Guessing a public key, legacy ID, or database name reveals no project
   existence or data.
3. A Viewer cannot submit an unauthorized lifecycle dispatch request.
4. A Contributor cannot administer memberships or service configuration.
5. A revoked membership and suspended user lose access on the next request.
6. Forged, expired, wrong-audience, or header-only identities are rejected.
7. A direct request to the loopback origin cannot bypass identity validation;
   only the bodyless loopback-only `/healthz` probe is unauthenticated.
8. Cross-project counts, activity, and errors do not leak unauthorized data.
9. A duplicate lifecycle request is idempotent and cannot cause duplicate worker
   execution.
10. The web process cannot perform a lifecycle SQL write or invoke a worker
    directly.

## Decisions still required

- Whether invitations are allowed for project administrators or only instance
  administrators.
- The precise lifecycle-dispatch permission matrix and destructive-operation
  policy.
- The durable queue/outbox, worker-claim protocol, retry policy, and audit
  retention model.
- Whether an instance administrator may bypass project membership for recovery,
  and how that is audited.
- Account-scoped read tokens for agents, so agent reads
  no longer depend on Cloudflare Access.

This is an authorization specification, not proof of a public implementation.
The active web service remains a remote SQL read/control plane; public identity,
catalog membership, and durable lifecycle dispatch need their own rollout.
