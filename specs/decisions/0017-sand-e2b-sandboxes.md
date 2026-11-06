# 0017. Sand: E2B sandboxes beside self-hosted runners, picked per chat and mission

Date: 2026-11-06

## Status

accepted. Amends [0006](./0006-durable-agent-dispatch.md) (several dispatch
providers at once; a launch may name one) and implements part of
[0015](./0015-scoped-agent-sandboxes.md) on a hosted provider. Leaves
[0016](./0016-first-mate-worker-runtime.md) in place as the self-hosted
First Mate runtime.

## Context

Every agent Beadsmith starts ran on one self-hosted machine: First Mate
chats on the forge host's Firecracker guest (0016), and dispatch through
whatever webhook runner was configured. When that machine or its network is
down, First Mate and every File, Tackle, comment and discuss button stop
working. A dedicated KVM host is also the expensive part of running
sandboxes.

Hosted sandbox providers run each sandbox in its own microVM without a KVM
host of ours. The research behind this decision compared E2B, Cloudflare
Sandbox, Fly Machines, Daytona and Modal on isolation, Tailscale inside the
sandbox, keeping keys out of it, a Node control API, and price. E2B and Fly
use a Firecracker microVM per sandbox; Daytona defaults to shared-kernel
containers and Modal to gVisor. E2B alone combines a full Node SDK
(background commands, stdin, reconnect, pause and resume) with egress header
injection, which meets 0015's rule 6 without a proxy of our own. Fly has the
better-documented Tailscale path but no egress rules. Cloudflare's key
handling is strongest, but its lockdown conflicts with running `tailscaled`,
and it is driven only through a Worker.

Out of scope: a terminal relay to Sand sandboxes, Beads access for Sand
chats, and other hosted providers.

## Decision

We will add E2B as a second place agents run, called **Sand** in the UI, for
both dispatch (`e2b` provider) and First Mate chats (`e2b` chat runner), and
let one admin choice in First Mate ("Runs on") pick where new work goes.

1. **Several runners at once.** `BDX_DISPATCH_PROVIDER` and
   `BDX_MATE_RUNNERS` are lists; the first usable entry is the default. A
   dispatch request may name a provider (`provider`) and a new chat a runner
   (`runner`), but only one the server lists as configured; anything else is
   refused before a record is written. A mission keeps the provider that
   launched it and a chat the runner it was created on, for follow-up,
   cancel, streaming and delete. This keeps 0015's rule 1: the browser
   chooses between operator-configured runners, never a machine.
2. **One sandbox per mission and per chat.** A Sand sandbox is created for
   one mission or one chat and holds that scope only, so no two scopes share
   a kernel (0015, rule 2). It pauses when idle and is resumed by the next
   follow-up or message.
3. **Keys outside the sandbox (0015, rule 6).** The model credential
   (Anthropic API key or Claude subscription token) and GitHub tokens are
   added to HTTPS requests by E2B's egress proxy; inside, agents see
   placeholders. GitHub tokens come from a GitHub App, minted per run for the
   mission's one repository, with write access only when the run may open a
   pull request. The E2B key, the App key and the Tailscale OAuth secret stay
   in files on the Beadsmith host.
4. **Mission sandboxes reach Dolt over the tailnet (0015, rule 3).** Each run
   joins as an ephemeral node with a single-use key, tagged
   `tag:beads-sandbox`; the tailnet policy grants that tag Dolt's port and
   nothing else. The sandbox holds the project's own Dolt account, with
   rights on that database only, from an operator file; a project without
   one cannot launch on Sand.
5. **Sand chats match the forge guest.** Model access only: no tailnet, Dolt
   or repository access, the same standing instructions.
6. **Beadsmith drives E2B itself.** The dispatch provider and the chat runner
   run inside the Beadsmith process, so Sand needs no service of its own to
   deploy. The chat runner reuses the mate runner's core
   (`src/lib/mate-runner/server.ts`) with an E2B spawner, so its sessions,
   message dedupe, interrupt and resume behave exactly like the HTTP
   runner's.

## Consequences

When the self-hosted runner is down, an admin picks Sand in First Mate and
keeps working; existing threads and chats stay where they started. Sand
missions stream live events into their threads (the webhook runner only
polls). Hosted sandboxes cost money per running second; paused ones are not
billed for compute.

Beadsmith now holds more credentials than before: an E2B key, a model
credential, a GitHub App key and a Tailscale OAuth client. All are files,
none enters `state.db`, a sandbox or the browser. Whoever controls the
Beadsmith server could already launch agents that change Beads; with Sand
they can also create sandboxes on the E2B account and open pull requests on
repositories the App is installed on. Protected default branches remain the
backstop.

The sandbox holds two credentials of its own: the project's scoped Dolt
password (allowed by rule 6) and, for the seconds before it joins, a
single-use Tailscale key. Run output is scrubbed of the Dolt password before
it is stored.

E2B's header injection is in public beta. If it changes, the fallback is a
key proxy of our own on the tailnet, as 0015 describes.

Not doing: Sand terminal relay, Beads access for Sand chats, organization-wide
GitHub tokens, or letting the browser name anything the server did not list.

## Alternatives considered

**A separate runner service implementing the webhook contract.** It would
leave the app untouched, but adds a service to deploy and secure, and the
webhook contract has no live events. Running in-process reuses the mate
runner core and needs only configuration.

**Fly Machines.** Official kernel-mode Tailscale and no session cap, but no
egress rules, so keys would sit in the sandbox or need a proxy we write.

**Cloudflare Sandbox.** Best credential injection, but it is controlled only
from a Worker, and its lockdown conflicts with `tailscaled`; Tailscale inside
is undocumented.

## Implementation notes

- Shared E2B driver, egress plan and model credentials:
  [`src/lib/server/e2b/sandbox.ts`](../../src/lib/server/e2b/sandbox.ts).
- Dispatch provider:
  [`src/lib/server/dispatch/e2b-provider.ts`](../../src/lib/server/dispatch/e2b-provider.ts),
  stream mapping in `claude-stream.ts`, per-run credentials in
  `sandbox-credentials.ts`; several providers in `provider.ts`, `service.ts`
  and the `provider` field of `POST /api/projects/:id/dispatch`.
- Chat runner: [`src/lib/server/mate/e2b-runner.ts`](../../src/lib/server/mate/e2b-runner.ts)
  over `createRunnerCore` in `src/lib/mate-runner/server.ts`; the chat's
  runner is the `runner` column of `mate_chats`
  ([0004](./0004-service-local-sqlite.md)).
- Template and in-sandbox run script: [`sandbox/e2b/`](../../sandbox/e2b/).
- Picker: `src/lib/client/agent-runner.svelte.ts` and
  `src/lib/components/runner-select.svelte`.
- Operator guide and every setting: [`docs/sand-e2b.md`](../../docs/sand-e2b.md).
  The current architecture bullet is in [`specs/README.md`](../README.md).

Unit tests cover these paths against fakes. The first live mission and chat
are the acceptance check listed in the operator guide.
