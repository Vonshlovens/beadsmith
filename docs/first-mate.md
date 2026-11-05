# First Mate

`/first-mate` is a chat with one long-lived agent, the first mate. You talk
only to it. It starts worker agents, watches them, and reports back on its
own when something is done or needs a decision ("PR ready, captain"). The
model comes from [firstmate](https://github.com/kunchenguid/firstmate), an
agent distro built on the same idea: one liaison, a crew behind it, and
escalation only for real decisions.

Beadsmith does not run the agent. It stores each chat and relays it to a
**mate runner**, a separate service that keeps one agent session alive per
chat (for example Claude Code in headless stream-json mode inside a sandbox,
[ADR-0015](../specs/decisions/0015-scoped-agent-sandboxes.md)). This page is
the contract between the two.

## Who can use it

First Mate chats are **admin-only** for now: the first mate works in a beads
sandbox that can change Beads in every project it is granted. Every
`/api/mate/chats` route, reads included, needs the `admin` role, and a chat
belongs to the account that created it; anyone else's chat answers `404`.
Members see a note saying First Mate is for admins; `⌘K` commands work as
before.

Without a runner, admins still get stored chats, and each message gets a
placeholder reply saying no model is connected.

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

## What Beadsmith stores

Two tables in `state.db` ([ADR-0004](../specs/decisions/0004-service-local-sqlite.md)):

- `mate_chats`: id (`mc_` + 24 hex), owner account id, title, scope (a
  project id, or null for every project), the runner `session_id` (a UUID
  generated with the chat and kept for its life; never sent to the browser),
  and timestamps.
- `mate_events`: the events Beadsmith has relayed for a chat, in order,
  keyed by the runner's event id, with compact fields only. Text for `user`,
  `assistant`, `result` and `error`; name and status for a `tool_call` (never
  its arguments or output); `thinking` cut to 2,000 characters; result status,
  duration and pull request link. `origin` is `runner`, or `local` for the
  placeholder replies written without a runner.

The runner is the durable log of a chat. Beadsmith's copy lets a chat open
without the runner and catch up from where it left off.

## Beadsmith API

All under `/api/mate`. Mutations carry the usual `x-bdx-request: 1` header;
errors use the normal `{ error: { code, message } }` envelope.

| Route                                | Does                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/mate/status`               | `{ connected, reason?, reachable? }` for any signed-in viewer. `reason`: `admin_only` or `unconfigured`. `reachable`: cached runner health. |
| `GET /api/mate/chats`                | `{ chats }`, the caller's own, most recently active first.                                                                                  |
| `POST /api/mate/chats`               | `{ title?, scope? }` → `201 { chat }`. `409` past 100 chats.                                                                                |
| `GET /api/mate/chats/:id`            | `{ chat, events }`: the stored log, oldest first (the latest 2,000 events).                                                                 |
| `PATCH /api/mate/chats/:id`          | `{ title?, scope? }` → `{ chat }`. A new scope applies from the next message.                                                               |
| `DELETE /api/mate/chats/:id`         | Stops the runner session, then deletes the chat. If the runner cannot stop it, the chat stays (`503`) so the delete can be retried.         |
| `POST /api/mate/chats/:id/messages`  | `{ text, message_id? }` → `202`. With a runner: `{ event_id }`. Without: `{ events }`, the stored message and placeholder reply.            |
| `GET /api/mate/chats/:id/events`     | `text/event-stream`, below. `503` without a runner.                                                                                         |
| `POST /api/mate/chats/:id/interrupt` | `202`: stops the agent's current turn. The session keeps running.                                                                           |

`text` is trimmed and capped at 4,000 characters. `message_id`
(`[A-Za-z0-9_-]{1,64}`) is generated by the browser once per message and
reused when you retry a failed send, so the runner never sees a message
twice; the server makes one up when it is absent. Extra keys are refused.

The events stream first replays stored events after `Last-Event-ID` (or
`?after=`), then opens the runner's stream from the newest stored runner
event, stores each new event and forwards it. Each frame is
`id: <event id>` and `data: <MissionEvent JSON plus at>`. A runner failure is
an `event: runner_error` frame with `{ message }`, after which the stream
closes and EventSource reconnects. Closing the browser closes only this
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
	"scope": "d_beads_web"
}
```

→ `202 { "event_id": "e000041" }`, the id of the `user` event the runner
recorded for this message.

- The runner starts the session on first use (with this `session_id`) and
  keeps it alive. The same `session_id` comes with every message of a chat.
- A message sent while the agent is working is queued for it; there is no
  "busy" answer.
- `message_id` (1-64 characters of `[A-Za-z0-9_-]`) is unique per user
  message and reused on a retry. A repeat returns the same `202 { event_id }`
  and does not send the prompt to the agent again.
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
is `cancelled`.

### Delete

`DELETE /v1/mate/chats/{chat_id}` → `204`. Stops the session and forgets the
chat. `404` (never knew it) is fine too.

### Health

`GET /v1/health` → `{ "ok": true }`. Beadsmith caches the answer for 15
seconds and shows admins when the runner is not answering.

## Code

- Runner client: [`src/lib/server/mate/runner.ts`](../src/lib/server/mate/runner.ts)
- Storage: [`src/lib/server/mate/store.ts`](../src/lib/server/mate/store.ts)
- Relay and placeholder replies: [`src/lib/server/mate/service.ts`](../src/lib/server/mate/service.ts)
- Routes: [`src/routes/api/mate/`](../src/routes/api/mate/)
- Browser store and view: [`src/lib/client/mate-chat.svelte.ts`](../src/lib/client/mate-chat.svelte.ts),
  [`src/lib/components/mate-chat-view.svelte`](../src/lib/components/mate-chat-view.svelte)
- A fake runner for tests, which checks signatures and never opens a socket:
  [`src/lib/test/fake-mate-runner.ts`](../src/lib/test/fake-mate-runner.ts)
