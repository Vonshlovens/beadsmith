# 0021. Every agent runs in an hc terminal; admins can attach to it

Date: 2026-11-11

## Status

accepted. Implements two planned pieces of
[0015](./0015-scoped-agent-sandboxes.md): the terminal runtime provider and
the admin terminal relay (rule 5). Amends
[0016](./0016-first-mate-worker-runtime.md) (the forge guest runs Claude Code
in an hc terminal instead of a headless stream-json process) and
[0018](./0018-sand-e2b-sandboxes.md) (Sand missions and chats do the same,
and "no Sand terminal relay" is lifted). Leaves
[0020](./0020-first-mate-crew-tools.md)'s crew tools unchanged. [0019](./0019-ralph-loops-and-automations.md)
runs ralph in a loop mission's terminal; rule 2's interactive CLI applies to
one-shot missions and chats, not to the iterations ralph starts.

## Context

Every agent Beadsmith starts today is a headless `claude -p --output-format
stream-json` process: First Mate chats on the forge guest (0016, through the
mate runner over SSH), Sand chats and missions in E2B sandboxes (0018,
through `sandbox/e2b/beadsmith-run` and the E2B process channel). Beadsmith
maps the JSON lines onto the sanitized MissionEvent union, and that union is
all anyone sees.

That leaves out what 0015 set out to give admins: what the CLI actually drew,
and a way to answer a question or a stuck prompt by hand. A follow-up is a new
`claude -p --resume` process per message, so an agent between turns is not
running at all, and nobody can step in mid-turn except with cancel. The two
paths also differ in how they launch, interrupt and resume, and each has its
own copy of the stream mapping (`src/lib/mate-runner/claude-stream.ts` and
`src/lib/server/dispatch/claude-stream.ts`).

[herdr-core](https://github.com/herdrdev/herdr-core) (`hc`, protocol
generation 1) keeps programs alive in terminals and offers, over one JSON-RPC
API: start a program (`terminal.run`), paste text and press Enter
(`terminal.send`), press the stop key (`terminal.interrupt`), the program's
own status (OSC 7501: `idle`, `working`, `done`, `blocked`, `error`, with a
turn counter, through `terminal.get` and `events.subscribe`), file reads on
the same connection (`file.read`), and a raw terminal stream that a viewer can
watch without typing (`terminal.attach` with `observe`). `hc connect` carries
that API over stdin and stdout, so it rides any byte channel. Claude Code and
Codex both report OSC 7501 themselves (app `claude-code` and `codex`).

