# Sand: agents in E2B sandboxes

Sand runs Beadsmith's agents in hosted [E2B](https://e2b.dev) sandboxes
instead of on a machine you run. Each sandbox is its own Firecracker microVM
on E2B's side, so you need no KVM host, and nothing depends on your home
network. It is an alternative to a self-hosted runner, and the two can be
configured side by side: First Mate's **Runs on** picker chooses where new
work goes.

Sand serves two things:

- **Dispatch** (`BDX_DISPATCH_PROVIDER` includes `e2b`): every File, Tackle,
  comment and discuss mission gets a sandbox of its own. It joins your
  tailnet to reach Dolt with the project's own account, checks out the
  mapped repository, runs Claude Code headless, and pauses when it is done so
  a follow-up can continue the same session. Its event log streams into the
  agent thread live.
- **First Mate chats** (`BDX_MATE_RUNNERS` includes `e2b`): every chat gets a
  sandbox of its own, with model access and no tailnet, Dolt or repository
  access. What it can see and do in Beadsmith comes through crew tools that
  Beadsmith runs as the chat's owner
  ([ADR-0020](../specs/decisions/0020-first-mate-crew-tools.md)). It pauses
  when the chat goes quiet and resumes on the next message.

The decision and its rules are in
[ADR-0018](../specs/decisions/0018-sand-e2b-sandboxes.md). The sandbox scopes
come from [ADR-0015](../specs/decisions/0015-scoped-agent-sandboxes.md).

## What stays outside the sandbox

| Credential                              | Where it lives                                                             | Inside the sandbox                                               |
| --------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| E2B API key                             | A file on the Beadsmith host                                               | Nothing                                                          |
| Anthropic API key or Claude token       | A file on the Beadsmith host; E2B's egress adds it for `api.anthropic.com` | A placeholder (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`) |
| GitHub App private key                  | A file on the Beadsmith host                                               | Nothing                                                          |
| GitHub token (one repository, one hour) | Minted per run; E2B's egress adds it for `github.com` and `api.github.com` | A placeholder `GH_TOKEN`                                         |
| Tailscale OAuth client secret           | A file on the Beadsmith host                                               | Nothing                                                          |
| Tailscale auth key                      | Minted per run: single use, ephemeral, tagged, ten minutes                 | Consumed when the sandbox joins, then deleted                    |
| The project's Dolt account              | The accounts file on the Beadsmith host                                    | `BEADS_DOLT_*`: the one credential a sandbox holds               |

E2B's egress re-signs HTTPS with a CA it adds to the sandbox's system bundle;
the template points Node (Claude Code) at that bundle with
`NODE_EXTRA_CA_CERTS`.

## Set it up

### 1. E2B

1. Create an E2B team and an API key. Write the key to a file the Beadsmith
   service can read, for example `secrets/e2b-api-key` next to
   `compose.yaml` (`umask 077` first).
2. Build the template from a checkout of this repository, with the
   dependencies installed:

   ```sh
   E2B_API_KEY=$(cat secrets/e2b-api-key) node sandbox/e2b/build-template.ts
   ```

   It is named `beadsmith-agent` unless you pass a name (then set
   `BDX_E2B_TEMPLATE`). Rebuild after changing
   [`sandbox/e2b/`](../sandbox/e2b/); running sandboxes keep their build.

3. Write one model credential to a file: an Anthropic API key
   (`BDX_E2B_ANTHROPIC_API_KEY_FILE`) or a Claude subscription token from
   `claude setup-token` (`BDX_E2B_CLAUDE_OAUTH_TOKEN_FILE`). The API key wins
   when both are set.

That is all First Mate chats need: add `e2b` to `BDX_MATE_RUNNERS` and
restart. Their crew tools read and route todos with nothing more; the tools
that start missions use the configured dispatch provider, so dispatch (on Sand
or a webhook runner) must be set up for those. Dispatch on Sand needs the
next three steps too.

### 2. Tailnet (dispatch)

