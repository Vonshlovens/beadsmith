# Create a new Beads project

On a Dolt server that one person runs for their own machines, a new Beads
project is a plain `bd init`. The account those machines use can create
databases, and Beadsmith and its backups read every database, so nothing
else has to happen ([ADR-0013](../specs/decisions/0013-owner-account-and-global-readers.md)).

## Once per machine

1. **Password.** bd sends `BEADS_DOLT_PASSWORD` if it is set. Otherwise it
   reads `~/.config/beads/credentials`, one section per server:

   ```ini
   [DOLT_HOST:3306]
   password=...
   ```

2. **No git sync remote.** On a shared server, sync is the live SQL
   connection. Tell bd not to wire the repository's git `origin` into the
   server as a Dolt remote, and not to push, in `~/.config/bd/config.yaml`:

   ```yaml
   no-push: true
   dolt:
     local-only: true
   ```

   Without this, `bd init` in a repository with a git `origin` adds that URL
   as a Dolt remote on the server, and `bd dolt push` then fails on the
   server for lack of git credentials.

## New project

From the root of the repository that should get Beads:

```sh
bd init --server --external --non-interactive --server-host DOLT_HOST \
  --server-port 3306 --server-user beads_bd_writer --database NAME --prefix PREFIX
```

- `NAME` is the database. Use 1–64 characters of `a-z`, `0-9` and `_`
  (`my_project`): Beadsmith reads only such names, and never `mysql`,
  `information_schema`, `performance_schema`, `sys` or `dolt_*`.
- `PREFIX` is the issue prefix: `a-z`, `0-9` and `-` (`my-project`).

bd creates the database, its tables and `.beads/`, adds agent instructions
and hooks, and may commit them to git. Then `bd ready` works. Beadsmith lists
the project on its next catalog refresh, and the next scheduled backup
includes it.

Do not run `bd dolt start` or fall back to an embedded database: either one
starts a local Dolt instead of using the shared server.

On a server whose writer account is still scoped to single databases, the
owner creates the project first, as root on the Dolt server:
`CREATE DATABASE NAME;`,
`GRANT ALL PRIVILEGES ON NAME.* TO 'beads_bd_writer'@'%';` and
`GRANT SELECT ON NAME.* TO` the reader accounts (Beadsmith's and the
backup's). Then run `bd init` as above.

### When bd init stops

| Message                                                     | Meaning                                                                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed to create database: … command denied to user '…'`   | This account cannot create databases: it is scoped to projects, or the server still has the old grants. The owner creates the project from their own machine. |
| `Access denied for user '…'` (1045)                         | Wrong password, or the user in `metadata.json` or `BEADS_DOLT_SERVER_USER` is not the one the password belongs to.                                            |
| `pending schema migrations alter pre-existing dirty tables` | An earlier `bd init` stopped halfway ([gastownhall/beads#4566](https://github.com/gastownhall/beads/issues/4566)). See below.                                 |

**A `bd init` that stopped halfway** leaves uncommitted tables, and the next
one refuses to migrate them. The `bd dolt commit` it suggests fails, because
no `.beads` config exists yet, and `bd sql` fails the same way, because bd
migrates before it runs any SQL. Commit the working set with a plain SQL
client as `beads_bd_writer`, then run `bd init` again:

```sql
USE NAME;
CALL DOLT_COMMIT('-Am', 'Commit the working set an unfinished bd init left');
```

For example with the Dolt CLI:
`dolt --host DOLT_HOST --port 3306 --user beads_bd_writer --no-tls --use-db NAME sql -q "CALL DOLT_COMMIT('-Am', '…')"`.

## Agents that are not the owner's

An agent that does not run on the owner's machines, or another person, gets
an account of its own, scoped to projects: `ALL PRIVILEGES` on each project
it needs, and no `GRANT OPTION`. It works in those projects with stock bd,
and cannot create projects, reach others, grant, or touch `mysql.*`. The
owner creates the account once with a generated password and the first
grant. Then they add each project with one line, from any of their
checkouts:

```sh
bd sql "GRANT ALL PRIVILEGES ON \`NAME\`.* TO 'ACCOUNT'@'%'"
```

Point the agent at the account with `BEADS_DOLT_SERVER_USER`, which wins
over the user `metadata.json` names, and its password. Never give it the
owner's password.

**A new project from such an agent.** It cannot run the `CREATE DATABASE`
that `bd init` needs, so the owner creates the empty database and grants it
first:

```sh
bd sql "CREATE DATABASE IF NOT EXISTS \`NAME\`"
bd sql "GRANT ALL PRIVILEGES ON \`NAME\`.* TO 'ACCOUNT'@'%'"
```

Then the agent runs the `bd init` above with `--server-user ACCOUNT`: bd
finds the database and only creates its tables. `bd init` writes `ACCOUNT`
into `metadata.json`. If the owner's machines will use the repository too,
run `bd dolt set user beads_bd_writer` afterwards; on the agent,
`BEADS_DOLT_SERVER_USER` still selects its own account.

## Accounts on the server

| Account            | Grant                                       | Used by                                              |
| ------------------ | ------------------------------------------- | ---------------------------------------------------- |
| `beads_bd_writer`  | `ALL PRIVILEGES ON *.* WITH GRANT OPTION`   | The owner's machines and the agents that run on them |
| `beads_web_reader` | `SELECT ON *.*`                             | Beadsmith: catalog, pages and in-app backups         |
| `beads_backup`     | `SELECT ON *.*`                             | A host-level backup job                              |
| per agent          | `ALL PRIVILEGES ON NAME.*` for each project | Agents that are not the owner's, other people        |
| `root@localhost`   | everything                                  | Break-glass, from the Dolt host only                 |

Two things follow, and both are deliberate:

- `beads_bd_writer` is an administrator in practice: with data rights on
  `*.*` it can grant, create accounts and change root's password. Keep its
  password on the owner's machines only, never in a cloud agent, CI or a
  third-party secret store.
- `SELECT ON *.*` includes `mysql.user`, so Beadsmith can read every
  account's password hash. Dolt ignores `REVOKE SELECT ON mysql.*` after a
  global grant. Give every account a long random password (32 or more
  characters from a generator), which makes the hashes useless offline.

## Testing

```sh
scripts/ci/dolt-grants-smoke.sh
DOLT_IMAGE=dolthub/dolt-sql-server:2.5.0 scripts/ci/dolt-grants-smoke.sh
```

The script starts a throwaway Dolt container (production's 2.1.8 image by
default) with these accounts. It runs stock `bd init`, `bd create` and
`bd ready` as the writer, and Beadsmith's own discovery as the reader. It
checks that an account scoped to projects stays narrow and that the
trade-offs above still hold on that Dolt version.
