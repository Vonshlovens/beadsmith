# 0019. Ralph loops run as missions in an hc terminal; Beadsmith owns schedules

Date: 2026-11-11

## Status

accepted. Extends [0006](./0006-durable-agent-dispatch.md) with a `loop`
dispatch operation and automations. Builds on
[0021](./0021-hc-terminal-runtime.md) (a loop's terminal runs ralph, which
starts a fresh agent session per iteration; see rule 2) and
[0018](./0018-sand-e2b-sandboxes.md) (Sand's template gains ralph). Models
its scheduler on [0010](./0010-in-app-backups.md).

## Context

Beadsmith launches one-shot missions (File, Tackle, comment, discuss): one
agent, one task, one sandbox. Some work is better done as a loop: a fresh
agent session per iteration, each taking the next item of a plan, with
validation between iterations and the plan as the only memory.
[ralph](https://github.com/Vonshlovens/von-ralph) is a public CLI that does
exactly that (`ralph build`, `plan`, `run`, `reverse` over Claude Code and
other harnesses), keeps a Beads-backed plan, records each iteration (outcome,
tokens, cost, commits, validation) and serves an HTTP + SSE API, `ralph serve`
under `/v1`: run records, iterations, a resumable event stream, steer (a note
for the next iteration), graceful or immediate stop, and restart. It also has
recurring runs through systemd user timers (`ralph schedule`).

Other work wants a schedule: a nightly build loop, a weekly plan refresh, a
daily triage comment. Beadsmith has no notion of either.

Forces:

- Beadsmith's own host runs no agents (it is a small VPS). Agents run on the
  runners: Sand sandboxes (0018) and the forge guest (0016).
- Every agent runs in an hc terminal inside its sandbox, and Beadsmith reaches
  that sandbox only through a channel it already controls; no port leaves the
  sandbox (0021 rule 1, 0015).
- Every launch goes through dispatch: arm, per-project allow, repository map,
  idempotency, the Missions record (0006). A run that starts any other way is
  invisible to the console and escapes the kill switch.
- ralph today has no tagged releases and no licence file. It has no HTTP route
  to add a sign (only `ralph sign` on the command line), no per-run epic scope
  (a run takes one `bead`, or free-text `scope`; epic and label scope are
  project config in `.ralph/ralph.toml`), and no worktree isolation. These
  are tracked in ralph's own repository; this record does not change ralph.

Out of scope: running ralph on Beadsmith's host or on a personal device;
using ralph for one-shot operations; ralph's own web UI.

## Decision

We will run ralph loops as Beadsmith missions inside the existing runners,
with ralph in the sandbox's hc terminal, and run schedules from Beadsmith.

1. **ralph is a loop runtime inside a runner, not a new place to run.** A
   loop runs where any mission runs: a Sand sandbox of its own, or the forge
   guest, picked like any mission's runner. ralph is installed in the Sand
   template and the forge guest from its public repository, pinned to a
   commit (with the Nix hash), in one pin file that both
   `sandbox/e2b/build-template.ts` and `nix/overlay.nix` read, as hc is
   pinned (0021 rule 5). Beadsmith never vendors or redistributes it, and the
   published app image does not contain it. A runner whose sandbox lacks
   ralph does not offer loops: the provider reports no `loop` capability and
   the launch is refused before a sandbox starts.

2. **The loop's terminal runs ralph.** Beadsmith launches a loop with hc's
   `terminal.run` of `ralph <mode>` in the foreground, with the loop's flags
   (harness, model, effort, iterations, iteration timeout, bead or scope), in
   the mission's checkout. ralph starts a fresh, headless agent session per
   iteration as its own children; that is the technique, so 0021 rule 2 (the
   interactive CLI) applies to one-shot missions and chats, not to the
   iterations ralph runs. An admin attaching to a loop through the 0021 relay
   sees ralph's terminal. Cancel kills the terminal (0021); restart starts a
   new terminal with the loop's stored parameters, not ralph's detached
   `restart`, so every run stays inside hc.

3. **Beadsmith reads and steers the loop through `ralph serve` inside the
   sandbox.** `ralph serve --no-web` binds the sandbox's loopback, so only
   processes in the sandbox reach it; those already hold the agent account's
   shell, which is why it needs no token there (the reasoning 0021 gives for
   hc). Beadsmith calls a fixed allowlist of `/v1` routes over the channel it
   already holds: on Sand, commands over the E2B process channel against
   loopback; on forge, the runner relays the same allowlist over its signed
   contract and SSH. The allowlist is run detail, iterations, report, the
   run's event stream (resumed by `Last-Event-ID`), steer, and stop
   (graceful or now). Beadsmith never forwards browser paths to ralph and
   never calls `POST /v1/runs`, schedules, or `restart`.

4. **One native module, not the webhook contract.** A single ralph client in
   Beadsmith (the `/v1` calls above and one mapping from ralph's events to
   the sanitized MissionEvent union, through the existing sanitizer and Dolt
   password scrubber) serves both runners. The webhook contract v1
   (`docs/file-tackle-dispatch.md`) stays as it is: it has no event stream,
   iterations, steer or graceful stop, and growing it into ralph's API would
   be a second copy. Raw ralph payloads never reach the browser. ralph's exit
   maps to mission status: 0 succeeded; 3 (plan exhausted or no progress)
   succeeded and marked as needing a person; an operator stop cancelled;
   anything else failed. Beadsmith follows the run itself, so ralph's
   `callbackUrl` is not used and the sandbox needs no inbound path to
   Beadsmith.

5. **A loop is a mission.** `loop` is a dispatch operation in
   `dispatch_requests`, not a separate table, and goes through
   `enqueueDispatch`: arm, per-project allow, the project's repository map,
   idempotency, the Missions list and MCP dispatch tools apply unchanged.
   Its payload holds mode (`build`, `plan`, `run`, `reverse`), prompt (`run`
   only), harness, model, effort, maximum iterations, iteration timeout and
   scope. Every mode writes Beads or code, so a loop needs Tackle allowed for
   the project, and it uses the project's Tackle repository mapping; loops add
   no fourth repository map (folding the existing maps into one is separate
   work). Iteration summaries (number, outcome, duration, tokens, cost,
   commit range, validation result) are copied into `state.db` as each
   iteration finishes, because a Sand sandbox and its ralph database are
   destroyed when the loop ends. Steer, graceful stop and restart are loop
   controls beside follow-up and cancel; a restart is a new turn on the same
   mission.

6. **Scope and isolation degrade to what ralph offers today.** A loop is
   scoped to the project's plan or to one bead. Epic or label scope waits for
   ralph's per-run scope; Beadsmith does not edit the checkout's
   `.ralph/ralph.toml` to fake it. Adding a sign waits for ralph's sign
   route, and a sign belongs in the repository's committed prompts anyway,
   where a destroyed sandbox cannot lose it. Isolation: a Sand loop has a
   sandbox to itself; on the shared forge guest Beadsmith runs at most one
   loop per repository checkout until ralph has worktree isolation.

7. **Beadsmith owns schedules.** An automation is a dispatch template (any
   operation, loops included) with a cron expression, a time zone, an overlap
   policy and an enabled flag, stored in `state.db` with a history of its
   fired slots. An in-process ticker, like the backup scheduler's (0010),
   checks every minute and fires due slots through `enqueueDispatch` with the
   idempotency key `automation:<id>:<slot>`, so a restart or a double tick
   cannot fire twice. Slots missed while Beadsmith was down fire once on boot,
   never as a catch-up storm. With the default overlap policy, a slot whose
   previous mission is still running is skipped and recorded as skipped. A
   fired dispatch's actor is the automation on behalf of its creator, and it
   is checked like a launch by that creator: disarming dispatch or
   disallowing the project stops automations, and an automation whose creator
   is no longer an admin is paused. ralph's own schedules (`ralph schedule`,
   systemd user timers) are not used.

## Consequences

Admins start a loop where they start any mission, watch its iterations in
the mission thread, steer or stop it, and schedule it, and all of that shows
in Missions with the same policy and kill switch as a Tackle. Sand loops need
no machine of the operator's.

ralph becomes a runtime dependency of the runners, fetched at template and
guest build time from a commit pin. Without a licence file its terms are
unclear; Beadsmith only fetches it into the operator's own sandboxes and does
not ship it. A tagged release, if ralph gets one, replaces the commit pin.

A loop's iterations are headless sessions, so admins attaching to a loop see
ralph's progress output, not an interactive CLI, and cannot answer an
iteration's question by typing; ralph records it as needing a person and the
mission says so.

A Sand loop is bounded by E2B's session limits and loses unpushed commits if
its sandbox is lost; how and when a loop pushes is for the Sand loop work to
settle, within 0018's credential rules (nothing new enters the sandbox but the
project's scoped Dolt account). Loops on forge wait for the guest's scoped
Beads and repository access (0015's target; 0016 gives the guest neither
today).

Not doing: ralph's systemd schedules, which would start runs outside dispatch
and outside the Missions record, on whichever machine holds the timer, and
which an ephemeral sandbox cannot keep; ralph's web UI; ralph for one-shot
operations (they stay on the session core of 0021, so there is one path per
kind of work); a webhook contract v2.

## Alternatives considered

**A standalone `ralph` provider pointed at a reachable `ralph serve`.** One
URL and token in Beadsmith's configuration, `POST /v1/runs` to launch. It
needs `ralph serve` listening beyond its machine, which can start arbitrary
agents on it, and its runs would be detached processes outside hc, so the
admin relay could not reach them. Running ralph inside the existing runners
reuses their channels and their isolation.

**Extend the signed webhook contract.** Keeps one contract for every runner,
but it would grow event streams, iteration records, steer and graceful stop:
a copy of ralph's API under another name.

**Loops in their own table.** Separates loop records from missions, but every
policy check, idempotency rule, list and MCP tool would need a second path.

**Run each iteration as an interactive CLI driven by Beadsmith.** Keeps 0021
rule 2 literally, but reimplements ralph (plan selection, validation,
iteration records) in Beadsmith.

**Schedules in ralph.** Its timers already exist, but they bypass dispatch
policy, need a long-lived machine, and are invisible to Beadsmith.

## Implementation notes

Nothing ships with this record. Planned, each in its own change:

- the ralph pin file and ralph in the Sand template and forge guest, beside
  hc's pin (`sandbox/e2b/build-template.ts`, `nix/overlay.nix`);
- the ralph `/v1` client and event mapping, under
  `src/lib/server/dispatch/`, tested against a fake `ralph serve`.
  Shipped as `src/lib/server/dispatch/ralph.ts` (fake in
  `src/lib/test/fake-ralph.ts`): the runner supplies the channel as a
  `RalphFetch`, and `ralphRouteAllowed` is the allowlist a relay checks.
  Rule 4's mapping reads ralph's stop reason before its exit code, because
  ralph exits 0 after a graceful operator stop; the code decides only when
  no reason was recorded. ralph's tool events carry no call id, so a result
  answers the oldest open call of its iteration. Iteration boundaries are
  not thread events; iterations reach the mission as records;
- the `loop` operation (`src/lib/types.ts` `DispatchOperation`,
  `src/lib/server/dispatch/types.ts`, `state/schema.ts`), loop capability
  per provider, iteration rows, and the Sand loop runner.
  The operation, capability and iteration rows shipped: `LoopPayload` holds
  the flags, `AgentProvider.launchLoop` is the capability (no provider has it
  until a runner carries ralph, so every loop launch is refused today), and a
  run update's `iterations` are stored in `dispatch_loop_iterations`. A loop
  requires an iteration limit (1 to 200), a `run` loop requires its prompt
  and the other modes refuse one, and bead scope is for `build` and `run`
  only, as ralph's `--bead` is. A loop refuses follow-up: a one-shot agent in
  its checkout would run outside ralph.
  The Sand loop runner shipped in `src/lib/server/dispatch/e2b-provider.ts`
  (`launchLoop`), with ralph's pin in `nix/ralph.json` (repository and
  commit; ralph runs from source on the template's Node, its dependencies
  from its own lockfile). The Nix hash joins the pin when `nix/overlay.nix`
  first builds ralph, for the forge guest; the overlay does not read the
  pin yet. Beadsmith starts two hc terminals in the checkout, `ralph serve
  --no-web` and `ralph <mode> --name bdx-<mode>-<id> --no-observer …`, and
  reaches `/v1` with curl to loopback over the E2B process channel
  (`src/lib/server/e2b/ralph-transport.ts`). Its observer is off because
  Beadsmith keeps none of its summaries. A loop sandbox is created to be
  destroyed, not paused, on timeout; a loop that outlives
  `BDX_E2B_MAX_RUN_MINUTES` is cut off with it. Pushing: the loop's checkout
  gets a write-scoped GitHub token at the egress, as Tackle's does, and
  ralph's prompts decide when to push;