Mission sandboxes reach Dolt over your tailnet as ephemeral nodes tagged
`tag:beads-sandbox`. In the tailnet policy, own the tag and grant it Dolt's
port only:

```json
{
	"tagOwners": { "tag:beads-sandbox": ["autogroup:admin"] },
	"grants": [{ "src": ["tag:beads-sandbox"], "dst": ["tag:beads-sql"], "ip": ["tcp:3306"] }]
}
```

Nothing else grants `tag:beads-sandbox` a destination, and nothing grants
anyone access to it, so sandboxes cannot reach each other or your devices
(ADR-0015, rule 3).

Then create a Tailscale OAuth client with the **Auth Keys: write** scope,
restricted to `tag:beads-sandbox`. Put its id in
`BDX_E2B_TAILSCALE_OAUTH_CLIENT_ID` and its secret in a file
(`BDX_E2B_TAILSCALE_OAUTH_CLIENT_SECRET_FILE`). Beadsmith uses it to mint one
single-use key per run.

The sandbox runs `tailscaled` in userspace mode (no TUN device needed) and
forwards `127.0.0.1:3306` to `BDX_E2B_DOLT_TAILNET_HOST` (default `beads`)
for `bd`. E2B gives a sandbox only a link-local address, which `tailscaled`
treats as no network at all, so `beadsmith-run` first puts a private address
on the sandbox's unused `dummy0`. It then waits for Dolt's greeting before
starting the agent: the tailnet policy reaches the Dolt host a few seconds
after a new node joins. It also writes a server-mode `.beads/` into the
working directory when the checkout has none, because `bd` will not run
without one.

The template's `bd` must match the schema of the databases sandboxes open,
which may be older than the version `nix/overlay.nix` pins (see
`BD_VERSION` in [`sandbox/e2b/build-template.ts`](../sandbox/e2b/build-template.ts)).
A newer `bd` on an older schema fails with errors such as
`table not found: leases`.

### 3. Dolt accounts (dispatch)

Each project a sandbox may change needs an account of its own, with rights
on that database only. Never give a sandbox data rights on `*.*`: in Dolt
that makes an administrator
([ADR-0013](../specs/decisions/0013-owner-account-and-global-readers.md)).
As the owner account:

```sql
CREATE USER 'sbx_beads_web'@'%' IDENTIFIED BY '<long random password>';
GRANT ALL PRIVILEGES ON `beads_web`.* TO 'sbx_beads_web'@'%';
```

List them in a JSON file keyed by database name, and point
`BDX_E2B_DOLT_ACCOUNTS_FILE` at it:

```json
{ "beads_web": { "user": "sbx_beads_web", "password": "<long random password>" } }
```

A project without an entry cannot launch on Sand; its missions fail with a
message saying so. Passwords must be at least 16 characters, and long random
ones are the rule here because readers can see `mysql.user`.

### 4. GitHub (dispatch with checkouts)

Missions with a checkout (Tackle, and File or discuss when a checkout is
mapped) need a GitHub App:

1. Create an App with repository permissions **Contents: read and write**,
   **Pull requests: read and write** and **Metadata: read**. No webhook is
   needed.
2. Install it on the repositories you map for Tackle, and protect their
   default branches so agents can only propose changes.
3. Put the App id in `BDX_E2B_GITHUB_APP_ID` and its private key in a file
   (`BDX_E2B_GITHUB_APP_PRIVATE_KEY_FILE`).

For each run Beadsmith mints an installation token for that one repository:
contents and pull requests when the run may open a PR, contents read-only
otherwise. Without the App, missions without a checkout still run on Sand.

### 5. Turn it on

