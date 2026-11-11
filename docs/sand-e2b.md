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

## Inbound access

Every new mission and chat explicitly sets `network.allowPublicTraffic=false`
in the shared [E2B driver](../src/lib/server/e2b/sandbox.ts), independently of
the E2B project's default. A service started inside a sandbox therefore
requires that sandbox's traffic access token at its public URL. Requests
without the `e2b-traffic-access-token` header return `403`. Authenticated SDK
commands, file access and agent streams keep working; the outbound allowlist
and credential header injection are separate and unchanged.

Beadsmith does not publish sandbox services or expose traffic access tokens
to the browser. Keep those tokens in trusted operator tooling only; never
print them, put them in URLs, or include them in logs. See
[E2B's public access documentation](https://docs.e2b.dev/network/restrict-public-access).

### Existing sandboxes

Changing the creation policy or the project's default does **not** change
existing sandboxes. Running, paused, resumed and forked sandboxes retain their
original ingress setting; pausing or forking a public sandbox does not fix it.

After upgrading, inventory all running **and paused** sandboxes with metadata
`beadsmith=1`. With the E2B SDK, use `Sandbox.list` with
`query: { metadata: { beadsmith: '1' }, state: ['running', 'paused'] }` and
consume every page. Check `network.allowPublicTraffic` on each sandbox's
`Sandbox.getInfo` result. An absent setting is unknown, not evidence that
access is private. Do not print the full SDK objects: network rules can
contain injected credentials.

For a public sandbox, first match its metadata to the mission or chat and
check for active work. Let active work finish or arrange an interruption,
then export any needed files and session state to protected operator
storage. Mission state includes the checkout, uncommitted changes and
`~/.beadsmith/runs`; chat state includes `/home/user/mate` and Claude's
session files under `~/.claude`. Preserve Beadsmith's state database and
`<state dir>/sand-mate` logs too. These exports can contain project data or
credentials and must stay out of Git and public logs.

Create a fresh private sandbox and restore the needed state, verifying the
chat's session metadata or the mission's agent mapping and continuation
before retiring the old instance. If continuation is unnecessary, retire
the old sandbox only after confirming that its work and state are retained
elsewhere. Do not silently delete a chat or kill a sandbox to force
recreation: that can discard state, break follow-ups or interrupt an agent.

Verify a fresh sandbox with a harmless HTTP server: its public URL must
return `403` without the traffic token and succeed with the token in a
trusted server-side request. Also verify SDK command/file access and an
agent turn through the existing egress policy. Clean up the probe afterwards
and record the results and inventory counts in private operator records,
without tokens, credentials or full network configuration.

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
   [`sandbox/e2b/`](../sandbox/e2b/),
   [`src/lib/server/e2b/image.ts`](../src/lib/server/e2b/image.ts), the hc
   pin in [`nix/herdr-core.json`](../nix/herdr-core.json) or the ralph pin
   in [`nix/ralph.json`](../nix/ralph.json); running sandboxes keep their
   build. A template without ralph fails loop missions with a message
   saying to rebuild. **Rebuild now if your template predates hc** (see
   [Terminals](#terminals-hc)): the current `beadsmith-run` starts an hc core
   and stops with "could not start its terminal server" on an older build.

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
   **Pull requests: read and write**, **Checks: read**, **Commit statuses:
   read** and **Metadata: read**. No webhook is needed. Adding a permission
   to an existing App takes effect only once each installation accepts it;
   until then GitHub refuses Beadsmith's token requests and missions with a
   checkout fail to launch.
2. Install it on the repositories you map for Tackle, and protect their
   default branches so agents can only propose changes.
3. Put the App id in `BDX_E2B_GITHUB_APP_ID` and its private key in a file
   (`BDX_E2B_GITHUB_APP_PRIVATE_KEY_FILE`).

For each run Beadsmith mints an installation token for that one repository:
contents and pull requests when the run may open a PR, both read-only
otherwise (so a discussion can still ask `gh` whether a PR merged), plus
checks and commit statuses read-only for `gh pr checks`. Without
the App, missions without a checkout still run on Sand. A mission without a
checkout gets no GitHub token and no `GH_TOKEN`, so `gh` reports it is not
logged in rather than sending a placeholder GitHub rejects as bad
credentials. Map a File or Tackle checkout for a project whose agents should
see its pull requests.

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
| `BDX_E2B_MATE_MAX_SESSIONS`                   | Chats: live chat CLIs at once; idle ones are stopped to make room. Default 3.                                                                                     |

Secrets are read when used and never stored in `state.db`, logged or sent to
the browser. A missing required setting leaves that use of Sand inactive, and
the console says so (`E2B settings are incomplete`).

## Terminals (hc)

Missions and chats run interactive Claude Code in an
[hc](https://github.com/herdrdev/herdr-core) terminal
([ADR-0021](../specs/decisions/0021-hc-terminal-runtime.md)). The template
carries what the terminals need:

- `hc`, the version and `linux-x86_64` SHA-256 pinned in
  [`nix/herdr-core.json`](../nix/herdr-core.json) (the same file the Nix
  overlay reads for the forge guest). The build downloads the release
  tarball and refuses it unless the hash matches. Nothing in a sandbox runs
  `hc update`; a bump is a reviewed change to the pin, then a rebuild.
- `~/.config/herdr-core/config.toml` with `notes = false`, so hc never types
  into an agent on its own.
- Claude Code's first-run answers (onboarding, folder trust for
  `~/.beadsmith/work` and `~/mate`, the placeholder API key, the
  bypass-permissions warning), from
  [`src/lib/server/e2b/image.ts`](../src/lib/server/e2b/image.ts), so a
  launch reaches the prompt without a keypress.
- `beadsmith-hc connect`
  ([`sandbox/e2b/beadsmith-hc.cjs`](../sandbox/e2b/beadsmith-hc.cjs)): `hc
connect` with its binary frames carried as base64 lines, because the E2B
  SDK hands command output to Beadsmith as text.

`beadsmith-run` starts the core (`hc server start`) once setup is done, so
terminals inherit the sandbox's Dolt forward and environment; a setup that
cannot start it fails with exit code 14. The core runs as the sandbox's
user on hc's default Unix socket, in a 0700 directory. No port is opened and
nothing outside the sandbox speaks hc except Beadsmith, through the E2B
process channel (ADR-0021 rule 1).

Live check after a rebuild (not yet run):

1. Start a Sand mission. In the sandbox (E2B CLI or dashboard terminal), run
   `hc --version` (the pinned version), `hc server status` (a core with
   uptime); the socket's directory (`$XDG_RUNTIME_DIR/herdr-core`,
   `/run/user/$(id -u)/herdr-core` or `~/.local/state/herdr-core/default`,
   whichever exists) is mode `drwx------`, and `ss -ltnp` lists no port
   owned by hc.
2. In the mission's checkout, `hc run --bg claude` and then `hc get <t>`:
   the terminal reaches `idle` with app `claude-code` (Claude Code reports
   OSC 7501) and never `blocked` on a dialog. `hc ls` shows the terminal;
   `hc kill <t>` ends it.
3. From the same sandbox, `printf '' | beadsmith-hc connect; echo $?` exits
   0, and `echo 'not base64!' | beadsmith-hc connect; echo $?` exits 2.

4. Start a Tackle mission and watch its thread: the live view shows tool
   calls and text, the run ends `succeeded` with the agent's summary (and PR
   link), and `hc ls` in the sandbox lists one live terminal labelled
   `beadsmith-session=<the sandbox's beadsmith_session metadata>` that stays
   up after the turn. `~/.beadsmith/runs/r1/` holds `ready`, `claim/`,
   `turn.json` and `result.json`.
5. Send a follow-up: `hc ls` still shows the same terminal (no new one), and
   the reply arrives in the thread. Let the sandbox pause (idle timeout),
   send another: it resumes with the same terminal.
6. Cancel a working run: the terminal finishes (`hc ls --all`), the thread
   says cancelled, and the next follow-up starts a new terminal running
   `claude --resume <session id>` that remembers the conversation.

Steps 4 to 6 are unit-tested against a fake hc core and a fake sandbox
([`e2b-provider.test.ts`](../src/lib/server/dispatch/e2b-provider.test.ts));
they have not been run against E2B yet.

### Admin terminal relay

An admin can watch a Sand mission's or chat's agent terminal, or take it
over, through `POST /api/console/terminals`
([contract](contract.md#http-and-ui-boundary), ADR-0021 rule 4). Beadsmith opens a
fresh `beadsmith-hc connect` over the E2B process channel for each relay and
calls `terminal.attach` on the agent's terminal (the mission's or chat's
`beadsmith-session` label, or a loop's `ralph-loop`), `observe` when
watching. Nothing in the sandbox changes for it. Watching never resumes a
paused sandbox; taking over does. Every attach is a row in
`terminal_relay_sessions` in `state.db`; the bytes are not kept anywhere.

In the app, admins open it from the **Terminal** strip in a Sand mission's
thread or a Sand chat
([`terminal-view.svelte`](../src/lib/components/terminal-view.svelte); keys
in [keyboard.md](keyboard.md#agent-terminal)). The strip appears only where
the runner relays a terminal (the `terminal` capability on dispatch
providers and chat runners).

Operator check (not yet run against E2B; the routes are unit-tested against
a fake hc core in
[`server.test.ts`](../src/routes/api/console/terminals/server.test.ts), and
the browser side's states and reconnects against a fake server in
[`terminal-relay.test.ts`](../src/lib/client/terminal-relay.test.ts)):

1. With a Sand mission running, as an admin in the browser's devtools
   console on Beadsmith, `fetch('/api/console/terminals', { method: 'POST',
headers: { 'content-type': 'application/json', 'x-bdx-request': '1' },
body: JSON.stringify({ mission: '<dq_ id>', mode: 'watch', cols: 120,
rows: 40 }) })` and read the body: an `open` frame, then `output` frames
   whose base64 decodes to Claude Code's screen. Typing to the relay id
   answers 409.
2. The same with `mode: 'take_over'`, then post `{ data: btoa('/help\r') }`
   to `/api/console/terminals/<relay>`: Claude Code shows its help in the
   stream and in `hc read <terminal>` inside the sandbox.
3. Let the sandbox pause and watch again: 409 saying it is paused, and the
   sandbox stays paused in E2B's dashboard.
4. `SELECT * FROM terminal_relay_sessions ORDER BY started_at DESC` in
   `state.db` lists both attaches with your email, their mode, and an end
   time once each stream closed.
5. In the app, open the mission's thread: **Watch** shows Claude Code's
   screen and follows its size; **Take over…** asks first, then resizes it
   to the box and takes keys (Esc interrupts the agent, Shift+Esc leaves the
   terminal); **Hand back** returns to watching. Switch themes and narrow
   the window below 640px: the screen stays dark and Take over disappears.
   Stop the network for a few seconds: the strip says Reconnecting… and
   comes back.

## How a mission runs

1. Beadsmith checks the project's Dolt account, mints the GitHub token (if
   there is a checkout) and creates the sandbox with the egress rules,
   placeholders and the project's Dolt settings. Its agent id is the sandbox
   id; runs are `r1`, `r2`, and so on.
2. It writes the prompt to `~/.beadsmith/runs/r1/prompt` and the dispatch
   skills (`.agents/skills/{file,tackle,comment,discuss}`, bundled into the
   server at build time) to `~/.beadsmith/skills/`, then starts
   [`beadsmith-run`](../sandbox/e2b/beadsmith-run) with a fresh Tailscale
   key. The script joins the tailnet, opens the Dolt forward, clones the
   checkout, installs any skill the checkout lacks under `.agents/skills/`
   (excluded from git), starts the sandbox's hc core and writes `ready`.
3. The first status read or live stream that sees `ready` claims the start
   (`mkdir claim`, atomic, so two requests never send the prompt twice).
   It connects to hc through `beadsmith-hc connect`, launches Claude Code in
   a terminal (`claude --session-id <id>`, the id kept in the sandbox's
   `beadsmith_session` metadata), sends the prompt with `terminal.send` and
   writes the turn's start (hc's turn counter and the transcript line) to
   `turn.json`. Nobody needs to stay connected: the CLI works on in its
   terminal.
4. Status reads and the thread's live view attach the session core
   ([`src/lib/agent-session/`](../src/lib/agent-session/)) to that turn. It
   reads Claude Code's own transcript with `file.read` (text, thinking and
   tool names only; never tool inputs or output) and decides the turn is
   over from hc's turn counter and status. The first to see the end writes
   `result.json`; later reads use it without touching hc.
5. When the run ends, the sandbox's timeout drops to the idle time, then it
   pauses, with the CLI still in its terminal. A follow-up resumes it,
   refreshes the GitHub token, runs setup again for the tailnet, and sends
   the next message to the same CLI. If the terminal is gone, it starts
   `claude --resume <id>` first. Cancel marks the run cancelled and ends the
   CLI (`terminal.kill`); during setup it stops the setup script instead.
   With the CLI gone, it records the transcript's length as the run's `end`,
   so replaying the cancelled run's thread stops there even after a
   follow-up writes to the same transcript. Each start also records the
   transcript's length as `start-line` when it claims the start, before it
   touches the CLI; a run with no `end` (stopped before this existed, or
   with hc unreachable) is cut at the first later `start-line`.
6. A run still working at the time limit pauses with the sandbox and is
   reported failed. A follow-up resumes the sandbox, ends that turn's CLI
   and continues in a resumed one.

## How a loop runs

A loop mission ([ADR-0019](../specs/decisions/0019-ralph-loops-and-automations.md),
[dispatch API](file-tackle-dispatch.md)) runs
[ralph](https://github.com/Vonshlovens/von-ralph) in a sandbox of its own.
The template installs ralph from its public repository at the commit pinned
in [`nix/ralph.json`](../nix/ralph.json), with its production dependencies
from its own lockfile; the build fails if the commit does not report the
pinned version. The checkout must already be a ralph project
(`.ralph/ralph.toml`) for `build`, `plan` and `reverse`; `run` needs none.

1. Beadsmith creates the sandbox as for a mission, with a write-scoped
   GitHub token at the egress (every loop mode writes) and E2B told to
   destroy it, not pause it, on timeout. It writes ralph's command line to
   `~/.beadsmith/runs/r1/loop.json` and starts `beadsmith-run r1`, the same
   setup as a mission's. The sandbox's `beadsmith_loop` metadata holds
   ralph's run name.
2. The first status read or stream that sees `ready` claims the start and
   opens two hc terminals in the checkout: `ralph serve --no-web` (named
   `ralph-serve`, on 127.0.0.1:7420 only) and `ralph <mode> --name … --max …`
   (named `ralph-loop`), then writes `started`. Both take the hc core's
   environment, so the loop has the project's Dolt account and the
   placeholders and nothing else. ralph runs each iteration's agent in hc
   terminals of its own.
3. Status reads ask ralph for the run and its iterations with `curl` to
   loopback over the E2B process channel
   ([`ralph-transport.ts`](../src/lib/server/e2b/ralph-transport.ts));
   finished iterations are copied into `state.db`. The live view follows
   ralph's event stream the same way and maps it onto the thread. If
   `ralph serve` stops answering, the next read starts it again. Each read
   that finds ralph alive with more iterations finished than at the last
   extension gives the sandbox `BDX_E2B_MAX_RUN_MINUTES` again from now
   (the first read after Beadsmith starts counts too). GitHub installation
   tokens last an hour, so a read of a running loop whose token is 45
   minutes old mints a new one (same repository, same write scope) and
   replaces the egress rules with it; the sandbox still sees only the
   placeholder. Beadsmith keeps the mint time in memory, so the first read
   after it restarts mints one too, and a refresh that fails is logged and
   tried on the next read. Beadsmith's background follower keeps reading a
   loop until it ends, so both happen with no browser open.
4. When ralph's run ends, its stop reason (or, without one, the loop
   terminal's exit code) decides the mission's status, and the report's
   iteration count, duration and notes for a person become the summary. The
   result goes to `result.json`, and the sandbox's timeout drops to the idle
   time, after which E2B destroys it.
5. Cancel marks the run cancelled, asks ralph to stop now, and ends the loop
   terminal. A loop takes no follow-up.
6. A steer note from the thread goes to ralph's `POST /v1/runs/<name>/steer`
   and Stop after iteration to its `/stop` with `graceful: true`, both over
   the same channel; ralph reads them between iterations. Neither reaches a
   loop still in setup or already ended (`409`).
7. Restart on an ended loop starts the next run (`r2`, `r3`, …). While E2B
   still has the sandbox (the idle time after the loop ended), it runs
   there: the checkout and anything not pushed are kept, the sandbox gets a
   fresh GitHub token and the full run limit again, `beadsmith-run r2`
   rejoins the tailnet, and the first reader starts a terminal named
   `ralph-loop-r2` running ralph under the name `<metadata name>-r2`, so
   ralph's record of the earlier run and hc's finished `ralph-loop` stay
   apart. A run the sandbox still counts as working is stopped first. Once
   E2B has destroyed the sandbox, the run starts in a fresh one from the
   project's current Tackle checkout, numbered on from the last run; the
   mission follows the new sandbox id. Either way the iterations of each run
   are stored under its own run id.

So a loop can run for longer than `BDX_E2B_MAX_RUN_MINUTES` in total, but
each iteration has to fit in it: an iteration still going a full run limit
after the last one finished (or after the loop started) is destroyed with
its sandbox and reported failed, and anything it had not pushed is lost.
Keep ralph's iteration timeout below the run limit. E2B's own cap on
continuous running (an hour on the free plan) still ends the sandbox,
whatever Beadsmith asks for. The reads come from a follower Beadsmith keeps
in memory; when Beadsmith starts it follows every mission still launched or
running again, so a restart mid-loop costs at most the reads it missed while
it was down.

Loop sandboxes are destroyed, not paused, on timeout. Pausing would keep a
stuck loop's disk, but a resumed sandbox has lost its tailnet node and the
agent's open model connection mid-iteration, and nothing would resume it
unasked; extending while the loop makes progress keeps the iteration whole.

Live check after a rebuild (not yet run; the steps above are unit-tested
against a fake sandbox, hc core and ralph in
[`e2b-provider.test.ts`](../src/lib/server/dispatch/e2b-provider.test.ts)
and [`ralph-transport.test.ts`](../src/lib/server/e2b/ralph-transport.test.ts)):

1. In a fresh sandbox from the template, `ralph --version` prints the pinned
   version and `/opt/ralph` has no `.git`.
2. On a project whose Tackle checkout has `.ralph/ralph.toml`, start a
   `build` loop with `max_iterations` 2 on Sand. In the sandbox, `hc ls`
   lists `ralph-serve` and `ralph-loop`; `ss -ltnp` shows ralph's port bound
   to 127.0.0.1 only; `ralph status` shows the run named in the sandbox's
   `beadsmith_loop` metadata.
3. The mission thread shows each iteration's text and tool calls live, and
   the mission's iteration rows fill in as iterations finish.
4. When the loop ends, the thread shows the stop reason, the mission's
   status matches it, and the sandbox is gone from E2B after the idle time.
5. Start another and cancel it mid-iteration: the thread says cancelled,
   `ralph show <name>` in the sandbox (before it goes) shows an operator
   stop, and `hc ls --all` shows `ralph-loop` finished.
6. Start a `build` loop with `max_iterations` 3 and send a steer note from
   the thread during iteration 1: the thread shows it as a steer turn, and
   when iteration 2 starts the live stream shows the note and
   `ralph show <name>` lists it consumed. Then press Stop after iteration:
   the button reads "Stopping after this iteration" (also after a reload),
   iteration 2 finishes, iteration 3 never starts, and the mission ends
   cancelled with an operator stop.
7. In the sandbox, `tr '\0' '\n' < /proc/<ralph's pid>/environ` lists the
   placeholders and `BEADS_DOLT_*`, and no real model key or GitHub token.
8. When a `build` loop with `max_iterations` 1 ends, set Iterations to 2 and
   press Restart within the idle time: the thread adds "Restart the loop
   for up to 2 iterations.", the mission's sandbox id is unchanged, `hc ls
--all` lists `ralph-loop` finished and `ralph-loop-r2` live, and the
   iteration table shows a second run group. After that run ends, wait past
   the idle time (the sandbox is gone from E2B) and restart again: the
   mission moves to a new sandbox whose `~/.beadsmith/runs` holds only
   `r3`, and the table shows a third group.
9. With `BDX_E2B_MAX_RUN_MINUTES=10`, start a `run` loop with
   `max_iterations` 4 whose iterations take about four minutes each, and
   close the browser. The loop runs all four iterations (about 16 minutes)
   and ends with `max_iterations`; E2B's sandbox info shows its end time
   moving forward as each iteration finishes.

## How a chat runs

The chat runner is the mate runner's own core
([`src/lib/mate-runner/`](../src/lib/mate-runner/)) running inside
Beadsmith, reaching the chat's sandbox over the E2B process channel instead
of SSH. The sandbox is found again by the chat's session id. Claude Code
runs interactively in an hc terminal in `/home/user/mate`, driven by the
session core exactly as on the forge runner
([first-mate.md](first-mate.md#how-the-runner-runs-a-chat)); `beadsmith-hc
connect` starts the sandbox's hc core on first use, with the sandbox's
environment. Chat logs live under `<state dir>/sand-mate`. Deleting a chat
deletes its sandbox; if E2B cannot be reached, the chat stays so the delete
can be retried.

Whenever Beadsmith connects to a chat's sandbox (the chat's first message,
or the first after a restart, an eviction or a lost channel), it writes
First Mate's standing instructions (`AGENTS.md`) and the crew tools relay
(`.crew/relay.cjs` and `.crew/mcp.json`) into that directory, so changing
them needs no template rebuild. It ends a Claude Code left from before (it
was talking to the old relay), starts the relay's serve side over the E2B
commands API, then launches Claude Code with `--mcp-config` (resuming the
session when its transcript is there); Claude Code starts the relay's stdio
side as an MCP server. A tool call travels as a JSON line over a unix socket to
the serve side, out on its stdout to Beadsmith, and the reply comes back on
its stdin. Beadsmith runs the call as the chat's owner, looked up from the
session on every call, so a deleted chat or a banned owner gets nothing. The
relay is restarted if it exits (five times per connection) and stopped
with the connection. No token or address in the sandbox reaches Beadsmith any
other way ([ADR-0020](../specs/decisions/0020-first-mate-crew-tools.md)).

E2B and hc errors, and a launch that fails, go to Beadsmith's server log
with credential shapes stripped; the browser only sees a fixed message (or,
for a CLI stopped at a first-run prompt, that the image must pre-accept it). Mission sandboxes do the same for a failed setup's
`setup.log`.

## Costs and limits

- E2B bills running sandboxes per second. Paused ones are not billed for
  compute and E2B keeps them until they are deleted; whether it charges for
  their storage is not documented. Deleting a chat deletes its sandbox. A
  finished mission's sandbox stays paused (so follow-ups work) until you
  delete it in E2B's dashboard. A finished loop's sandbox is destroyed after
  the idle time.
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
reaching Dolt, cloning, starting hc). `~/.beadsmith/runs/<run>/setup.log` in
a mission's sandbox, `hc ls --all` and `hc read <terminal>` there, and
`~/.beadsmith/tailscale/tailscaled.log`, say what went wrong. Open them from
E2B's dashboard or CLI; the mission's agent id is the sandbox id.