`hc` has no API authentication: a connection to a core is a shell as its
account ([its security notes](https://github.com/herdrdev/herdr-core/blob/main/docs/security.md)).
That is acceptable inside a scoped sandbox and nowhere else (0015).

The operator fixed the direction: hc everywhere, the same runtime for First
Mate and repo workers, on the forge guest and in E2B. This record decides how.

## Decision

Every Beadsmith agent runs as an interactive CLI in an hc terminal inside its
own sandbox or guest. Beadsmith (or, on forge, the host runner) is the only
client of that hc core, and reaches it only through a byte channel it already
controls.

1. **hc stays inside the sandbox.** Each Sand sandbox and the forge guest runs
   one hc core as the agent's unprivileged account (never root), on hc's
   default Unix socket in a 0700 directory. No hc port or socket is forwarded,
   published or bridged off the machine. The client side runs `hc connect`
   over a channel that already exists and is already authenticated:
   - **Sand:** an E2B background command with stdin open, started by
     Beadsmith in-process through the E2B SDK, the same process channel the
     crew bridge uses (0020). E2B's traffic-token requirement on service URLs
     (0018) is untouched; hc opens no port for it to guard.
   - **forge:** the host runner runs `ssh <guest> hc connect` with the pinned
     host key and the host-held SSH key it uses today (0016). Beadsmith talks
     to the runner over its signed contract, never to the guest, and never
     holds the guest's SSH key.

   No browser, personal device or other sandbox ever speaks hc. hc's
   multi-machine features (`machine add`, `--on`) are not used: the sandbox's
   hc core has no other machines and its agent has no hc connection outward.
   hc's own notes to parent agents are turned off (`notes = false`), because
   Beadsmith terminals have no hc parent and nothing should type into the
   agent but Beadsmith.

2. **The agent is the interactive CLI.** Claude Code ships first. A launch is
   `terminal.run` with `claude --session-id <uuid>` plus the mission's or
   chat's flags (model, `--mcp-config` for crew tools), in the run directory,
   with labels naming the Beadsmith chat or mission, and with permission
   prompts bypassed: inside a scoped sandbox the scope is the boundary those
   prompts guard (0015). The sandbox's image pre-accepts Claude Code's
   first-run dialogs (onboarding, folder trust, bypass-permissions warning),
   so a launch reaches the prompt without anyone pressing keys; a launch that
   reports `blocked` before its first turn fails with a clear error instead
   of being answered blindly.
   - The launch prompt and each follow-up are sent with `terminal.send`. A
     follow-up goes to the running CLI, so the agent keeps its process and
     context between turns. While the terminal is `working`, the existing
     `409 conflict` still applies; hc's own draft hold (it waits for an
     attached admin's unsent typing) is respected, not overridden.
   - Interrupt is `terminal.interrupt` (the stop key; it never escalates).
     Cancel ends the program with `terminal.kill`.
   - A turn is complete when hc's `turn` counter advances and the root status
     is `done`, `idle` or `error`, and the CLI's transcript (rule 3) has been
     read to its end. `blocked` (a question or a prompt) is surfaced as
     "needs a decision", never auto-answered. A terminal that finishes or is
     lost ends the run as failed unless its last turn completed.
   - Resume after a lost sandbox or guest restart starts a new terminal with
     `claude --resume <session-id>`; hc's `keep` (a shell in place of a lost
     program) is not used for agents.
   - The CLI sits behind a small seam (launch argv, transcript location,
     transcript-to-event mapping), so Codex or another harness that reports
     OSC 7501 can follow without another runtime. Only Claude Code ships.

3. **Members see what they see today.** The sanitized MissionEvent union
   (`user` / `assistant` / `thinking` / `tool_call` / `result` / `error`) is
   derived from Claude Code's own session transcript, the JSONL file it writes
   for `--session-id`, read incrementally with `file.read` over the same hc
   connection and passed through the existing sanitizer and scrubber. Stored
   threads, `turns`, the dispatch stream route and chat history keep their
   shapes, so the browser and `state.db` see no change. One mapping replaces
   the two stream-json copies.

4. **The raw terminal is admin-only and never kept.** An admin may open the
   agent's terminal from its First Mate chat or mission thread:
   - The browser connects to a route under `/api/console/` (admin-only,
     same-origin, CSRF-checked like every console route) that names a chat or
     mission, never a machine or a terminal address. Beadsmith resolves it to
     that run's sandbox and terminal, opens its own framed hc connection, and
     calls `terminal.attach`.
   - Attaching watches (`observe`: no typing, no resizing). **Take over** is a
     separate explicit action that reattaches as an active viewer and carries
     the admin's keystrokes and size; the admin hands back by detaching.
   - Beadsmith does not scrub, store or log relayed bytes (they are a raw
     terminal stream; scrubbing cannot work on it, and rule 6 of 0015 is why
     it need not). It records each attach and each take-over with actor,
     chat or mission, mode and start and end time.
   - On forge, the runner relays the attach over its signed contract; it adds
     no authority of its own and stores nothing either.

   The relay is separate from the MissionEvent stream, which stays the only
   view for members and for providers without hc (the signed webhook).

5. **hc is pinned once and checksum-verified.** herdr-core publishes releases
   at `releases.herdr.dev/core/<version>/manifest.json`, one tarball per
   target with its SHA-256. The repository pins one version and the
   `linux-x86_64` hash it has verified in a single file that both consumers
   read: the E2B template build (`sandbox/e2b/build-template.ts`) downloads
   and checks that tarball, and the Nix overlay (`nix/overlay.nix`) builds the
   guest's `hc` from the same version and hash with `fetchurl`. The hash in
   the repository, not the release server's manifest, is what a build trusts.
   Nothing runs `hc update` inside a sandbox or guest; a bump is a reviewed
   change to that file, then a template rebuild and a guest redeploy.
   Beadsmith's client says `generation: 1` in `hello` and refuses a core of
   another generation.

## Consequences

Admins see the agent exactly as the CLI draws it and can answer a question or
correct a turn by hand; everyone else's view, and everything stored, is
unchanged. Chats and missions share one runtime and one event mapping on both
runners, so interrupt, resume and completion behave the same everywhere.

The agent's process now lives between turns. An idle Sand sandbox still
pauses (0018); resuming it resumes the hc core and its terminal with it.
Completion now depends on two signals agreeing (hc's turn and the end of the
transcript); a CLI version that stops reporting OSC 7501 would stall runs, so
the template and guest pin a Claude Code version that reports it and the hc
client times out a turn rather than waiting forever.

The relay shows whatever the sandbox prints: placeholders for model and
GitHub keys (added outside by egress or the model proxy), and on Sand
missions the project's scoped Dolt password if the agent prints it. That is
the bound 0015 accepted. The stored thread still scrubs it.

Beadsmith gains a live shell on every sandbox it runs, through channels it
already held: the E2B process channel already ran arbitrary commands there,
and the forge runner already held the guest's SSH key. No new credential,
port or network path is created.

Not doing: hc on personal devices or any machine Beadsmith did not start;
an orchestrator holding hc connections to workers (0015 rejected it; First
Mate still delegates through dispatch); showing the raw terminal to members;
storing or replaying terminal bytes; harnesses other than Claude Code (the
seam stays); a general sandbox registry (Sand sandboxes and the forge guest
are operator-configured runners, as in 0018, and that registry stays a
0015 target).

## Alternatives considered

**Keep headless stream-json and add the relay only.** No terminal to relay:
`claude -p` draws nothing and exits between turns, so an admin could neither
watch nor answer it.

**Expose hc on the tailnet or an E2B service port.** It would let Beadsmith
dial cores directly, but hc has no authentication, so anything that reached
that port would have a shell in the sandbox. The process channel and SSH
already authenticate the only client.

**Scrape the screen for events.** Fragile across CLI versions, and hc itself
refuses to infer status from screen text. The transcript is the CLI's own
structured record.

**Install hc with its install script or `hc update`.** That trusts whatever
the release server serves at build time. A pinned hash in the repository
makes a rebuild reproducible and a changed release visible in review.

## Implementation notes

Shipped:

- The hc client, `src/lib/hc/` (`connectHc`), speaks framed mode over any
  `HcTransport` (`childProcessTransport` wraps `ssh … hc connect`). It
  offers no `line`, `on` or `force` and always runs with `no_parent`,
  `no_notify` and no `keep`; it checks every argument before sending. Attach
  streams return credit as their consumer finishes, so a slow relay slows the
  stream instead of buffering it. `src/lib/test/fake-hc.ts` is an in-memory
  core speaking the same bytes for unit tests. Framed mode is binary: the E2B
  SDK hands stdout to callbacks as decoded strings, so the Sand side needs a
  byte-safe carrier for `hc connect` (for example an encoding wrapper in the
  sandbox) rather than the raw command output.
- The interactive session core, `src/lib/agent-session/` (`AgentSession`),
  runs one CLI in one terminal over an `HcClient`: launch and wait for the
  first `idle` (a `blocked` launch is killed and fails), paste messages, turn
  end from hc's counter plus the transcript's `turn_duration` record (with a
  short settle time if the record is late), interrupt, cancel, a turn time
  limit, and reconnect after a lost channel (re-attach, or fail the turn and
  start `claude --resume`). The Claude Code seam (argv, transcript path,
  transcript mapper) is `claude-code.ts`. Event ids are `<line>.<index>` of
  the transcript; the session's own `result` and `error` events take indexes
  from 9000 on the last line read, so Last-Event-ID resumes stay ordered.
  Tests run against the fake core.

- The Sand template (`sandbox/e2b/build-template.ts`) installs hc from the
  pin in `nix/herdr-core.json` (version, generation and the `linux-x86_64`
  SHA-256, checked against the release once by hand), writes `notes = false`
  and Claude Code's first-run answers (`src/lib/server/e2b/image.ts`: the
  key names are the pinned CLI's own, `skipDangerousModePermissionPrompt` in
  `settings.json` for the bypass warning), and ships `beadsmith-hc connect`,
  the byte-safe carrier: base64 lines both ways around `hc connect`.
  `beadsmith-run` starts the core after setup (exit 14 if it cannot) so
  terminals inherit the sandbox's environment, then writes `ready` and
  exits: it no longer runs the agent.