- loop controls and the loop UI on project, epic, issue and mission pages;
  The data the UI reads shipped first: a loop mission's public record
  carries `loop` (its flags, and once a run ends, `stop_reason` and
  `needs_person`, stored in `dispatch_requests` and cleared by a restart),
  and `GET /api/projects/:id/dispatch/:requestId/iterations` returns its
  iteration rows. ralph's mode, harness, stop reason and outcome lists live
  in `src/lib/ralph.ts` so the browser and the server read one copy. The
  launch UI has shipped: `src/lib/components/loop-dialog.svelte`, opened from
  the project page, an issue or epic page and the agent dialog, offers a loop
  on the bead, a plan-wide build and a plan refresh. It shows only when some
  runner reports `capabilities.loop`, and explains a refusal (disarmed, the
  picked runner has no ralph, Tackle not allowed). Without epic scope, an
  epic page says its build covers the whole plan;
- automations: tables, the ticker beside `src/lib/server/backup/runtime.ts`,
  and an automations page. ADR-0004's list of what `state.db` holds and
  `docs/contract.md`'s dispatch section are updated when these ship.
  The tables and ticker shipped in `src/lib/server/automations/`
  (`cron.ts`, `store.ts`, `scheduler.ts`, `runtime.ts`); the page and its
  API are still to come. Cron is a small five-field parser in the repository
  rather than a dependency; like ralph's, it refuses an expression that
  restricts both day of month and day of week. Each automation keeps a
  cursor (`last_slot`), starting at creation and reset when it is
  re-enabled, so neither fires a slot from before. A tick claims only the
  latest due slot (the run row's primary key is the once-only guard), then
  fires it with the idempotency key `automation:<id>:<slot>`; a slot a crash
  left claimed is finished on the next tick, and finds its mission by that
  key if it had already launched. The `queue` overlap policy holds at most
  one slot behind a running mission and skips any later one. The mission
  actor is `automation:<id> for <creator email>`, and the creator's account
  is read on every fire: a missing, banned or non-admin creator pauses the
  automation. Run now (`fireAutomationSlot` with a `manual` slot) neither
  waits nor skips for a running mission and does not move the cursor.

The architecture bullet is in [`specs/README.md`](../README.md).
