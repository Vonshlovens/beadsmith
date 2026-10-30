# File and Tackle dispatch

- **Status:** Implemented behind configuration. Off unless a dispatch provider
  is configured **and** dispatch is globally armed.
- **Companions:** [contract.md](./contract.md),
  [agent-access.md](./agent-access.md),
  [server-deployment.md](./server-deployment.md).

## What this is

The beads-web UI can **File** a new issue, **Tackle** an existing one, and
**comment** on an issue. Those buttons do not create, claim, close, or write
Beads comment rows. They enqueue a durable control-plane request and launch an
agent through the configured provider. That agent is the worker: it runs `bd`
in whatever environment the provider gives it.

```text
browser (File / Tackle / board Confirm / comment)
  -> beads-web validates, authorizes, persists
  -> dispatch provider (today: a webhook runner, POST {base}/agents)
  -> beads-web follows the run (live events when the provider has them, else polling)
  -> agent on the mapped GitHub checkout, or the runner's default
  -> bd against the project's Dolt database
```

This is the durable agent-worker boundary from the contract. Dispatch is
provider-neutral: see [Providers](#providers) for the webhook runner, for
turning dispatch off, and for adding a provider.

## Providers

`BDX_DISPATCH_PROVIDER` picks exactly one provider:

| Value     | Worker                                                | Needs                                                                           |
| --------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `webhook` | Any runner implementing the contract below            | `BDX_DISPATCH_WEBHOOK_URL`, `BDX_DISPATCH_WEBHOOK_SECRET_FILE` (32+ characters) |
| `none`    | Dispatch off: File/Tackle/comment hidden, API refuses | nothing                                                                         |

Unset means `none`. A provider missing its configuration is inactive, and the
console says why. Each mission records the provider that launched it; after a
switch, older missions keep their stored state and are never sent to the new
provider. Missions from a provider this build no longer has show their stored
result and refuse cancel and follow-up.

A native provider (for example Overalls microVMs) implements
`AgentProvider` in `src/lib/server/dispatch/provider.ts`: launch, latest run,
and run status are required; follow-up, cancel, and live run events are
optional capabilities the console adapts to. It adds its id to
`DispatchProviderId`, a row to `PROVIDER_CAPABILITIES`, and a branch to
`getAgentProvider`. The queue, policy, checkout maps, prompts, and UI stay as
they are.

### Webhook runner contract (version 1)

Paths are relative to `BDX_DISPATCH_WEBHOOK_URL` (https, or http on loopback).
Bodies and responses are JSON.

| Request                                          | Body                                                                        | Response                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST /agents`                                   | `{version, name, prompt, auto_create_pr, repository?: {url, starting_ref}}` | `{agent_id, run_id?, agent_url?}`                                                                     |
| `GET /agents/{id}/latest-run`                    | —                                                                           | `{run_id}`; 404 when none yet                                                                         |
| `GET /agents/{id}/runs/{run}`                    | —                                                                           | `{status: running\|succeeded\|cancelled\|failed, summary?, duration_ms?, pr_url?, issue_id?, error?}` |
| `POST /agents/{id}/runs` (optional)              | `{version, prompt}` (follow-up)                                             | `{run_id}`                                                                                            |
| `POST /agents/{id}/runs/{run}/cancel` (optional) | —                                                                           | any 2xx                                                                                               |

Every request has `x-beadsmith-contract: 1`, `x-beadsmith-timestamp` (unix
seconds) and `x-beadsmith-signature: v1=<hex>`: HMAC-SHA256 under the shared
secret of `<timestamp>.<METHOD> <path>\n<body>` (empty body for GET). Verify
it with a constant-time compare and reject timestamps older than five
minutes. Ids must match `[A-Za-z0-9._:-]{1,128}`; `agent_url` must be https;
`issue_id` is optional: the bead a File run created. When it is a valid issue
id, a todo routed to this dispatch links to it; it is not
otherwise stored or shown. `pr_url` is shown only when it is a GitHub pull request URL. Reply 404, 405,
or 501 to an optional endpoint you do not support; Beadsmith then tells the
user follow-up or cancel is unavailable. There are no live events: Beadsmith
polls run status and shows the final result.

The runner checks out the repository (or its own default when the request has
none), runs the `/file` or `/tackle` instructions in the prompt with `bd`
against the project's Dolt database, and reports back.

## Mapping from `/file` and `/tackle`

A private skills repository is the source of the workflow
names. This service cannot read that repository. The launched agent is
told to follow the in-repo skills and then run `bd`:

- `.agents/skills/file/SKILL.md`
- `.agents/skills/tackle/SKILL.md`
- `.agents/skills/comment/SKILL.md`

The launch prompt in `src/lib/server/dispatch/prompts.ts` points at those files
and names the target Dolt database / issue. beads-web never executes `bd`.

| UI action      | Agent job                                                                                    | `bd`                                                        | Pull request                              |
| -------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| **File**       | Turn operator notes into well-structured Beads issue(s). Do not implement.                   | `bd create` (and deps/labels as needed)                     | No                                        |
| **Tackle**     | Claim the issue, implement it if this checkout is the matching codebase, close it when done. | `bd show`, `bd update --claim`, `bd close`                  | Yes, when there are code changes          |
| **Board drop** | Same enqueue as Tackle, with optional `destination_status`. Card does not move.              | Destination-specific (`--claim`, `--status`, or `bd close`) | Only start-work (`in_progress` / omitted) |
| **Comment**    | Add one human comment to an existing issue. Do nothing else.                                 | `bd comments add`                                           | No                                        |

Board drag is not a status PATCH. Dropping a card onto
another column opens a confirm modal; Confirm POSTs
`{ operation: "tackle", issue_id, destination_status?, idempotency_key }`.
Same-column drops are a no-op. `pinned` and `hooked` are not drop targets.
If dispatch is disarmed or Tackle is denied for the project, Confirm stays
disabled and the card stays put.

| `destination_status`    | Agent job                                           |
| ----------------------- | --------------------------------------------------- |
| omitted / `in_progress` | Existing /tackle start-work prompt                  |
| `closed`                | Check whether work is finished; close only if it is |
| `blocked`               | Investigate blockers; set blocked if appropriate    |
| `deferred`              | Park the issue as deferred                          |
| `open`                  | Unclaim / return to the ready queue                 |

## Configuration

None of these values belong in the repository, a dotenv file, or the browser.

| Variable                           | Meaning                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `BDX_DISPATCH_PROVIDER`            | `webhook` or `none`; unset means `none`.                                                                             |
| `BDX_DISPATCH_WEBHOOK_URL`         | Base URL of the webhook runner: https, or http on loopback only. No credentials, query, or fragment.                 |
| `BDX_DISPATCH_WEBHOOK_SECRET_FILE` | Preferred path to the shared HMAC secret (32+ characters), e.g. `/run/secrets/dispatch-webhook-secret` with Compose. |
| `BDX_DISPATCH_WEBHOOK_SECRET`      | Local/development fallback only.                                                                                     |

The File and Tackle controls stay hidden until a provider is configured
**and** dispatch is armed (`GET /api/status` → `dispatch.enabled`).
`key_configured` (a usable provider is configured) and `armed` are split so the
operator console can show the kill switch separately from the provider
configuration. A configured-but-unreadable secret file still reports
`key_configured`; the launch then fails closed with a sanitized error.

Operators manage catalog coverage from `/console` (and `GET /api/console`):
every discovered `d_*` project, whether a Tackle map exists, whether that
map came from env/file (`source: env`) or the console (`source: sqlite`),
and whether File and/or Tackle are allowed. Map values shown there are public
GitHub URL / ref / `auto_create_pr` only — never credential paths or the raw
env JSON.

`PUT /api/console/dispatch` `{armed}` arms or disarms File/Tackle without
touching the provider configuration. Missing SQLite policy defaults to armed with
both operations allowed. `PUT /api/console/projects/:id/allow` `{file, tackle}`
sets per-project allow. Extra keys fail closed. Enqueue refuses a disallowed
operation with a sanitized message and does not call the provider. Unmapped Tackle
still fails closed even when Tackle is allowed. File/Tackle POST still cannot
pass `armed`, `file`, `tackle`, a repository, or a prompt template.

`PUT` / `DELETE /api/console/projects/:id/tackle-map` write SQLite on this
service. Env/file (`BDX_TACKLE_REPOSITORIES` / `_FILE`) still overrides a
console row for the same project; the console cannot clear an env map.
Clearing a console map returns that project to fail-closed Tackle without a
restart. File launches without a checkout, so the runner uses its default,
unless a per-project File checkout map is set.

`PUT` / `DELETE /api/console/projects/:id/file-map` write an optional File
checkout (`{url, ref?}` only; `autoCreatePR` is always false). Unset returns
File to the runner's default checkout. A present-but-invalid map fails closed and
does not fall back to the runner's default. Clearing or editing a File map never changes
a Tackle row, and vice versa.

If the env/file JSON is present but unusable, every project is treated as
unmapped until that config is fixed.

## Where the webhook secret goes (operator)

The shared secret belongs to the **Beadsmith server process** and the runner,
nowhere else: not in `.env`, `compose.yaml`, the runner's agent environment, or
the browser. The agents the runner starts need Dolt access to run `bd`, not
this secret.

Next to `compose.yaml`:

```sh
(umask 077; openssl rand -hex 32 > secrets/dispatch-webhook-secret)
```

Then in `.env`:

```sh
BDX_DISPATCH_PROVIDER=webhook
BDX_DISPATCH_WEBHOOK_URL=https://runner.example.com/beadsmith
BDX_DISPATCH_WEBHOOK_SECRET_FILE=/run/secrets/dispatch-webhook-secret
```

Give the runner the same secret through its own secret store, then apply with
`docker compose up -d`. The console's Dispatch row shows `Webhook agent
runner`, or why the provider is inactive. Signed in, File and Tackle appear
once dispatch is armed.

Rotation: replace the secret on both sides, then `docker compose restart`. A
changed file does not update a running process.

## Request contract

`POST /api/projects/:id/dispatch` accepts only:

- `{ operation: "file", idempotency_key, notes, title?, issue_type?, priority?, labels?, status? }`
- `{ operation: "tackle", idempotency_key, issue_id }`
- `{ operation: "comment", idempotency_key, issue_id, text }`
- `{ operation: "discuss", idempotency_key, issue_id, intent, message? }` with
  `intent` one of `discuss`, `elaborate`, `close`

Discuss is the issue page's agent button (key `a`): the worker follows
`.agents/skills/discuss/SKILL.md` and either talks the issue through, rewrites
its description and acceptance criteria, or closes it with a reason, all with
`bd`. It uses the Tackle checkout when the project has one, never opens a PR,
and continues as a conversation through follow-up. A plain discussion is
allowed when File or Tackle is allowed; `elaborate` and `close` need Tackle.
The public record carries `intent` but never the message.

Comment launches the File checkout (beads-web, no PR) and is allowed when File
or Tackle is allowed for the project. The browser cannot set `author`; the
control plane copies the Access email (or `web`). Public GET omits comment
text the same way it omits File notes.

`status` on File is a StatusKey (`open`, `in_progress`, `blocked`,
`deferred`, `closed`, `pinned`, `hooked`). The board column "+ New" action
sends it so the filing agent can `bd create` then `bd update --status`.
`open` is omitted (create default).

The control plane records an opaque request id, actor (Access email when
present, otherwise `web`), project, operation, payload, and idempotency key
**before** calling the provider. A replay with the same key and same payload returns
the original record and does not launch a second agent.

`GET /api/projects/:id/dispatch/:requestId` returns the sanitized record:
`id`, `project_id`, `operation`, `status`, optional `provider`, optional
`issue_id`, optional `agent_id` / `agent_url`, `created_at`, `updated_at`, and
these terminal result fields when the provider supplies them:

- `result_summary` — bounded, credential-scrubbed final assistant text;
- `duration_ms` — the runner's terminal run duration; and
- `git_pr_url` — a validated `https://github.com/.../pull/:number` URL.

Failed records may also include a sanitized `error_message`. The response never
contains provider credentials, the launch prompt/payload, actor, idempotency
key, or run id.

`GET /api/projects/:id/dispatch/:requestId/turns` is the conversation the agent
console renders: `{turns: [{seq, role, text, run_id?, status?, created_at}]}`,
where `role` is `operator` (the request and each follow-up) or `agent` (each
finished run's sanitized summary or error, once per run). It is display state
in `dispatch_turns`, never the launch prompt or worker logs.

`GET /api/status` reports `dispatch.capabilities` for the active provider:
`live_events`, `follow_up`, and `cancel`. `webhook` has no live events, so the
console polls run status and shows the reply when the run finishes. Follow-up
and cancel are optional for a webhook runner; when it answers 404 the console
shows that refusal.

The durable status machine is:

```text
queued -> launching -> launched -> running -> succeeded
                    \-> failed     |       \-> cancelled
                                    \--------> failed
```

`launching -> failed` means the provider could not start the agent. A later
`failed` means the launched run reported failure; `cancelled` remains
distinct. A run may move directly from `launched` to a terminal state when the
first observed status is terminal.

After launch, the Beadsmith server follows the run without blocking the
File/Tackle response: through the provider's live stream when it has one, and
otherwise (or after the stream expires, disconnects, or errors) by
bounded-backoff status polling. Public GET also performs one authoritative run
refresh and restarts the background follower for `launched`/`running` records,
so state converges after a process restart. When launch did not return a run
id, the follower asks the provider for the agent's latest run; if there is
still none, the durable status stays `launched`.

`GET /api/projects/:id/dispatch/:requestId/stream` is the live/replay view of
that run. A provider with live events maps them onto a fixed MissionEvent
union (`user`, `assistant`, `thinking`, `tool_call`, `result`, `error`)
defined in `src/lib/mission-events.ts`; the browser EventSource consumes those
named events only. Tool `args`/`result` (file bodies, PTY) are not forwarded.
Text is credential-scrubbed and stripped of ANSI. When the provider has no
live events or the stream has expired, the proxy emits a `result`
reconstructed from the durable row.

`POST /api/projects/:id/dispatch/:requestId/cancel` cancels the active run.
`POST .../follow-up` with `{text}` (max 4000 characters, extra keys fail
closed) creates a new run on the same agent. Both need the provider to support
them. The browser cannot set repo, model, or shell. While the durable status
is `launched` or `running`, follow-up is refused and the composer is
disabled. Cancel remains available on an in-flight run even when dispatch is
disarmed. Follow-up still requires the global arm and the original File/Tackle
allow.

## What still has to be true operationally

1. **A runner whose agents can run `bd`.** The agent the provider starts
   needs `bd`, network access to your Dolt server, and a Dolt credential held
   by the runner, never by Beadsmith. A just-in-time agent without that bridge
   cannot file or claim issues. Prefer a short-lived, least-privilege Dolt
   user per agent over a shared writer password.
2. **Provider configuration on the Beadsmith server.** See
   [Where the webhook secret goes](#where-the-webhook-secret-goes-operator).
3. **Cross-repo code.** Tackle needs a checkout map for the project; without
   one it fails closed. A Tackle of an issue whose code lives in a repository
   other than the mapped checkout is told to stop rather than invent unrelated
   patches.
4. **Agent-access slice 1** (service-token reads of beads-web) is independent.
   File/Tackle agents use `bd`, not the public JSON catalog.

## Security invariants

- The web process still does not ship or invoke `bd`.
- Provider credentials (the webhook secret) never enter SQLite, logs, URLs, or
  API responses.
- Dispatch payloads are a small validated schema. The browser cannot choose a
  prompt, repository, model, or shell command.
- Idempotency is enforced in service-local SQLite, not by trusting the
  provider.
- Failed launches stay on the record as `failed` with a generic or
  already-safe message.
- Runner result text is truncated and credential-scrubbed before persistence;
  only canonical HTTPS GitHub pull-request URLs are stored.
- Mission stream UI renders the canonical event union, not raw runner events.
