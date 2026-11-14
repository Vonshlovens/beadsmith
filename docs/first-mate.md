# First Mate

`/first-mate` is a chat with one long-lived agent, the first mate. You talk
only to it. It starts worker agents, watches them, and reports back on its
own when something is done or needs a decision ("PR ready, captain"). The
model comes from [firstmate](https://github.com/kunchenguid/firstmate), an
agent distro built on the same idea: one liaison, a crew behind it, and
escalation only for real decisions.

Beadsmith does not run the agent. It stores each chat and relays it to a
**mate runner**, a separate service that keeps one agent session alive per
chat (interactive Claude Code in an hc terminal inside a sandbox,
[ADR-0015](../specs/decisions/0015-scoped-agent-sandboxes.md) and
[ADR-0021](../specs/decisions/0021-hc-terminal-runtime.md)). This page is
the contract between the two, and [how Beadsmith's own runner
works](#how-the-runner-runs-a-chat).

## Who can use it

First Mate chats are **admin-only** for now: the first mate acts for the
admin who owns the chat. On Sand its crew tools read every project, change
that admin's todos and start missions as them; on the forge guest it works in
a beads sandbox that can change Beads in every project it is granted. Every
`/api/mate/chats` route, reads included, needs the `admin` role, and a chat
belongs to the account that created it; anyone else's chat answers `404`.
Members see a note saying First Mate is for admins; `⌘K` commands work as
before.

Without a runner, admins still get stored chats, and each message gets a
placeholder reply saying no model is connected.

`/first-mate` is also where `/` lands for every account, so its start screen
is a home page. Under the composer it lists your own work, each panel linking
to its full page: your most urgent todos (admins), ready issues, workers
that are running or whose last run failed, and on narrow screens your recent
chats. Ready issues load for every role, so a member, or an admin on a host
with no runner, still gets a useful page: members see the panels without a
composer.

## Configuration

| Setting                       | Meaning                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `BDX_MATE_RUNNER_URL`         | Base URL of the mate runner: https, or http on loopback. Unset: First Mate is not connected.  |
| `BDX_MATE_RUNNER_SECRET_FILE` | File holding the shared HMAC secret (32+ characters), e.g. `/run/secrets/mate-runner-secret`. |
| `BDX_MATE_RUNNER_SECRET`      | Local/development fallback for the secret. Never the production source.                       |

Both a URL and a secret are needed. A URL that is not https (or loopback
http) or a missing secret leaves First Mate disconnected. The secret is read
when a request is signed and never stored, logged or sent to the browser; a
runner that echoes it back gets it redacted. Restart the service after
rotating it.

### Chat runners

A chat runs on one of the configured **chat runners**, chosen when it is
created and kept for its life:

| Runner   | Where the agent runs                                                                        | Needs                                                                                    |
| -------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `remote` | The HTTP mate runner above (for example the forge guest, ADR-0016)                          | `BDX_MATE_RUNNER_URL` and its secret                                                     |
| `e2b`    | Sand: an E2B sandbox per chat, with crew tools ([sand-e2b.md](sand-e2b.md#how-a-chat-runs)) | `BDX_E2B_API_KEY_FILE` and a model credential ([sand-e2b.md](sand-e2b.md#configuration)) |

`BDX_MATE_RUNNERS` lists them, default first; unset means `remote`.
`BDX_MATE_RUNNER_LABEL` and `BDX_E2B_LABEL` name them. With more than one
place to run, the start screen's **Runs on** picker chooses where new chats
(and new agent threads) go, and the chat header says where each chat runs.
The `e2b` runner is the mate runner's own core running inside Beadsmith, so
it follows the contract below exactly; it needs no URL or secret.

### Model and effort

A chat can ask for a model and a reasoning effort when it is created
(`POST /api/mate/chats` `{ model?, effort? }`), from the same operator list
mission launches use (`BDX_AGENT_MODELS`, `BDX_AGENT_EFFORTS`,
[configuration.md](configuration.md)). Anything else is refused with `400`
before the chat exists, because the name reaches the agent CLI's argv and
decides what the chat spends. Not asking leaves the CLI's default, and an
empty list offers nothing to pick.

The choice is fixed for the chat's life: `mate_chats` keeps it, and
Beadsmith sends it with every message, the user's and its crew notices
alike. The runner records it from the chat's first message, launches
`claude --model … --effort …`, and relaunches with the same flags on a
`--resume`, so a runner restart, an evicted session or a new sandbox keeps
the chat on its model. A later message carrying a different choice is
refused (`409`) rather than resuming the transcript under another model
unannounced. Both runners take it: Sand runs the runner core in-process,
and the forge runner serves the same core over the contract, so a forge
runner must be built from a Beadsmith version that knows the fields (an
older one ignores them and runs its default).

The new-chat composer shows the same Model and Effort picker as the launch
dialogs when the server offers a choice, and the chat header shows what the
chat runs on.

The start screen says where a new chat will run and what it can do there:
crew tools on Sand, its own Beads sandbox elsewhere. When a runner is
configured it also offers next actions from live data, such as "4 ready
issues in api", and on Sand "2 todos not routed" and "1 mission needs you"
(an issue whose latest mission failed). Each one fills the composer with a
question and never sends. Nothing is offered that the chat could not do:
todo and mission suggestions need crew tools, and without dispatch the todo
prompt asks for a plan instead of routing
([`mate-start.ts`](../src/lib/client/mate-start.ts)).

## Crew tools

On the `e2b` runner, First Mate can do more than talk. Beadsmith gives the
chat's Claude Code an MCP server, `crew`, whose tools run inside Beadsmith as
the admin who owns the chat ([ADR-0020](../specs/decisions/0020-first-mate-crew-tools.md)).
A tool can do nothing that admin could not do in the browser: dispatch's arm
switch, allow-list and repository mappings refuse a crew launch exactly as
they refuse a click, with the same message.

| Kind     | Tools                                                                                                     | What happens                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Read     | `list_projects`, `ready_work`, `list_issues`, `show_issue`, `list_missions`, `show_mission`, `list_todos` | Answers from the read model, missions and todos. Results are compact and bounded. |
| Todos    | `create_todo`, `update_todo`, `complete_todo`, `route_todo`                                               | Changes the owner's todo list directly; `route_todo` files a todo with a mission. |
| Missions | `file_issue`, `comment_issue`, `tackle_issue`, `discuss_issue`, `follow_up_mission`, `cancel_mission`     | Starts, continues or stops a mission on the default dispatch provider.            |
| Memory   | `remember`, `recall`, `forget`                                                                            | The owner's memory, kept across chats ([below](#memory)).                         |

Beads itself only changes through missions: First Mate files and comments by
starting a File or comment mission, whose agent runs `bd` in a sandbox of its
own. There are no delete tools. A mission started from a chat belongs to it
(`dispatch_requests.chat_id`), shows up on the mission list and in its own
agent thread like any other, and counts against a per-chat launch limit
(`BDX_CREW_LAUNCH_LIMIT` per `BDX_CREW_LAUNCH_WINDOW_MINUTES`, default 10 per
10 minutes). A retried call returns the mission it already started instead of
launching a second one.

When a chat's mission succeeds, fails or is cancelled, Beadsmith tells the
chat with a one-line **crew notice** (`[crew] Tackle on <issue> (<project>)
succeeded.`, the PR link if any, a short summary, the mission id and "Tell
the captain."), so First Mate reports back unasked. Each outcome is told
once (`dispatch_requests.chat_notice`); if the runner is down, opening the
chat delivers what is owed. The chat shows these as a labelled crew update,
not as your message.

In the transcript, crew tool calls read as short activity lines in words
("Checked ready work", "Requested a Tackle mission") rather than tool names;
a launch line says the mission was requested, because the call can still be
refused. Each mission the chat started shows as a card under the agent's
message it came from: operation, issue, project, live status, run time, the
pull request, a link to its thread and, while its runner can cancel it,
Stop. The cards come from `GET /api/mate/chats/:id/missions` and refresh when
a launch tool returns, when a crew notice arrives, and every 12 seconds while
one is still working. A crew line opens to show what First Mate sent and
what Beadsmith answered, read when you first open it, and a refused call
(launch limit, dispatch off, no repository mapped) shows its reason under
the line. Those are Beadsmith's own answers, kept per chat for its owner;
the agent's other tools keep only their name and status.

### Memory

First Mate keeps a memory for the admin who owns the chat
([ADR-0024](../specs/decisions/0024-first-mate-memory-and-context.md)). A
memory is one short fact under a key, with one scope: `owner` (about the
admin), `project:<id>` or `topic:<slug>`. `remember` saves one, replacing
whatever was under that key; `recall` searches by words (best match first)
or lists the newest, optionally in one scope; `forget` deletes one key. First
Mate saves memories on its own judgment, without asking. Memories belong to
the account, not the chat: deleting a chat keeps them, and every chat of
that admin, on any runner with crew tools, sees the same memory. No other
account's chat can read them.

Limits (the ADR's Limits table): 500 characters per memory, keys of up to
64 lowercase letters, digits and single dashes, 500 memories per account of
which at most 40 are `owner`-scoped, and 25 per recall. A write over a
limit is refused with a message saying what to do; nothing is cut.

Not yet shipped: memories added to each turn automatically, the meta
folder, the sliding context window and a page to review and edit memories.

Mission tools need dispatch configured (`BDX_DISPATCH_PROVIDER`); without it
they answer with the reason, and the read and todo tools still work. Chats on
the `remote` runner have no crew tools yet: the forge guest keeps its own
setup until it gets a transport for the same tool module.

## What Beadsmith stores

Four tables in `state.db` ([ADR-0004](../specs/decisions/0004-service-local-sqlite.md)):

- `mate_chats`: id (`mc_` + 24 hex), owner account id, title, scope (a
  project id, or null for every project), the chat runner (`remote` or `e2b`;
  older chats read as `remote`), the runner `session_id` (a UUID generated
  with the chat and kept for its life; never sent to the browser), the
  model and effort it was created with (null for the default), and
  timestamps.
- `mate_events`: the events Beadsmith has relayed for a chat, in order,
  keyed by the runner's event id, with compact fields only. Text for `user`,
  `assistant`, `result` and `error`; name and status for a `tool_call` (never
  its arguments or output); `thinking` cut to 2,000 characters; result status,
  duration and pull request link. `origin` is `runner`, or `local` for the
  placeholder replies written without a runner.
- `mate_crew_calls`: the crew tool calls Beadsmith answered for a chat
  ([ADR-0020](../specs/decisions/0020-first-mate-crew-tools.md)), keyed by
  Claude Code's tool use id: tool, arguments as JSON (cut at 4,000
  characters), the text the agent was given (cut at 8,000), whether it was an
  error, and the mission a launch named. The newest 200 per chat are kept.
- `mate_memories`: First Mate's memories, per owner account: key (unique
  per owner), scope, body, the chat that last wrote it, and created,
  updated and last-recalled times, with an FTS5 index (`mate_memories_fts`)
  for recall. Deleting a chat leaves them.

The runner is the durable log of a chat. Beadsmith's copy lets a chat open
without the runner and catch up from where it left off.

## Beadsmith API

All under `/api/mate`. Mutations carry the usual `x-bdx-request: 1` header;
errors use the normal `{ error: { code, message } }` envelope.

| Route                                         | Does                                                                                                                                                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/mate/status`                        | `{ connected, reason?, reachable?, runners? }` for any signed-in viewer. `reason`: `admin_only` or `unconfigured`. `reachable`: cached health of the default runner. `runners` (admins): `[{ id, label }]`, default first. |
| `GET /api/mate/chats`                         | `{ chats }`, the caller's own, most recently active first.                                                                                                                                                                 |
| `POST /api/mate/chats`                        | `{ title?, scope?, runner?, model?, effort? }` → `201 { chat }`. `runner` must be configured, `model` and `effort` on the operator's list (`400` otherwise); omitted, the defaults. `409` past 100 chats.                  |
| `GET /api/mate/chats/:id`                     | `{ chat, events }`: the stored log, oldest first (the latest 2,000 events).                                                                                                                                                |
| `PATCH /api/mate/chats/:id`                   | `{ title?, scope? }` → `{ chat }`. A new scope applies from the next message.                                                                                                                                              |
| `DELETE /api/mate/chats/:id`                  | Stops the runner session, then deletes the chat. If the runner cannot stop it, the chat stays (`503`) so the delete can be retried.                                                                                        |
| `POST /api/mate/chats/:id/messages`           | `{ text, message_id? }` → `202`. With a runner: `{ event_id }`. Without: `{ events }`, the stored message and placeholder reply.                                                                                           |
| `GET /api/mate/chats/:id/events`              | `text/event-stream`, below. `503` without a runner.                                                                                                                                                                        |
| `GET /api/mate/chats/:id/missions`            | `{ missions }`: the missions this chat's crew tools launched, newest first (at most 50), in the `/api/missions` shape. Which chat launched a mission is never in the payload.                                              |
| `GET /api/mate/chats/:id/crew-calls`          | `{ calls }`: the chat's crew call records, oldest first, without bodies: `call_id`, `tool`, `is_error`, `reason` (a refusal's first 300 characters), `mission_id`, `at`.                                                   |
| `GET /api/mate/chats/:id/crew-calls/:call_id` | `{ call }`: one record with `arguments` and `result`.                                                                                                                                                                      |
| `POST /api/mate/chats/:id/interrupt`          | `202`: stops the agent's current turn. The session keeps running.                                                                                                                                                          |

`text` is trimmed and capped at 4,000 characters. `message_id`
(`[A-Za-z0-9_-]{1,64}`) is generated by the browser once per message and
reused when you retry a failed send, so the runner never sees a message
twice; the server makes one up when it is absent. Extra keys are refused.

The events stream first replays stored events after `Last-Event-ID` (or
`?after=`), then opens the runner's stream from the newest stored runner
event, stores each new event and forwards it. Each frame is
`id: <event id>` and `data: <MissionEvent JSON plus at>`. A runner failure is
an `event: runner_error` frame with `{ message }`, after which the stream
closes and EventSource reconnects. The browser recovers from a dropped stream
by itself: a drop shorter than a few seconds shows nothing, and when
EventSource gives up (an error status from a proxy, say) the page reopens
the stream after the last event it holds, backing off for about a minute
before it asks you to reconnect by hand. Closing the browser closes only this
relay: the session keeps working on the runner, and the next open catches up.
Beadsmith learns what the agent said only while some browser has the chat
open; the runner keeps the rest until then.

## Mate runner contract, version 1

Paths are below `BDX_MATE_RUNNER_URL` (its path is kept: a base of
`https://runner.example/mate` puts health at `/mate/v1/health`).

### Signing

Every request carries:

| Header                  | Value                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| `x-beadsmith-contract`  | `1`                                                                  |
| `x-beadsmith-timestamp` | Unix seconds                                                         |
| `x-beadsmith-signature` | `v1=` + hex HMAC-SHA256 under the shared secret, of the string below |

```text
<timestamp>.<METHOD> <path>\n<body>
```

`<path>` is the request target exactly as sent: the base URL's path, the
route, and the query string when there is one (for example
`/mate/v1/mate/chats/mc_0123/events?after=e000012`). A GET's body is the
empty string. This is the signature the [webhook dispatch
contract](file-tackle-dispatch.md) uses (`signWebhookRequest` in
`src/lib/server/dispatch/webhook-provider.ts`). Runners should compare in
constant time and reject timestamps more than five minutes old.

### Send a message

`POST /v1/mate/chats/{chat_id}/messages`

```json
{
	"session_id": "6f1c1f4e-…",
	"message_id": "1b7d…",
	"prompt": "What is ready across every project?",
	"scope": "d_beads_web",
	"model": "claude-opus-5-5",
	"effort": "high"
}
```

→ `202 { "event_id": "e000041" }`, the id of the `user` event the runner
recorded for this message.

- The runner starts the session on first use (with this `session_id`) and
  keeps it alive. The same `session_id` comes with every message of a chat.
- `model` and `effort` are optional and come with every message of a chat
  that has them, as `session_id` does. The runner checks only their shape
  (a model name, an effort level; never a flag), records them with the
  session on first use and launches and resumes the CLI with them. A
  message whose `model` or `effort` differs from the recorded ones,
  including leaving out ones the chat has, is `409`.
- A message sent while the agent is working is queued for it; there is no
  "busy" answer.
- `message_id` (1-64 characters of `[A-Za-z0-9_-]`) is unique per user
  message and reused on a retry. A repeat returns the same `202 { event_id }`
  and does not send the prompt to the agent again.
  The runner also echoes it as `message_id` on the corresponding `user`
  event. Beadsmith preserves it in stored events and replay, so the browser
  can settle a pending message even before its POST response arrives. The
  field is optional for older events; only the same bounded identifier
  format is accepted.
- Beadsmith sends some messages itself: a **crew notice** tells the agent
  that a mission it launched with a crew tool has finished. Its
  `message_id` starts with `crew-` (and is derived from the mission and its
  outcome, so a repeat is dropped); the browser may not use that prefix, and
  the chat shows such `user` events as a labelled crew update, not as yours.
  A runner needs nothing special for them.
- `scope` is the opaque Beadsmith project id the chat is about (`d_` and the
  Dolt database name, which may itself contain underscores), or null for
  every project. It may change between messages.
- `404 { "error" }` when the runner does not know the chat and cannot start
  it; any other non-2xx is `{ "error": string }`. Beadsmith shows the error
  text to the admin (capped, with the secret redacted).

### Follow events

`GET /v1/mate/chats/{chat_id}/events?after={event_id}` with
`accept: text/event-stream`. Without `after`, the full history.

A long-lived SSE stream. It replays every event after `after`, then follows
live. Each event is one frame:

```text
id: e000042
data: {"type":"assistant","id":"e000042","text":"Two workers started."}
```

- The SSE `id:` is the event id: opaque, ordered, unique within the chat,
  matching `[A-Za-z0-9._:-]{1,128}`. `data.id` carries the same value; when
  they differ, Beadsmith uses the SSE `id:`.
- `data:` is one MissionEvent (`src/lib/mission-events.ts`): `user`,
  `assistant`, `thinking`, `tool_call`, `result` or `error`. Beadsmith drops
  anything that does not validate, strips unknown keys, and keeps a
  `result`'s `git_pr_url` only when it is a plain `https://github.com/…/pull/N`
  link.
- Each `assistant` (and `thinking`) event is a whole block of text, not a
  token delta; consecutive blocks are shown as paragraphs.
- A `result` ends one agent turn and does not end the stream. The agent may
  start a turn on its own (a worker finished): its events simply follow.
  Beadsmith shows the agent as working from any event until the next
  `result` or `error`, so end every turn with a `result`.
- Send a comment heartbeat (`: ping`) about every 15 seconds. Beadsmith
  treats 45 seconds of silence as a dead stream, closes it, and reconnects
  from the last event it stored.
- Beadsmith may hold several streams on one chat (two browser tabs), and
  reconnects freely; replays must be exact.

### Interrupt

`POST /v1/mate/chats/{chat_id}/interrupt` → `202`. Stops the agent's current
turn; the session survives. The turn should end with a `result` whose status
is `cancelled`. Messages still queued behind the turn are dropped too (stop
means stop); if nothing was running yet, one `cancelled` result closes them.

### Delete

`DELETE /v1/mate/chats/{chat_id}` → `204`. Stops the session and forgets the
chat. `404` (never knew it) is fine too.

### Terminal attach

Beadsmith's admin terminal relay (ADR-0021 rule 4) for one chat's agent
terminal. The runner attaches over a new `hc connect` of its own (on forge,
the same pinned SSH it runs chats over), so a relay never shares the chat's
channel; it adds no authority, and it keeps and logs none of the bytes.
Beadsmith authorizes and audits each relay before it calls this.

`POST /v1/mate/chats/{chat_id}/terminal` with
`{ "mode": "watch" | "take_over", "cols": 80, "rows": 24 }` (cells, 1 to 1000) and `accept: text/event-stream` → `200`, a Server-Sent Events stream:

```text
event: open
data: {"attach":"ta_<32 hex>","mode":"watch","cols":120,"rows":40}

event: output
data: <base64 bytes>

event: resize
data: {"cols":100,"rows":30}

event: end
data: {"reason":"exited"}
```

- The terminal is the chat's live one labelled `beadsmith-session=<the
chat's session_id>`. `watch` attaches with hc's `observe` (no typing, no
  resizing; `resize` frames follow the agent's grid); `take_over` attaches
  as the active viewer at the grid given.
- `open` comes first and carries the terminal's grid at attach. Output is
  written only as fast as Beadsmith reads it, so a slow viewer slows hc's
  stream instead of growing a buffer. `: ping` comments keep it alive, as
  on the events stream; Beadsmith treats 45 seconds of silence as gone.
- `end` carries hc's reason (`exited`, `killed`, …) when the program or
  attach ends; then the stream closes. Beadsmith closing the request
  detaches and drops the runner's hc connection.
- `409 { "error" }`: the chat has no agent yet, or its terminal has
  finished; Beadsmith shows the text to the admin. `503`: the guest could
  not be reached. `404`: an unknown route (a runner older than this
  endpoint), shown as unreachable.

`POST /v1/mate/chats/{chat_id}/terminal/{attach}` with `{ "data"?: base64,
"cols"?, "rows"? }` (`cols` and `rows` together) → `204`: keystrokes and a
new size for a `take_over` attach, size first. `409` while watching, `404`
when that chat has no such open attach. Beadsmith sends these one at a
time, in order, merging keystrokes that queue behind a request; a refused
one ends the relay rather than letting the admin's terminal drift.

### Health

`GET /v1/health` → `{ "ok": true }`. Beadsmith caches the answer for 15
seconds and shows admins when the runner is not answering.

## How the runner runs a chat

Both runners Beadsmith ships, the `remote` one on the forge host
([`scripts/mate-runner.ts`](../scripts/mate-runner.ts)) and the `e2b` one
inside Beadsmith, are the same core
([`src/lib/mate-runner/`](../src/lib/mate-runner/)). Each chat's agent is
interactive Claude Code in an [hc](https://github.com/herdrdev/herdr-core)
terminal, driven by the session core
([`src/lib/agent-session/`](../src/lib/agent-session/), ADR-0021):

- The runner reaches the hc core only through a channel it already holds:
  `ssh <guest> hc connect` with the pinned host key on forge, the E2B
  process channel on Sand ([sand-e2b.md](sand-e2b.md#how-a-chat-runs)). No
  hc socket or port leaves the guest or sandbox.
- The first message launches `claude --session-id <session_id>` (with
  `--model` and `--effort` when the chat has them) in the
  working directory, labelled `beadsmith-chat=<chat id>`, and pastes the
  prompt into it; the prompt is never on a command line. The CLI keeps
  running between turns, so a follow-up is the next message to the same
  process.
- Events come from Claude Code's own session transcript (one mapping for
  chats and missions), sanitized, and are recorded in the chat log with the
  runner's `e…` ids. A turn ends when hc's turn counter moves and the
  transcript has its end record; every turn ends with a `result`.
- A message sent during a turn waits in the runner and goes in when the
  turn ends. A CLI waiting for a decision (hc reports `blocked`) is never
  typed into: the message fails with an error saying so. Stop (interrupt)
  is one way out; an admin can also take over the chat's terminal through
  the relay (the **Terminal** strip under the chat's header;
  `POST /api/console/terminals`, docs/contract.md) and answer it by hand,
  on Sand over the sandbox's process channel and on forge through the
  runner's [terminal attach](#terminal-attach).
- The chat holds no channel while it has no agent. After a runner
  restart, an idle chat being evicted (`MATE_RUNNER_MAX_SESSIONS`), the
  CLI exiting or the channel dropping, the next message connects again:
  the session core follows a CLI that is still live, or launches
  `claude --resume <session_id>` when the transcript is there (a new,
  empty sandbox starts the session fresh). A turn whose CLI exits or whose
  channel is lost ends with an error and a `failed` result. Shutdown and
  eviction end the CLI; a runner that crashed finds it still running.

The forge runner's settings (environment of `mate-runner.service`):

| Setting                    | Meaning                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `MATE_AGENT_SSH`           | `user@host` of the guest; with `MATE_AGENT_SSH_KEY` and `MATE_AGENT_KNOWN_HOSTS`                                              |
| `MATE_AGENT_CHAT_HOMES`    | Absolute guest directory of chats' homes; a chat's is `<it>/<instance>`, with `work` and `.claude` (its transcripts) under it |
| `MATE_AGENT_CLAUDE`        | The Claude Code executable the terminal runs (default `claude`)                                                               |
| `MATE_AGENT_WORKDIR`       | Development only: the working directory (default: the current one)                                                            |
| `MATE_AGENT_CLAUDE_CONFIG` | Development only: Claude Code's config directory (default `~/.claude`)                                                        |
| `MATE_AGENT_HC`            | Development only: the local hc executable (default `hc`)                                                                      |
| `MATE_AGENT_LOCAL=1`       | Development: run `hc connect` on this machine instead of over SSH                                                             |

In the guest every chat runs as a Unix identity of its own
([ADR-0023](../specs/decisions/0023-forge-chat-isolation.md)): a
`mate-chat@` unit with a private home (`<MATE_AGENT_CHAT_HOMES>/<instance>`,
where the instance is the first 24 hex digits of the SHA-256 of its
session id) and its own hc core, so a chat's CLI outlives the runner's SSH sessions and
cannot reach another chat's transcripts, files or processes. The runner's
key may only ask the guest's `mate-chat` helper to `connect` to one chat's
core (starting it first) or `discard` a chat. Deleting a chat discards it:
its core and everything it started stop and its home is removed; when that
fails the runner answers 503 and keeps the chat, so the delete can be
retried ([host-forge.md](operations/host-forge.md#guest-lifecycle-smoke-test)).

Operator check after deploying the guest (not yet run; unit tests cover the
runner against a fake hc core, and the guest lifecycle smoke test covers the
guest's core without a model): open a First Mate chat on the forge runner
and send a message. In the guest, `hc ls` (as the chat, see
[host-forge.md](operations/host-forge.md#guest-lifecycle-smoke-test))
lists one live terminal labelled
`beadsmith-chat=<chat id>` running Claude Code in the working directory.
Send a second message: the same terminal answers. Press stop during a long
answer: the chat shows the turn cancelled and the terminal is still live.
Restart `mate-runner.service` and send again: a new terminal runs
`claude --resume` and the answer shows the agent remembers the
conversation.

Operator check for the terminal relay on forge (not yet run; unit tests
cover the runner's attach against a fake hc core in
[`server.test.ts`](../src/lib/mate-runner/server.test.ts), Beadsmith's
client against a fake runner in
[`runner.test.ts`](../src/lib/server/mate/runner.test.ts), and the console
route with a forge chat in
[`server.test.ts`](../src/routes/api/console/terminals/server.test.ts)):

1. As an admin, open a forge chat that has answered a message. The
   **Terminal** strip shows under the header; **Watch** shows Claude
   Code's screen. In the guest, `hc ls` still lists one live terminal for
   the chat, and the runner host has one more `ssh … connect <session>` while
   the view is open, gone a few seconds after closing it.
2. **Take over…**, type `/help` and Enter: Claude Code shows its help in
   the view. **Hand back** returns to watching. Send a chat message
   afterwards: the agent answers as before.
3. Watch a chat that has never had a message: the strip says the chat has
   no agent yet. Stop the guest and watch again: the strip says the
   terminal could not be reached.
4. `SELECT * FROM terminal_relay_sessions ORDER BY started_at DESC` in
   `state.db` lists each attach with your email, `chat`, its mode and an
   end time; `journalctl -u mate-runner` shows no terminal bytes.

## Code

- Runner client: [`src/lib/server/mate/runner.ts`](../src/lib/server/mate/runner.ts)
  (its `attachTerminal` speaks the terminal attach above; the runner side
  is in [`src/lib/mate-runner/server.ts`](../src/lib/mate-runner/server.ts))
- Crew tools: [`src/lib/server/crew/`](../src/lib/server/crew/) (the tool
  module, launch limit and crew notices); the Sand relay:
  [`src/lib/server/mate/crew-bridge.ts`](../src/lib/server/mate/crew-bridge.ts)
- Storage: [`src/lib/server/mate/store.ts`](../src/lib/server/mate/store.ts)
- Relay and placeholder replies: [`src/lib/server/mate/service.ts`](../src/lib/server/mate/service.ts)
- Routes: [`src/routes/api/mate/`](../src/routes/api/mate/)
- Browser store and view: [`src/lib/client/mate-chat.svelte.ts`](../src/lib/client/mate-chat.svelte.ts),
  [`src/lib/components/mate-chat-view.svelte`](../src/lib/components/mate-chat-view.svelte)
- A fake runner for tests, which checks signatures and never opens a socket:
  [`src/lib/test/fake-mate-runner.ts`](../src/lib/test/fake-mate-runner.ts)
