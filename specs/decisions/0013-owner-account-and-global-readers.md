# 0013. Plain bd init on a single-owner server; readers see every database

Date: 2026-10-27

## Status

accepted. Supersedes [0012](./0012-project-helper.md). Amends the account
roles in [0003](./0003-dolt-read-plane.md).

Scope: a Dolt server that one person runs for their own machines, such as the
maintainer's. The default for public self-hosting, where agents get accounts
of their own, is still open.

## Context

The owner wants stock Beads behavior on the shared Dolt server:
`bd init --server --external … --database NAME` from their own machines,
with no extra step, and a new project that shows up in Beadsmith and in
backups without per-project grants.
[ADR 0012](./0012-project-helper.md) kept `beads_bd_writer` scoped to single
databases and added a root-side project helper to create them. The helper
was never deployed, so every new project still waited on the operator
pasting SQL as root.

Tested on a throwaway Dolt 2.1.8 (production's build) and 2.5.0 with
bd 1.1.0 (`scripts/ci/dolt-grants-smoke.sh`):

- No narrow grant lets an account create databases and then work in them.
  Dolt stores wildcard database grants (`` `bd\_%`.* ``) and ignores them,
  and creating a database gives its creator no rights on it.
- Data rights on `*.*` make an account an administrator. Even without
  `GRANT OPTION` it can `GRANT`, `CREATE USER`, change root's password and
  write `mysql.*`. `GRANT OPTION` adds nothing that it cannot already do.
- `SELECT ON *.*` includes `mysql.user`: unsalted `mysql_native_password`
  hashes (`*` plus `SHA1(SHA1(password))`) of every account. Dolt accepts
  `REVOKE SELECT ON mysql.*` after a global grant, with or without
  `partial_revokes`, and ignores it.
- With data rights on `*.*`, `bd init` in a repository with a git `origin`
  also adds that URL as a Dolt remote on the shared server, unless bd's
  `dolt.local-only` is set.
- `ALL PRIVILEGES` on single databases, without `GRANT OPTION`, keeps an
  account narrow: `bd init`, `bd create` and `bd ready` work on those
  databases, and nothing else does.

Accounts before this change: the owner's machines, and the agents that run
on them, use `beads_bd_writer`. Every project repository names it in its
checked-in `.beads/metadata.json`, and shell profiles and keychains use the
same name. Cursor Cloud agents also connected as `beads_bd_writer`, so
Cursor's secret store held its password. The owner is phasing Cursor Cloud
out. Beadsmith and its in-app backups read as
`beads_web_reader`. The host's restic job reads as `beads_backup`. Every one
of these had grants on single databases.

## Decision

- **The owner's account administers the server.** `beads_bd_writer` gets
  `ALL PRIVILEGES ON *.* WITH GRANT OPTION`. `bd init` creates the database
  itself. The grant includes `GRANT OPTION` because the account can grant
  anyway. Its password lives only on the owner's machines.
- **Readers see every database.** `beads_web_reader` and `beads_backup` get
  `SELECT ON *.*`, so Beadsmith and its backups pick up a new project
  without a grant.
- **Every SQL account has a long random password**, generated and never
  typed or reused: 32 or more characters from a password generator.
  Because readers can see the hashes, this condition is part of the
  decision, not advice.
- **Anything else gets an account of its own, scoped to projects.** An agent
  that does not run on the owner's machines, or another person, gets its
  own account with `ALL PRIVILEGES` on each project it needs and no
  `GRANT OPTION`. The owner adds a project with one line, through `bd sql`
  from any of their checkouts:
  `` GRANT ALL PRIVILEGES ON `NAME`.* TO 'ACCOUNT'@'%'; ``
  Such an account cannot create projects.
- **No git sync remotes on the shared server.** Each of the owner's machines
  sets `no-push: true` and `dolt.local-only: true` once in
  `~/.config/bd/config.yaml`. On the shared server, sync is live SQL.
- **Order on production:** first take every copy of the writer password off
  machines that are not the owner's: cut Cursor Cloud off from Dolt and
  rotate the password. Only then widen the grants.
- **The project helper is retired.** Its code is removed. The last version
  is at commit `aeb6fc4`.

## Consequences

- A new project takes one stock command, with no operator and no grant.
  Beadsmith lists it on its next catalog refresh, and the next in-app backup
  dumps it.
- Anything that holds the writer password can do anything on the Dolt
  server: drop any project, create accounts, lock out root. That covers the
  owner's shells and every local agent (Claude Code, Codex, ralphs). The
  real risk is a prompt-injected local agent. Backups are the recovery path.
  The password must never reach a third-party secret store, CI or a cloud
  VM; anything there gets an account of its own.
- **Readers can read password hashes.** The web process
  faces the internet and now can read `mysql.user`. We accept this because:
  - With 128 or more bits of random password, no offline attack recovers the
    password. The hashes are unsalted, but that only matters for guessable
    passwords.
  - The stored hash alone does not log in. A login proves knowledge of
    `SHA1(password)`, and getting that from the stored hash also needs a
    captured login handshake for the same account. The writer logs in over
    WireGuard (the tailnet) and root over the container's loopback.
  - The reader can already read every issue, which is what the database
    holds.
  The trade-off does not hold if any account has a chosen password. Rotate
  it first. Revisit when Dolt honors partial revokes (the smoke test prints
  a note when it does) or offers a salted password plugin.
- An account scoped to projects can drop tables on those projects and the
  databases themselves (`ALL` includes `DROP`). It cannot reach other
  projects, grant, or read or write `mysql.*`.
- Grants on single databases that the writer, reader and backup accounts
  already hold become redundant. They stay, so the change only adds grants.
- The host-level restic job lists its databases in the host's
  configuration, so it does not pick up a new project. The in-app backups
  ([0010](./0010-in-app-backups.md)) do, because they enumerate as the
  reader.
- Without the `dolt.local-only` setting, `bd dolt push` makes the server try
  to push to the repository's git host. That fails, because the server has
  no git credentials. It fails closed, but it is noise and a remote nobody
  wants on the shared server.
- This model does not suit a server shared by several people or untrusted
  agents. That case, per-agent accounts created from Beadsmith, is
  still open.

## Alternatives considered

**A new owner account, with the writer left narrow for other agents.** It
gives the same power. But every project repository's checked-in
`metadata.json` names `beads_bd_writer`, and so do the shell profiles and
keychain entries. Every one of those would change, and new projects would
name a different account than old ones. It touches more repositories for the
same result.

**Keep the project helper ([0012](./0012-project-helper.md)).** It keeps the
writer narrow, but it adds a command that stock bd does not have, and a
deployed service holding root that is reachable from the tailnet. The owner
does not want that step.

**Grant readers per database (the other fix for hv3.22).** The web process
could not read `mysql.user`, but every new project would need a grant again,
which is what this decision removes. A partial revoke of `mysql.*` would
combine both, but Dolt ignores it.

## Implementation notes

- Proof: [`scripts/ci/dolt-grants-smoke.sh`](../../scripts/ci/dolt-grants-smoke.sh)
  runs stock `bd init`, `bd create` and `bd ready` as the writer, Beadsmith's
  own discovery as the reader
  ([`scripts/ci/list-projects.ts`](../../scripts/ci/list-projects.ts)), and
  checks that an account scoped to projects stays narrow and that the
  trade-offs above still hold.
- Guide and account table: [`docs/new-project.md`](../../docs/new-project.md).
- Production grants are applied by the owner from a reviewed list. Nothing
  in this repository changes them.
- Row in [`specs/README.md`](../README.md).
