# Backups

Beadsmith backs up every project database it can see to any S3-compatible
bucket: Railway Buckets, AWS S3, Cloudflare R2, Backblaze B2, MinIO, and
others. Configure it in **Console → Backups**; nothing else is needed. The
design and its trade-offs are in
[ADR-0010](../specs/decisions/0010-in-app-backups.md).

## What a backup contains

Each run reads every project database over Beadsmith's read-only SQL
connection, inside one read-only transaction per database, and writes:

```text
<prefix>/<run-id>/<database>.sql.gz        # or .sql.gz.enc with a passphrase
<prefix>/<run-id>/manifest.json            # written last; marks the run complete
```

The SQL holds `CREATE TABLE`/`CREATE VIEW` statements and every row. The
manifest records row counts per table, the Dolt HEAD commit, the Dolt
version, and a SHA-256 for each object. Run ids are UTC timestamps such as
`2026-10-17T01-02-03Z`.

Backups capture the **current state** of every table, which is everything
needed to rebuild each project. They do not capture Dolt commit history,
branches, or the server's SQL users; back up the Dolt data directory for
those.

## Set up

1. Create a bucket and a key that can read, write, list, and delete in it.
   For Railway:

   ```sh
   railway bucket create beads-backups --region sjc
   railway bucket credentials --bucket beads-backups
   ```

   Use `endpoint`, `bucketName`, `region`, and the two keys. Railway uses
   virtual-host addressing; MinIO usually needs path-style.

2. In **Console → Backups**, enter the endpoint, bucket, region, addressing
   style, keys, interval, and how many runs to keep. Optionally set an
   encryption passphrase (12+ characters).
3. **Save**, then **Test connection** (writes and deletes a probe object),
   then **Run now**. Turn on **Run on a schedule** for automatic runs.

The scheduler checks once a minute and runs when the interval has passed
since the last successful run, waiting at least 15 minutes after any attempt.
Retention keeps the newest N complete runs and deletes older ones; objects
whose names are not run ids are never touched.

## Secrets

Keys and the passphrase are write-only: the console shows whether each is
set and the last four characters of the access key id, never the values. They
are stored in `state.db` encrypted with AES-256-GCM under a master key:

- `BDX_SECRET_KEY_FILE`, if set: a file with 32 bytes (raw, hex, or base64).
  Create one with `openssl rand -base64 32 > secrets/master-key` and set
  `BDX_SECRET_KEY_FILE=/run/secrets/master-key` in `.env`.
- Otherwise `secret.key` in the state directory, generated on first use with
  mode `0600`.

Encryption at rest protects a copied `state.db`. It does not protect against
someone who controls the server. Losing the master key loses the saved
settings (re-enter them), not the backups.

**Keep the passphrase somewhere else.** Encrypted backups (PBKDF2-SHA256 +
AES-256-GCM) cannot be restored without it, and the server cannot recover it
from the bucket.

## Restore

Restore is a command, not a web action, because the web process has no write
access to Dolt. It needs a Dolt account that can create databases.

```sh
export BACKUP_S3_ENDPOINT=https://t3.storageapi.dev
export BACKUP_S3_BUCKET=beads-backups-xxxx
export BACKUP_S3_PREFIX=beadsmith
export BACKUP_S3_ACCESS_KEY_ID_FILE=./secrets/backup-access-key-id
export BACKUP_S3_SECRET_ACCESS_KEY_FILE=./secrets/backup-secret-access-key
export BACKUP_PASSPHRASE_FILE=./secrets/backup-passphrase   # encrypted runs only
export RESTORE_DOLT_HOST=127.0.0.1 RESTORE_DOLT_USER=root
export RESTORE_DOLT_PASSWORD_FILE=./secrets/dolt-root-password

pnpm run restore --list
pnpm run restore --run latest --dry-run       # download, verify, decrypt only
pnpm run restore --run latest                  # every database as <name>_restored
pnpm run restore --run 2026-10-17T01-02-03Z --database beads_web --suffix ''  --replace
```

Each database is restored under a new name (`<name>_restored` by default),
checked against the manifest's row counts, and committed with
`DOLT_COMMIT` on Dolt. An existing database is only dropped with
`--replace`. Every `*_FILE` variable also has a plain form
(`BACKUP_S3_ACCESS_KEY_ID`, …) for one-off use.

Without Beadsmith, a run is still usable by hand: download the objects,
decrypt if needed, `gunzip`, and pipe the SQL into `dolt sql` or `mysql`.