- Sand missions run on the session core
  (`src/lib/server/dispatch/e2b-provider.ts`, over
  `src/lib/server/e2b/hc-transport.ts`, an `HcTransport` on the
  `beadsmith-hc` carrier). Beadsmith keeps no process per mission: each
  run's state lives in the sandbox (`ready`, an atomic `claim/` so one
  request sends the prompt, `turn.json` with the `TurnMark` that
  `AgentSession.send` returns, `result.json` once a status read or stream
  sees the turn end), and any request attaches a session core to the turn
  (`attach` with `relaunch: false` for reads, so a lost terminal fails the
  turn instead of starting the CLI). The CLI session id is sandbox
  metadata; a follow-up is the next message to the running CLI. A stream of
  a finished run sends its stored result only. The dispatch stream-json
  mapping is gone.
- First Mate chats run on the session core on both runners
  (`src/lib/mate-runner/session.ts`, `ChatAgent`), and the mate runner's
  stream-json mapping is gone, so one transcript mapping serves everything.
  The runner core takes a `ConnectAgent` (an hc client plus where the CLI
  runs) instead of a process spawner: `sshConnector` runs `ssh <guest> hc
  connect` with the pinned host key, and the Sand chat runner
  (`src/lib/server/mate/e2b-runner.ts`) connects over the `beadsmith-hc`
  carrier, first ending a CLI left talking to an old crew relay. A chat
  holds a channel only while it has an agent: the first message after a
  start, an eviction or a lost channel connects and `attach`es (following
  the live terminal, or launching with `--resume` when a transcript
  exists). Messages sent during a turn wait in the runner and go in when
  it ends, which keeps contract v1's "no busy answer"; interrupt drops
  them. A CLI `blocked` on a question gets no message pasted into it; the
  message fails with an error saying so. Shutdown and eviction kill the
  CLI, as they ended the headless process before; a runner that crashed
  finds the CLI still live and follows it. The wire contract is
  unchanged (still version 1).

