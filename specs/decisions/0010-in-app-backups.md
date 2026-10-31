# 0010. In-app backups to S3-compatible storage

Date: 2026-10-17

## Status

accepted

## Context

Beads issue data lives only in the Dolt server. Until now, off-machine
backup was one operator's VPS kit (systemd timer, restic, a cloud bucket),
which cannot ship in an open-source repository and does nothing for anyone
else running Beadsmith. The owner wants backups configured inside the app so
that nothing in the repository is specific to one deployment.

The web process already holds a read-only SQL credential that can see every
project database ([0003](./0003-dolt-read-plane.md)). Until this decision it
stored no secrets ([0004](./0004-service-local-sqlite.md)) and accepted no
credential entry from the browser (`docs/contract.md`).

Out of scope: Dolt-native backups (commit history, branches, the server's
user and privilege store). Those need filesystem access or `DOLT_BACKUP`
privileges on the Dolt host and remain the Dolt operator's job.

## Decision

We will make scheduled backups a Beadsmith feature. An operator configures an
S3-compatible destination in the console; the server dumps every discovered
project database through its read-only SQL access and uploads the result.

- **Capture.** Each run lists project databases, then dumps each one inside a
  read-only transaction as plain SQL: `CREATE TABLE`/`CREATE VIEW` from
  `SHOW CREATE`, then `INSERT` rows in batches. One statement per
  `;\n`-terminated chunk, with newlines escaped inside literals.
- **Package.** Each database becomes `<db>.sql.gz`, or `<db>.sql.gz.enc` when
  a passphrase is set: PBKDF2-SHA256 (600,000 iterations, per-object salt)
  derives an AES-256-GCM key. The passphrase is held by the operator; the
  server cannot decrypt a backup without it.
- **Layout.** `<prefix>/<run-id>/<db>.sql.gz[.enc]` plus
  `<prefix>/<run-id>/manifest.json` (format version, timestamps, Dolt
  version, per-database table row counts and HEAD commit when available,
  SHA-256 of each object). Run ids are UTC timestamps, so lexical order is
  chronological. Retention deletes whole runs beyond keep-N and never touches
  objects whose names are not run ids.
- **Transport.** A built-in AWS Signature Version 4 client (PUT, GET,
  ListObjectsV2, DELETE) over `fetch`, with virtual-host or path-style URLs
  and a configurable region. No SDK dependency.
- **Scheduling.** An in-process timer checks once a minute whether a run is
  due (interval in hours since the last successful run). The console also
  offers Run now and Test connection. One run at a time per process.
- **Secrets.** The access key, secret key, and passphrase may be entered in
  the console. They are encrypted at rest in `state.db` with AES-256-GCM
  under a 32-byte master key read from `BDX_SECRET_KEY_FILE`, or generated
  once (mode `0600`) as `secret.key` in the state directory when that
  variable is unset. The API never returns them; it reports only whether
  each is set and the last four characters of the access key id.
- **Restore.** `deno task restore` downloads a run, verifies checksums,
  decrypts, and loads each database into a Dolt server with a writer
  account supplied on the command line. Restore is deliberately not a web
  action.

## Consequences

Anyone running Beadsmith gets off-machine backups by filling in one form,
with Railway Buckets, AWS S3, R2, MinIO, or any other S3-compatible store.
The repository contains no deployment-specific backup tooling.

This changes two earlier rules. `state.db` now holds encrypted credentials
(still never Dolt passwords or Beads issue rows), and the console accepts
backup credential entry. Encryption at rest protects a copied `state.db`;
it does not protect against someone who controls the host, who can read the
master key too. Anyone with console access can change the destination, so
backup settings are admin-only once accounts are on
([0011](./0011-accounts-and-roles.md)); without accounts the single operator
is the admin.

Backups capture the current state of every table, not Dolt history. Losing
the master key loses the stored settings, not the backups; losing the
passphrase makes encrypted backups unrecoverable.

## Alternatives considered

**Keep backups outside the app (restic on the host).** Full Dolt fidelity,
but every operator must build their own kit, and the repository either ships
one person's infrastructure or nothing.

**Secrets as files only.** Keeps the no-secrets rule, but configuration is
then split between the console and the filesystem, which defeats the goal.

**Use the AWS SDK.** Large dependency tree for four requests; SigV4 is a
small, well-specified algorithm with published test vectors.

## Implementation notes

- Engine: `src/lib/server/backup/` (`s3.ts`, `dump.ts`, `crypto.ts`,
  `settings.ts`, `service.ts`, `scheduler.ts`).
- Secret box: `src/lib/server/secret-box.ts` (`BDX_SECRET_KEY_FILE`).
- State: `backup_runs` table and the `backup.config` setting
  (`src/lib/server/state/`).
- API: `src/routes/api/console/backups/` (GET/PUT settings, POST `run`,
  POST `test`). UI: Backups section of `src/routes/console/+page.svelte`.
- Restore: `scripts/restore-backup.ts` (`deno task restore`).
- Operator docs: `docs/backups.md`.
