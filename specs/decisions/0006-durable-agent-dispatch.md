# 0006. Durable agent-worker dispatch

Date: 2026-08-17 (updated 2026-09-03, 2026-10-17, 2026-10-28 provider-neutral)

## Status

accepted

## Context

Today the web process only reads Beads. People still want to file work,
start work, and talk an issue through from the browser, and most of that is
work for an agent rather than a field edit: filing well means reading the
code, tackling means implementing. So the browser authorizes and persists a
request, and an agent that runs `bd` does the work.

The kanban board raised the same question: a human dropping a card onto
another status column looks like a PATCH of `issues.status`. On 2026-08-17
drag became an agent-dispatch intent, not a status write: moving a card to
In progress usually means "start this", and to Closed means "check this is
done", which a bare status change skips.

## Decision

We will persist an authorized dispatch request, then launch an agent
through one configured provider as the worker. beads-web never runs `bd`.

Dispatch is provider-neutral. Providers
(`src/lib/server/dispatch/provider.ts`): `webhook` (any runner implementing
the signed contract in `docs/file-tackle-dispatch.md`) or `none` (dispatch
off). `BDX_DISPATCH_PROVIDER` selects one; unset means `none`. Launch, latest
run, and run status are required; follow-up, cancel, and live events are
optional capabilities. Each request row records its `provider`, and a mission
is only ever followed, cancelled, or resumed by the provider that launched it.
A native provider (Overalls microVMs or a custom runner)
implements `AgentProvider` and plugs in without touching the queue, policy,
maps, prompts, or UI.

```text
browser (File / Tackle / board Confirm / comment / discuss)
  -> beads-web validates, authorizes, persists
  -> the configured provider (today a webhook runner)
  -> agent in the mapped GitHub checkout, or the runner's default
  -> bd against the project's Dolt database
```

File and comment launch without a checkout unless the project has a File
checkout map (`file_checkout_maps`, `{url, ref}`, `autoCreatePR` false); the
runner then uses its own default. A present-but-invalid File map fails closed
and does not fall back. Tackle maps stay separate (`tackle_repository_maps`
plus env overlay), and Tackle without one fails closed. The browser cannot
choose a repository on `POST /api/projects/:id/dispatch`.

Cursor Cloud Agents was the first provider and the default when a Cursor key
was set. The owner phased it out on 2026-10-27; its client,
key handling, and Cloud `bd` pack were removed, and the state columns
`cursor_agent_id` / `cursor_agent_url` / `cursor_run_id` were renamed to
`agent_id` / `agent_url` / `run_id` on startup.

The control plane records an opaque request id, authenticated actor,
authorized project, operation, validated payload, idempotency key, and
status **before** acknowledging the request and before calling the provider.
A replay with the same key and the same payload returns the original
record and does not launch a second agent.

Shipped operations on `POST /api/projects/:id/dispatch`:

- `{ operation: "file", idempotency_key, notes, title?, issue_type?,
  priority?, labels?, status? }` — worker follows
  `.agents/skills/file/SKILL.md` and files with `bd create`. When
  `status` is a non-open StatusKey, the worker then `bd update --status`
  (or `bd close` for closed). Open is the create default, so that field
  is omitted. No PR.
- `{ operation: "tackle", idempotency_key, issue_id }` — worker follows
  `.agents/skills/tackle/SKILL.md`, claims, implements when this checkout
  is the matching codebase, and closes when done. PR when there are
  code changes.
- `{ operation: "comment", idempotency_key, issue_id, text }` — worker
  follows `.agents/skills/comment/SKILL.md` and adds one comment with
  `bd comments add`. Author comes from the Access session, not the
  browser. No PR. Launch uses the File checkout, not a Tackle map. Allowed when File or Tackle is allowed for the project.
- `{ operation: "discuss", idempotency_key, issue_id, intent, message? }`
  — worker follows `.agents/skills/discuss/SKILL.md`.
  `intent` is `discuss` (talk the issue through, change nothing unless a
  follow-up asks), `elaborate` (rewrite description and acceptance criteria
  with `bd update`), or `close` (`bd close --reason`). No PR. Launch uses
  the project's Tackle checkout when one is mapped, otherwise none. A plain
  discussion is allowed when File or Tackle is allowed; `elaborate` and
  `close` change the issue, so they need Tackle allowed.

Launch prompts live in `src/lib/server/dispatch/prompts.ts`. The browser
cannot choose a prompt, repository, model, or shell command. Operators set
File and Tackle checkouts from the console, not from File/Tackle POST.