```sh
BDX_DISPATCH_PROVIDER=webhook,e2b     # or just e2b
BDX_MATE_RUNNERS=remote,e2b           # or just e2b
BDX_E2B_API_KEY_FILE=/run/secrets/e2b-api-key
BDX_E2B_ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic-api-key
BDX_E2B_DOLT_ACCOUNTS_FILE=/run/secrets/e2b-dolt-accounts.json
BDX_E2B_TAILSCALE_OAUTH_CLIENT_ID=...
BDX_E2B_TAILSCALE_OAUTH_CLIENT_SECRET_FILE=/run/secrets/tailscale-oauth-secret
BDX_E2B_GITHUB_APP_ID=...
BDX_E2B_GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app.pem
```

Restart the service. The console's Dispatch row lists each runner, or says
why one is inactive. With more than one place to run, First Mate's start
screen shows **Runs on**.

## Configuration

| Variable                                      | Meaning                                                                                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BDX_E2B_LABEL`                               | Name shown for Sand. Default `Sand`.                                                                                                                              |
| `BDX_E2B_API_KEY_FILE`                        | E2B API key. Required.                                                                                                                                            |
| `BDX_E2B_TEMPLATE`                            | Template name or id. Default `beadsmith-agent`.                                                                                                                   |
| `BDX_E2B_ANTHROPIC_API_KEY_FILE`              | Anthropic API key, or                                                                                                                                             |
| `BDX_E2B_CLAUDE_OAUTH_TOKEN_FILE`             | a Claude subscription token. One is required.                                                                                                                     |
| `BDX_E2B_ALLOW_OUT`                           | Optional comma list of hosts (or `*.domain`) a sandbox may reach; replaces the default `*` (HTTP and HTTPS to any named host). Tailscale needs `*.tailscale.com`. |
| `BDX_E2B_DOLT_ACCOUNTS_FILE`                  | Dispatch: per-project Dolt accounts (above). Required for dispatch.                                                                                               |
| `BDX_E2B_TAILSCALE_OAUTH_CLIENT_ID`           | Dispatch: Tailscale OAuth client id. Required for dispatch.                                                                                                       |
| `BDX_E2B_TAILSCALE_OAUTH_CLIENT_SECRET_FILE`  | Dispatch: its secret. Required for dispatch.                                                                                                                      |
| `BDX_E2B_TAILSCALE_TAGS`                      | Dispatch: tags sandboxes join with. Default `tag:beads-sandbox`.                                                                                                  |
| `BDX_E2B_DOLT_TAILNET_HOST` / `_PORT`         | Dispatch: Dolt as sandboxes reach it on the tailnet. Default `beads`, `3306`.                                                                                     |
| `BDX_E2B_GITHUB_APP_ID` / `_PRIVATE_KEY_FILE` | Dispatch: GitHub App for checkouts. Both or neither.                                                                                                              |
| `BDX_E2B_MAX_RUN_MINUTES`                     | Dispatch: a run's time limit. Default 55 (E2B's free plan stops a sandbox after an hour).                                                                         |
| `BDX_E2B_IDLE_MINUTES`                        | Dispatch: how long a finished mission waits for a follow-up before pausing. Default 10.                                                                           |
| `BDX_E2B_MATE_IDLE_MINUTES`                   | Chats: how long a quiet chat's sandbox stays up before pausing. Default 15.                                                                                       |
| `BDX_E2B_MATE_MAX_SESSIONS`                   | Chats: live chat processes at once; idle ones are stopped to make room. Default 3.                                                                                |

Secrets are read when used and never stored in `state.db`, logged or sent to
the browser. A missing required setting leaves that use of Sand inactive, and
the console says so (`E2B settings are incomplete`).

## How a mission runs

1. Beadsmith checks the project's Dolt account, mints the GitHub token (if
   there is a checkout) and creates the sandbox with the egress rules,
   placeholders and the project's Dolt settings. Its agent id is the sandbox
   id; runs are `r1`, `r2`, and so on.
2. It writes the prompt to `~/.beadsmith/runs/r1/prompt` and starts
   [`beadsmith-run`](../sandbox/e2b/beadsmith-run) with a fresh Tailscale
   key. The script joins the tailnet, opens the Dolt forward, clones the
   checkout and runs `claude -p --output-format stream-json`.
3. Beadsmith reads the run's files for status, and tails its event log for
   the thread's live view (text, thinking and tool names only; never tool
   inputs or output).
4. When the run ends, the sandbox's timeout drops to the idle time, then it
   pauses. A follow-up resumes it, refreshes the GitHub token and starts the
   next run with `--continue`. Cancel stops the run's process group.
5. A run still working at the time limit pauses with the sandbox and is
   reported failed. A follow-up resumes the sandbox, stops that run and
   continues.

## How a chat runs

The chat runner is the mate runner's own core
([`src/lib/mate-runner/`](../src/lib/mate-runner/)) running inside
Beadsmith, with an E2B spawner instead of SSH. The sandbox is found again by
the chat's session id. Claude Code runs in `/home/user/mate`. Chat logs live
under `<state dir>/sand-mate`. Deleting a chat deletes its sandbox; if E2B
cannot be reached, the chat stays so the delete can be retried.

On every create and resume, Beadsmith writes First Mate's standing
instructions (`AGENTS.md`) and the crew tools relay (`.crew/relay.cjs` and
`.crew/mcp.json`) into that directory, so changing them needs no template
rebuild. It starts the relay's serve side over the E2B commands API, then
Claude Code with `--mcp-config`; Claude Code starts the relay's stdio side
as an MCP server. A tool call travels as a JSON line over a unix socket to
the serve side, out on its stdout to Beadsmith, and the reply comes back on
its stdin. Beadsmith runs the call as the chat's owner, looked up from the
session on every call, so a deleted chat or a banned owner gets nothing. The
relay is restarted if it exits (five times per chat process) and stopped
with Claude Code. No token or address in the sandbox reaches Beadsmith any
other way ([ADR-0020](../specs/decisions/0020-first-mate-crew-tools.md)).

E2B errors and the end of Claude Code's stderr, when it exits badly, go to
Beadsmith's server log with credential shapes stripped; the browser only
sees a fixed message. Mission sandboxes do the same for a failed run's
`stderr.log` and `setup.log`.

## Costs and limits

- E2B bills running sandboxes per second. Paused ones are not billed for
  compute and E2B keeps them until they are deleted; whether it charges for
  their storage is not documented. Deleting a chat deletes its sandbox. A
  finished mission's sandbox stays paused (so follow-ups work) until you
  delete it in E2B's dashboard.
- E2B's free plan stops a sandbox after one hour of continuous running;
  pausing resets that. Raise `BDX_E2B_MAX_RUN_MINUTES` only on a plan that
  allows longer.
- E2B's header injection is in public beta and applies to HTTPS on port 443.

## Before relying on it

Checked against the live services:

- Claude Code reaches the model through E2B's egress, with the placeholder
  replaced.
- `tailscaled` in userspace mode joins through E2B's egress (relayed over
  DERP on 443), and `bd` reaches Dolt through the local forward and targets
  the project with `BEADS_DOLT_SERVER_DATABASE`.

Not yet checked:

- `git clone` and `gh pr create` work with the injected GitHub headers.
- A paused chat resumes and continues its Claude Code session.
- The crew relay in a real chat sandbox. It is unit-tested with fakes and the
  relay script under local Node only. To check it: start a Sand chat and ask
  First Mate to list its `mcp__crew__` tools and run `list_projects`; kill
  the relay's serve process from E2B's CLI and confirm the next tool call
  still answers (Beadsmith restarts serve, the stdio side reconnects); let
  the chat pause, send a message, and confirm `.crew/` and `AGENTS.md` are
  rewritten and tools answer again.

A failed setup step shows in the thread by name (joining the tailnet,
reaching Dolt, cloning). `~/.beadsmith/runs/<run>/setup.log` and
`stderr.log` in a mission's sandbox, and
`~/.beadsmith/tailscale/tailscaled.log`, say what went wrong. Open them from
E2B's dashboard or CLI; the mission's agent id is the sandbox id.
