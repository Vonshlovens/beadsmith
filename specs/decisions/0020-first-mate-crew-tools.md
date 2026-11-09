# 0020. First Mate crew tools: Beads, todos and repo workers from a Sand chat

Date: 2026-11-09

## Status

accepted. Amends [0018](./0018-sand-e2b-sandboxes.md) rule 5 ("Sand chats:
model access only") for chats on the `e2b` runner. Builds on
[0006](./0006-durable-agent-dispatch.md) (missions),
[0015](./0015-scoped-agent-sandboxes.md) (keys outside the sandbox) and the
todo list in [0004](./0004-service-local-sqlite.md)'s state store. Leaves
[0016](./0016-first-mate-worker-runtime.md) (the forge guest) unchanged; a
later runtime, such as forge replacing Sand, plugs into the same tool module.

## Context

[First Mate](../../docs/first-mate.md) is meant to be a liaison: you talk to
one agent; it reads your projects, files and routes work, starts worker
agents, watches them and reports back. On Sand it can only talk. Its sandbox
has model access and nothing else, so it cannot see a single issue, a todo or
a mission, and every real action still means leaving the chat to press File
or Tackle somewhere else.

Beadsmith already has everything First Mate needs as server modules: the
cross-project read model (`src/lib/server/read-model.ts`), the todo store and
todo routing (`src/lib/server/todos/`), and dispatch with its policy
(`src/lib/server/dispatch/`), whose `e2b` provider runs repo workers in their
own sandboxes. What is missing is a safe way for the chat agent to call them.

The obvious routes all add a hole. Calling Beadsmith's HTTP API from the
sandbox needs a way through Cloudflare Access and a credential the agent
could read or replay. Joining the chat sandbox to the tailnet needs a policy
change and still puts a token inside. Giving the chat bd and Dolt accounts
for every project breaks the one-scope-per-sandbox rule (0015, rule 2).

The Sand chat runner, though, runs inside Beadsmith and already holds an
authenticated process channel into each chat's sandbox (the E2B commands API,
used today for Claude Code's stdin and stdout).

## Decision

First Mate chats on Sand get **crew tools**: an MCP server that Beadsmith
implements in-process and exposes to the chat's Claude Code through a relay
over the E2B process channel.

1. **One tool module, transport-agnostic.** `src/lib/server/crew/` defines
   each tool once (name, input schema, handler) over the existing server
   modules, and an MCP JSON-RPC handler (`initialize`, `tools/list`,
   `tools/call`) over that list. No transport code lives there, so the same
   module can later serve the forge guest, a hosted MCP endpoint, or a
   replacement runtime.
2. **The bridge carries no authority of its own.** When the runner starts or
   resumes a chat's sandbox, it writes a small relay script and an MCP config
   into the sandbox and starts the relay as an interactive command. Claude
   Code launches the stdio side (`--mcp-config`); each JSON-RPC line goes over
   a unix socket to the relay, out on the relay's stdout to Beadsmith, and the
   reply comes back on its stdin. Beadsmith knows which chat the sandbox
   belongs to, so a call needs no token: nothing inside the sandbox can be
   used anywhere else, and there is no inbound network path. Bridge frames are
   bounded and validated, and a malformed frame is dropped and logged.
3. **Tools act as the chat's owner, within the chat's scope of authority.**
   Every call runs as the account that owns the chat (an admin, as First Mate
   requires) through the same checks the browser path uses: dispatch policy,
   project visibility and repository mappings. A tool cannot do anything its
   owner could not do in the UI.
4. **Reads are direct; Beads writes are delegated.** Reading projects, ready
   work, issues, events, missions and todos goes through the read model.
   Todos are app-owned rows, so creating, editing, completing and routing
   them is direct. Changing Beads stays with agents that run bd in a mission
   sandbox (the contract's invariant 1; a Beadsmith write path is separate
   work): First Mate files issues and comments through File and comment
   missions, and starts repo workers with Tackle and discuss.
5. **Delegated missions belong to the chat.** A mission launched from a chat
   records that chat. When the mission finishes, fails or needs a decision,
   Beadsmith tells the chat's agent in a short system-authored message, so
   First Mate reports back without being asked. The chat shows delegated
   missions inline, linked to their threads.
6. **Launching agents is visible and bounded.** A tool that starts a mission
   names the operation, project and issue in its result and in the chat UI.
   Per-chat rate limits cap launches, and the existing idempotency keys stop
   a retried tool call from launching twice.
7. **Sand only, for now.** The `remote` runner (forge guest) keeps its own
   setup. When the guest or a successor runtime wants crew tools, it gets a
   transport for the same module, not a second tool implementation.

## Consequences

First Mate can answer from real data, capture and route todos, file issues
and start repo workers without the operator leaving the chat, and it hears
about the outcome of what it started. No new credential exists, and the
sandbox still holds none.

Beadsmith now runs actions on behalf of a model. The blast radius is what the
owning admin can do in the UI, and every Beads change still goes through a
visible mission with its own thread, cancel and audit trail. A chat that is
prompt-injected (for example by an issue's text) could launch missions; rate
limits, visible tool results and mission threads are the mitigation, and
destructive operations are not tools.

Chats on the `remote` runner keep today's behavior until they get a
transport.

## Alternatives considered

**Sandbox calls Beadsmith over HTTPS.** Needs a Cloudflare Access service
token and a bearer per chat. E2B's egress could inject both so the sandbox
never sees them, but that widens Access to machine callers for writes and
depends on public-beta header injection for authority, not only for keys.

**Chat sandbox on the tailnet with bd.** Real Beads access with no
Beadsmith code, but only for one project per sandbox, with a credential
inside, and with a tailnet policy change for each new kind of caller.

**The hosted MCP server first.** OAuth MCP is the right long-term surface for
outside agents and would reuse the same tool module, but it needs Access
bypass and OAuth work First Mate does not.

## Implementation notes

**Tool module.** `src/lib/server/crew/registry.ts` holds the tool type (a
zod input schema, published to clients as JSON Schema, so validation and the
advertised schema cannot drift), the caller context (owner account and role,
chat id, chat scope) and the result bounds. `mcp.ts` is the JSON-RPC 2.0
handler and the tool list, `CREW_TOOLS`. Unknown tools and bad arguments are
JSON-RPC `-32602` errors; a tool that fails returns an `isError` result with
the same safe message the HTTP API would give (`safeError` in
`security.ts`), so driver detail never reaches the agent.

**Read tools.** `list_projects`, `ready_work` (one project or all),
`list_issues` (status, assignee, label, text), `show_issue` (dependencies,
dependents, the last 10 comments and events), `list_missions`,
`show_mission` (status, PR, outcome and the last conversation turns) and
`list_todos`. A tool carries the permission its HTTP route needs:
`list_todos` is admin-only like `/api/todos`, and is neither listed nor run
for a member. Projects and missions are readable by every role, as in the
browser. A chat's scope is only the default project for tools that need one;
it does not narrow what the owner can read, because the browser does not.
Results are compact JSON, string fields cut at 2,000 characters with a note
saying how much was dropped, and the whole result kept under 24,000.

**Sand bridge.** `src/lib/server/mate/crew-bridge.ts`. On every create and
resume the runner writes `/home/user/mate/.crew/relay.cjs` (dependency-free
Node), `.crew/mcp.json` (one stdio server, `crew`, so tools appear as
`mcp__crew__<name>`) and First Mate's `AGENTS.md`, which replaces the
template's text; nothing depends on a template rebuild. The relay's `serve`
side runs as an E2B interactive command and owns a unix socket (mode 0600);
the `stdio` side, which Claude Code launches, connects to it and reconnects
if serve restarts. A frame is one line of JSON, `{"conn": n, "line":
"<JSON-RPC text>"}`, in both directions; `conn` numbers the stdio
connection. Beadsmith accepts at most 256 KiB per frame, validates the shape
strictly, and drops and logs anything else. The caller is resolved on every
frame from the session id (`MateStore.crewCaller`: the chat, its owner, the
owner's current role, refused when the owner is banned or the chat is gone).
The relay is restarted up to five times per Claude Code process and killed
with it. `AgentLaunch.mcp_config` adds `--mcp-config` to the shared
`claudeArgs`. E2B create and connect errors and a 2,000-character stderr
tail on a bad exit go to the server log only, stripped of credential shapes;
the dispatch provider logs a failed run's `stderr.log` and `setup.log` tails
the same way.

**Write tools.** `src/lib/server/crew/write-tools.ts`. `create_todo`,
`update_todo` and `complete_todo` change the todo store directly
(admin-only, as `/api/todos`; archiving is the nearest thing to a delete).
`route_todo` reuses `routeTodo`, so its File mission keys on the todo as the
todos page's does. `file_issue`, `comment_issue`, `tackle_issue`,
`discuss_issue`, `follow_up_mission` and `cancel_mission` call
`enqueueDispatch`, `followUpDispatch` and `cancelDispatch` with the owner's
email as the actor and no provider, so the configured default runs them;
they need `dispatch:launch` like `/api/projects/:id/dispatch`, and arm,
allow-list and repository-mapping refusals come back as tool errors with the
HTTP API's message. The chat is stored on the mission as a nullable
`dispatch_requests.chat_id` column (added in place to existing databases).
A mission's idempotency key is `crew:` and a hash of the chat id, the tool
name and the call id: Claude Code's tool use id
(`_meta["claudecode/toolUseId"]`) when it sends one, otherwise a hash of the
validated arguments, so a retried call replays the first mission either way.
A retried follow-up is refused because the first one left the agent busy.
The launch limit (`launch-limit.ts`, `BDX_CREW_LAUNCH_LIMIT` per
`BDX_CREW_LAUNCH_WINDOW_MINUTES`, default 10 per 10) is an in-memory
sliding window per chat; a replay or a refused launch gives its slot back.
Results carry `launched`, `operation`, `project`, `issue_id` and
`mission_id`.

**Crew notices.** `src/lib/server/crew/notices.ts`. Every terminal
transition of a mission with a `chat_id` (the follower's stream or poll, a
refresh, a cancel) hands the row to `deliverCrewNotice` in the background;
dispatch never waits on it. The outcome is the current run's terminal status
(`chatNoticeKey`, `<status>:<run_id>`), so a follow-up run reports again.
`dispatch_requests.chat_notice` records the outcome the chat was last told,
which makes a repeat observation, a second process or a restart a no-op; the
message id, `crew-` and a hash of the mission and outcome, lets the runner
drop a racing duplicate. A launch that fails synchronously is marked told
without a message, since the tool result already said so. When the chat's
runner is unconfigured or down the notice stays due, and opening the chat
(`GET /api/mate/chats/:id/events`) delivers what is owed; a deleted chat, a
banned owner or a runner conflict marks it told instead of retrying forever.
The text is one line: `[crew] Tackle on <issue> (<project>) succeeded.`,
the PR link, at most 280 characters of the summary or error, the mission id
for `show_mission`, and "Tell the captain." The runner contract has no author
field, so the `crew-` message-id prefix is what marks the stored `user` event
as Beadsmith's (`isCrewNotice`); the browser may not send that prefix, and the
chat renders those events as a labelled crew update. Missions have no
"needs input" state yet, so only finished, failed and cancelled are told.