Dispatch stays off unless a provider is configured and the service-local
global arm is on (`GET /api/status` → `dispatch.enabled`). The global arm is an
operator kill switch independent of the provider configuration. Each project
also has File and Tackle allow booleans; missing policy defaults to armed with
both operations allowed so existing deployments continue to work. The service
resolves this policy from SQLite and rejects a disarmed or denied operation
before persisting or calling the provider. Dispatch POST bodies cannot set or
override policy.

Provider credentials (the webhook shared secret) belong on the beads-web
process: `BDX_DISPATCH_WEBHOOK_SECRET_FILE` preferred,
`BDX_DISPATCH_WEBHOOK_SECRET` a local/dev fallback. They must never enter
SQLite, logs, URLs, API responses, or the agents' environment. The agents a
runner starts get only what they need to run `bd` (Dolt access) and do not
launch further agents.

A human dropping a kanban card onto another status must not PATCH the
issue. The accepted UI is a confirm modal that dispatches an agent
(in_progress → `/tackle`; closed → check whether the work is finished;
other columns follow the map in `src/lib/client/board-dispatch.ts`). The
card stays in its source column until the worker changes Beads via `bd`.
Keyboard uses the same modal and mapping. Same-column drop is a no-op. If
dispatch is not configured, Confirm stays unavailable rather than falling
back to a status PATCH.

## Consequences

File, Tackle, and comment are control-plane launches, not SQL writes. Losing
`state.db` loses in-flight dispatch records, not Beads issues
([0004](./0004-service-local-sqlite.md)).

Public `GET /api/projects/:id/dispatch/:requestId` returns a sanitized
record: id, project, operation, status, provider, optional issue id and
agent id/URL, timestamps, and a failed-only error message. It omits
provider credentials, prompt, actor, payload, and idempotency key.

Board drag-dispatch and keyboard/AT dispatch are shipped: dropping a card,
pressing M, or using Send to agent opens the same confirm modal and enqueues
`operation: "tackle"` with optional `destination_status`. The card stays in
its source column. `pinned` and `hooked` are not drop or menu targets.
Column "+ New" is File dispatch with optional `status`,
not a web-process create or PATCH. Hide it when File is not allowed.

The shipped dispatch schema accepts `file`, `tackle`, `comment`, and
`discuss`. Board
destinations are not extra `operation` values; they are Tackle payloads
with `destination_status` (`open` | `in_progress` | `blocked` | `deferred`
| `closed`). Omitting it is the original /tackle start-work path.

## Alternatives considered

**PATCH status on drop.** Rejected 2026-08-17 for the board: a drop
usually asks for work (start it, verify it is done) that a status write
skips. A future issue editor may still change fields directly; that is a
separate feature, not the board gesture.

**Run `bd` in the web process.** Rejected: the web runtime would need a
workspace mount, a `bd` binary, and the writer SQL role, and the work
behind File and Tackle still needs an agent with a checkout.

## Implementation notes

Shipped:

- Design: `docs/file-tackle-dispatch.md`. Contract: `docs/contract.md`
  (durable agent-worker dispatch boundary).
- Persist then launch: `src/lib/server/dispatch/service.ts`
  (`enqueueDispatch`, `toPublicDispatch`). Store:
  `src/lib/server/dispatch/store.ts` (`dispatch_requests`, ids `dq_` +
  32 hex). Providers: `src/lib/server/dispatch/provider.ts`
  (`AgentProvider`, `getAgentProvider`), webhook runner
  `src/lib/server/dispatch/webhook-provider.ts`, output scrubbing
  `src/lib/server/dispatch/sanitize.ts`.
- Prompts and skills: `src/lib/server/dispatch/prompts.ts`,
  `.agents/skills/file/SKILL.md`, `.agents/skills/tackle/SKILL.md`,
  `.agents/skills/comment/SKILL.md`.
- HTTP: `src/routes/api/projects/[id]/dispatch/+server.ts` (actor is
  Access email when present, otherwise `web`),
  `src/routes/api/projects/[id]/dispatch/[requestId]/+server.ts`,
  `src/routes/api/projects/[id]/dispatch/[requestId]/stream/+server.ts`
  (canonical MissionEvent SSE proxy).
  Schema: `src/lib/server/validation.ts` (`dispatch_schema`).
  Event union: `src/lib/mission-events.ts` (`user` / `assistant` /
  `thinking` / `tool_call` / `result` / `error`), filled by a provider's
  optional `streamMissionEvents`. Stream UI:
  `src/lib/components/mission-event-stream.svelte`. Cancel:
  `POST /api/projects/:id/dispatch/:requestId/cancel`. Follow-up:
  `POST /api/projects/:id/dispatch/:requestId/follow-up` (`follow_up_schema`,
  text only). Steer UI: `src/lib/components/agent-thread.svelte`.