- The admin relay for Sand (`src/lib/server/terminal-relay/`).
  `POST /api/console/terminals` names a mission or one of the caller's
  chats, a mode (`watch` or `take_over`) and the viewer's grid, and answers
  with a Server-Sent Events stream: `open` (relay id, mode, size), `output`
  (base64 bytes), `resize`, and a final `end`. SSE on a POST response rather
  than a WebSocket because the Node adapter serves no upgrades and a POST
  keeps the same-origin and CSRF checks every console mutation gets; a
  take-over resizes the agent's terminal and must not be a cross-site GET.
  Keystrokes and size go to `POST /api/console/terminals/:relay`, accepted
  only from the browser session that opened a `take_over` relay (a watching
  one answers 409). Providers and chat runners resolve the target
  (`AgentProvider.attachTerminal`, `MateRunner.attachTerminal`): a mission's
  CLI is the terminal labelled with its session id, a loop's is ralph's loop
  terminal, a chat's is labelled with its session. Watching never resumes a
  paused sandbox (409); taking over does. Each relay opens its own hc
  connection over the carrier and closes it when the stream ends. Each attach
  is a `terminal_relay_sessions` row (0004) written before the first byte
  and stamped with its end; a relay whose row cannot be written is not
  opened. Output waits for the browser to read, so a slow viewer slows the hc
  stream instead of growing a buffer.
- The terminal view (`src/lib/components/terminal-view.svelte`, xterm.js
  loaded on first open) in mission threads and First Mate chats, for admins
  on runners whose `terminal` capability is set (Sand; the provider and
  chat-runner tables say which implement `attachTerminal`). Closed until
  asked; Watch follows the agent's grid; Take over is behind a confirm and
  hands back by re-attaching as a watcher. While taken over every key goes
  to the agent, Esc included, and Shift+Esc leaves the terminal. Touch or
  narrow screens get Watch only. A lost stream reconnects with backoff in
  the same mode; a refusal or an exited program does not. State, SSE
  parsing and ordered input are `src/lib/client/terminal-relay.ts`.

Planned, each in its own change:

- the forge guest's hc and the runner wired to it;
- the relay on forge: the mate runner's signed contract gains an attach
  endpoint the host runner serves over its SSH `hc connect` (forge chats
  answer 409 until then).

The current architecture bullet is in [`specs/README.md`](../README.md); the
contract's rules are in
[`docs/contract.md`](../../docs/contract.md#where-agents-run).
