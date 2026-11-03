# 0015. Agents run in scoped sandboxes; Beadsmith never reaches into personal devices

Date: 2026-11-03

## Status

accepted. Amends [0006](./0006-durable-agent-dispatch.md): a beads sandbox
may ask for repository work, and an admin may see an agent's raw terminal.
Nothing in this decision is implemented yet.

## Context

First Mate should show exactly what an agent CLI (Claude Code, Codex) reads
and prints, and let an admin steer it. The candidate runtime is
[herdr-core](https://github.com/herdrdev/herdr-core) (`hc`): it keeps agent
terminals alive on a machine, streams their raw bytes to any viewer, reports
the agents' own status (OSC 7501), and reaches other machines over SSH.

Two rules stood in the way. The contract said the browser never receives a
PTY, ANSI or a raw worker log, and that untrusted browser input never
triggers a worker action directly. Both rules came from the same worry: what
the agent's machine can reach. `hc` has no API authentication: whoever
connects to a core gets a shell as its account. Connected to a personal
laptop, that is the owner's own accounts, keys, every checkout, and their
Dolt account, which administers the server
([0013](./0013-owner-account-and-global-readers.md)).

The risk is the machine, not the terminal. An agent on a machine that holds
only Beads access, or only one repository, can do far less damage, whoever
drives it. Beads changes are Dolt commits and backed up
([0010](./0010-in-app-backups.md)). A repository credential that can only
open pull requests cannot ship code by itself.

Out of scope: which runtime, sandbox host or provider ships first, and the
MCP server's tool list. Those come with their implementations.

## Decision

We will classify every machine that runs agents by what it holds, and let
Beadsmith connect only to the two sandbox scopes.

**Beads sandbox** (the orchestrator First Mate talks to). A machine, VM or
microVM dedicated to Beads work. It holds:

- a Dolt account of its own that may read every project (`SELECT ON *.*`, as
  Beadsmith's reader does) and write only the project databases it is granted
  (`ALL PRIVILEGES ON <project>.*`, no `GRANT OPTION`). Never data rights on
  `*.*`: in Dolt that makes an administrator
  ([0013](./0013-owner-account-and-global-readers.md)). A new project
  needs its grant line before the orchestrator can change it;
- model access through the key proxy (rule 6);
- no repository access and no connection to repo sandboxes. It asks for
  repository work through Beadsmith's dispatch API, so the global arm,
  per-project allow, idempotency and durable record still apply.

**Repo sandbox** (a worker). A machine, VM or microVM dedicated to one
repository. It holds:

- access to that one repository only, through the key proxy (rule 6): a
  fine-grained token or GitHub App installation token with contents and
  pull-request access, with the default branch protected so the sandbox can
  only propose changes;
- optionally, a Dolt account on that repository's project alone. Without
  one, it reports through its run result and the orchestrator records it in
  Beads;
- model access through the key proxy.

A second repository is a second sandbox.

**Personal device.** Any other machine: a laptop, a workstation, anything
with the owner's or a user's own credentials. Beadsmith holds no credential
that reaches one, opens no connection to one, and relays none of its
terminals. Trust is flipped: an agent on a personal device connects to
Beadsmith through an MCP server that the device's user authorizes with OAuth.
Its tools are a facade over the authorized HTTP API, limited by that user's
role ([agent-access.md](../../docs/agent-access.md) already rules out MCP as
a shell).

The rules that make these scopes real:

1. A machine is a personal device unless an admin registers it in the
   console as a sandbox with its scope (and, for a repo sandbox, its
   repository). The browser cannot name a machine on dispatch, as it cannot
   name a repository today.
2. Sandboxes of different scopes do not share a kernel. On a host that
   carries more than one scope, or on a personal device, each sandbox is a VM
   or microVM, not a container. A laptop can host sandboxes this way; the
   laptop itself stays a personal device.
3. Sandboxes reach Beadsmith and Dolt over a private network (Tailscale, or
   WireGuard), and the network policy enforces the same scopes: Beadsmith may
   reach sandboxes; a sandbox may reach Dolt only when it holds an account;
   sandboxes do not reach each other; nothing reaches a personal device. A
   misconfigured registration still cannot open a connection the network
   refuses.
4. The Beadsmith app image stays as it is ([0008](./0008-runtime-and-deployment.md)):
   it reaches the private network through its host or a sidecar, not by
   joining it itself. A credential for reaching sandboxes (an SSH key, or the
   host's tailnet identity) lives outside `state.db`, like every other secret.
5. **Terminal relay.** An admin may open a sandbox's agent terminal from
   Beadsmith: the program's raw output, and, when the admin takes over, their
   keystrokes. It is admin-only and reaches only registered sandboxes.
   Beadsmith does not scrub, store or log relayed bytes. Each attach and
   take-over is recorded with its actor and time. The relay is separate from
   the mission event stream, which stays the sanitized
   `user` / `assistant` / `thinking` / `tool_call` / `result` / `error` union
   for everyone else.
6. **Keys stay outside the sandbox.** Model and repository access goes
   through a proxy outside the sandbox that adds the key to each request, as
   hosted coding agents keep git and model credentials out of their
   sandboxes. The agent can use that access while its sandbox runs, within
   the proxy's rules (for a repo sandbox: one repository, no pushes to the
   default branch), but cannot read, print or copy the key. A key the
   sandbox's own processes could use directly, its agent could read, so the
   key cannot live inside it. The scoped Dolt account is the one credential
   a sandbox may hold itself until Dolt access has such a proxy too.

## Consequences

First Mate can host a real agent session: the orchestrator's terminal in the
chat, and repo workers' terminals in their mission threads, exactly as the
CLI draws them. Inside a sandbox an agent may run without per-tool permission
prompts: the sandbox's scope is the boundary that those prompts guard on a
personal device.

The relay is unscrubbed by design. Secret scrubbing cannot work on a raw byte
stream, so an admin sees whatever the sandbox prints. Rule 6 is what makes
that acceptable: the only secret a sandbox can print is its scoped Dolt
password, when it has one.

Beadsmith becomes a hub, though it already holds most of what that implies.
Whoever controls its server can already read every project (its reader
account sees all of them) and launch agents that write Beads through the
dispatch provider; on the maintainer's host Dolt runs on the same machine.
What the hub adds is direct control of each sandbox: pull requests on each
registered repository, and the sandboxes' compute and model use. It still
cannot reach a personal device or an unregistered repository.

Text an agent reads can still steer it: an issue, a pull request comment, a
web page. That is the same risk as running the agent on a personal device,
with far less behind it, and with rule 6 there is no long-lived key to
steal. Two things are worse than a session someone is watching: sandbox
agents run unattended and without permission prompts, and the orchestrator
reads text from every project. Injected text can also travel, when the
orchestrator writes it into a bead that becomes a worker's task. The
backstops are a protected default branch (a person merges every change) and
Dolt history. Egress allowlists are welcome where the sandbox host supports
them.

The orchestrator does not command workers directly, even though `hc` lets
agents start agents on other machines. Its requests go through dispatch,
whose kill switch and records keep working.

Where sandboxes run is a deployment choice that this decision constrains but
does not make: microVMs on a laptop, a hosted sandbox provider (ephemeral
ones suit repo workers), a dedicated server with KVM for the orchestrator and
its workers' VMs, or [Overalls](https://github.com/ghuntley/overalls)
(persistent Firecracker microVMs whose agent CLIs, per its README, run with
no API keys on the machine). Each must meet the rules above.

Not doing: relaying personal-device terminals, wildcard Dolt write grants for
sandboxes, organization-wide GitHub tokens, or showing the raw terminal to
members.

## Alternatives considered

**Relay any machine running `hc`, personal devices included.** Rejected: a
connection to a personal device's core is a shell with everything that
device holds, including the owner's administrator Dolt account. The MCP
direction gives those devices Beadsmith access without handing Beadsmith
access to them.

**The orchestrator holds `hc` connections to repo sandboxes.** This is how
`hc` likes to work, and it would let workers report back with `hc send`.
Rejected: the orchestrator's reach would become every repository at once,
and its work would bypass the dispatch arm, allows and records.

**Keep the no-PTY rule and show only sanitized events.** Mapping an agent's
JSON output onto mission events fits the old contract, but cannot show what
the CLI actually drew or let an admin answer a permission prompt or a
question. It stays the view for members and for providers without a relay.

## Implementation notes

Not shipped. Today the only provider is the webhook runner and Beadsmith
holds no sandbox connection. Planned pieces, each in its own change:

- a sandbox registry in `state.db` (name, scope, repository for repo scope,
  connection target), admin console routes to manage it, and
  [0004](./0004-service-local-sqlite.md) updated when it ships;
- an `AgentProvider` over a terminal runtime (herdr-core first) in
  `src/lib/server/dispatch/`, with its row in `PROVIDER_CAPABILITIES`;
- the relay route under `/api/console/` (admin-only already) and a terminal
  view in First Mate;
- the key proxy for model and repository access, or a sandbox host that
  provides one. Both agent CLIs can point at a proxy's base URL and carry a
  placeholder token;
- private-network policy tags for each scope, declared with the fleet
  ([0014](./0014-public-repo-nix-and-fleet.md)), the secrets kept in
  `fleet/secrets/`;
- the MCP server for personal devices, with its own ADR (OAuth server,
  tools, and how any write reaches Beads).

The contract carries these rules as targets:
[`docs/contract.md`](../../docs/contract.md#where-agents-run). The current
architecture bullet is in [`specs/README.md`](../README.md).