- Webhook secret: `resolveWebhookSecret` in `webhook-provider.ts`
  (`BDX_DISPATCH_WEBHOOK_SECRET_FILE`, `BDX_DISPATCH_WEBHOOK_SECRET`).
  Operator: `secrets/dispatch-webhook-secret` with `compose.yaml`
  (`docs/file-tackle-dispatch.md`).
- Safety policy: `src/lib/server/dispatch/policy.ts`, stored as
  `settings.dispatch.armed` plus `dispatch_project_allows`. Operator writes
  use `PUT /api/console/dispatch` and
  `PUT /api/console/projects/:id/allow`; public status exposes only effective
  enablement and per-project allow values. Board confirm is gated on
  effective dispatch plus per-project Tackle allow; it never PATCHes status.
- File checkout maps: `src/lib/server/dispatch/file-maps.ts`,
  `PUT` / `DELETE /api/console/projects/:id/file-map`. Tackle maps remain
  `src/lib/server/dispatch/tackle-maps.ts`.
- UI: `src/lib/components/file-issue-dialog.svelte`,
  `src/lib/components/tackle-issue-dialog.svelte`,
  `src/lib/components/comment-composer.svelte`,
  `src/lib/components/agent-thread.svelte` (cancel + follow-up on a mission).
  Hidden until effective dispatch and the relevant per-project operation
  are enabled (File/Tackle launch). Steer is on an already-launched mission.
  Board dispatch uses
  `src/lib/components/issues-board.svelte` (pointer drag + arrow-key focus),
  `src/lib/components/board-card.svelte` (Send to agent menu, M shortcut),
  `src/lib/components/board-dispatch-dialog.svelte` (confirm),
  `src/lib/client/board-dispatch.ts` (destination → skill map),
  `src/lib/client/board-keyboard.ts` (focus movement).
  Board column create opens File with optional `status` via
  `src/lib/components/issues-board.svelte`; `open` skips the follow-up
  status write.
- Tests: `src/lib/server/dispatch/service.test.ts`,
  `src/lib/server/dispatch/store.test.ts`,
  `src/lib/server/dispatch/prompts.test.ts`,
  `src/lib/server/dispatch/provider.test.ts` (provider selection, webhook
  contract, routing),
  `src/lib/mission-events.test.ts`,
  `src/routes/api/projects/[id]/dispatch/server.test.ts`,
  `src/routes/api/projects/[id]/dispatch/[requestId]/stream/server.test.ts`,
  `src/routes/api/projects/[id]/dispatch/[requestId]/cancel/server.test.ts`,
  `src/routes/api/projects/[id]/dispatch/[requestId]/follow-up/server.test.ts`,
  `src/lib/client/board-dispatch.test.ts`,
  `src/lib/client/board-keyboard.test.ts`.

Accepted, not shipped:

- Collapse-on-dragover policy is documented in
  `src/lib/client/board-prefs.ts` (`COLLAPSED_COLUMN_DROP`). Keyboard moves
  into a collapsed column use the same helper.

Related: [0004](./0004-service-local-sqlite.md) (idempotency store),
[0008](./0008-runtime-and-deployment.md) (provider secret on the host, not
in the app image).

## Conversation turns

Each mission keeps a short transcript in `dispatch_turns`: the operator's
request (File notes, comment text, a discuss message, or a sentence naming
the Tackle destination), each follow-up, and each finished run's sanitized
reply or error, one agent turn per run. `GET
/api/projects/:id/dispatch/:requestId/turns` returns it for the project that
owns the mission. It never contains the launch prompt, raw worker logs, or
credentials. Missions recorded before turns existed get a two-turn transcript
rebuilt from the durable row.

`GET /api/status` → `dispatch.capabilities` says what the active provider can
do (`live_events`, `follow_up`, `cancel`), so the console streams events when
it can and otherwise polls status, and disables the composer with a reason
when a provider cannot take follow-ups. A new provider declares its row in
`PROVIDER_CAPABILITIES` (`src/lib/server/dispatch/provider.ts`).

