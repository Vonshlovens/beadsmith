# 0012. New Beads projects through a tailnet project helper

Date: 2026-10-19 (updated 2026-10-28: `new-project --print-sql` fallback)

## Status

superseded by [0013](./0013-owner-account-and-global-readers.md). The helper
was never deployed; its code was removed on 2026-10-27, and the last version
is at commit `aeb6fc4`.

## Context

Agents and people use `bd` against one shared Dolt server as
`beads_bd_writer` ([0003](./0003-dolt-read-plane.md)). The writer cannot
`CREATE DATABASE`, so `bd init --server` for a new repository fails, and the
only way forward was an operator pasting SQL as the Dolt administrator. The
owner wants creating a project from any computer on the tailnet to work the
way it normally does in Beads.

Grant experiments on throwaway Dolt 2.1.8 (production's build) and 2.5.0
with bd 1.1.0 ruled out a grant-only fix:

- Data rights on `*.*` (with `CREATE`, without `GRANT OPTION`) make the
  writer root-equivalent: it rewrote `mysql.user` and granted itself more.
- Wildcard database grants (`` `bd\_%`.* ``) are stored and ignored.
- `ALL PRIVILEGES` on one database, without `GRANT OPTION`, lets `bd init`,
  `bd create` and `bd ready` work, while `GRANT`, `mysql.*` writes and other
  databases stay refused. But only an administrator can create that database.
- The old operator grant (`SELECT, INSERT, UPDATE, DELETE, EXECUTE`) is too
  little: `bd init` fails creating `schema_migrations`.

Out of scope: per-machine credentials, joining an existing project, and any
project creation from the web UI.

## Decision

We will run a separate, small **project helper** on the Dolt host. It is not
part of the web process, which holds no administrator Dolt credential.

- It listens only on the host's tailnet address and serves one endpoint,
  `POST /projects {"name": "<database>"}`.
- The caller is the identity `tailscale whois` reports for the peer address.
  It must match an allow list of login names and `tag:` names. There is no
  helper password.
- It validates the name against `DB_NAME_PATTERN` and refuses the server's
  own databases before any SQL runs.
- As the Dolt root user, over Dolt's own loopback, it runs only the
  statements still missing:
  `CREATE DATABASE IF NOT EXISTS`, `GRANT ALL PRIVILEGES ON name.*` to the
  writer, and `GRANT SELECT ON name.*` to the web reader and backup accounts.
  A second call changes nothing.
- It never drops anything. It refuses (409) a database that already holds
  data on which the writer lacks `ALL PRIVILEGES`, so it cannot be used to
  widen grants on projects it did not create.
- It logs every request, with the caller's login and node, as one JSON line.

A client command, `deno task new-project NAME PREFIX`, calls the helper and
then runs the normal `bd init --server --external` as the writer. The
operator SQL from `init-beads.sh --print-sql` uses the same grant list.

## Consequences

- A new project needs no operator and no new secret on workstations.
- On its own database the writer can create, alter and drop tables, and drop
  the database itself (`ALL` includes `DROP`; MySQL privileges cannot split
  dropping a table from dropping a database). Backups are the recovery path.
  It still cannot grant, write `mysql.*`, create databases or accounts, or
  read databases it was not granted.
- Any allowed device can create any number of databases. There is no quota.
- The helper holds the Dolt root password and can run commands in the Dolt
  container, which makes it the most privileged process reachable from the
  tailnet. It stays small, runs sandboxed under the host's service manager,
  and is reachable only on the tailnet port the operator's ACL allows.
- Existing projects keep the grants they have. Upgrading them to `ALL` (for
  future bd schema migrations) is an operator decision, not a helper call.
- Agents that reach only `beads:3306` cannot call the helper; they print the
  SQL with `new-project --print-sql` and an operator runs it.

## Alternatives considered

**Grant the writer more.** Data rights on `*.*` are root-equivalent, and
Dolt ignores wildcard database grants (Context). No grant shape lets a
non-administrator create a database and then work in it.

**Operator-run command with root credentials** (the first design). It
works, but every new project waits for the operator, and running it from a
workstation puts the root password there. It stays the fallback via
`--print-sql`.

**Project creation in the Beadsmith console.** The web process would need an
administrator Dolt credential. A server reachable from browsers is the
wrong place for one; [0003](./0003-dolt-read-plane.md) gives it a reader.

**A password or token on the helper.** One more secret to hand to every
machine and agent. The tailnet already authenticates devices, and
`tailscale whois` names the user or tags behind each one.

**Root over the published Dolt port.** Production creates root as
`root@localhost` only. Through Docker's published port Dolt sees the bridge
gateway, not localhost, so root is refused. The helper runs its SQL inside
the Dolt container (`docker exec`) over the container's loopback instead.

## Implementation notes

Removed with [0013](./0013-owner-account-and-global-readers.md); all paths
are at commit `aeb6fc4`:

- Helper: `scripts/project-helper.ts`, one file with no imports so a host
  could vendor it byte-identical. Environment `BEADS_PROJECT_HELPER_*`.
- Client: `scripts/new-project.ts` (`deno task new-project`).
- Tests: `scripts/project-helper.test.ts`, `scripts/new-project.test.ts`,
  and `scripts/ci/project-helper-smoke.sh` against a throwaway Dolt.
