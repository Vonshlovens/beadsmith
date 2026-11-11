# 0016. First Mate runs Claude Code in a persistent Firecracker guest

Date: 2026-11-05

## Status

accepted. Implements the first model and process boundary from
[0015](0015-scoped-agent-sandboxes.md); remaining sandbox capabilities stay targets.
[0018](0018-sand-e2b-sandboxes.md) adds E2B sandboxes as a second chat
runner; this runtime stays the self-hosted one.

## Context

First Mate needs persistent chat sessions while model credentials stay outside
the agent's filesystem. The web process remains the SQL read/control plane,
and agents remain responsible for Beads writes with `bd`. A full worker platform
would add unrelated deployment and storage machinery before this path is proven.

## Decision

Use microvm.nix with Firecracker and a persistent guest volume. A dedicated
host runner starts the official Claude Code CLI as a nonroot guest user over
SSH with a pinned host key. One process serves each active chat through
stream-json; persistent Claude session files support later resume. Runner event
logs survive service restarts; active processes do not. KillMode=control-group
stops SSH children with the host service. Each guest launch is a separate
transient user service, with a supervisor as its main process. The supervisor
exits on transport stdin EOF/error or a termination signal; systemd then stops
that service's entire cgroup, escalating to SIGKILL after two seconds. Detached
tool descendants stay in the cgroup. Other chat services are not targeted.
SSH client-alive probes (15 seconds, two missed replies) bound detection of
silent transport loss; `systemd-run --wait` alone is not a cleanup guarantee.
See the official [pipe semantics](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html),
[cgroup kill policy](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)
and [SSH client-alive settings](https://man.openbsd.org/sshd_config#ClientAliveInterval).
This is lifecycle containment within one scope, not security isolation between
chats sharing the guest user. A deliberately hostile process that controls that
user's service manager is outside this cleanup guarantee. (Superseded by
[0021](0021-hc-terminal-runtime.md): the CLI runs in a terminal of one hc
core, a user service in the guest, and ending a chat kills its terminal;
the per-launch transient service and supervisor are gone.)

The runner binds loopback and accepts contract-v1 HMAC requests. Tailnet HTTPS
is the external transport; TLS certificate enablement is an operational gate.
The signing key and guest SSH key are delivered as systemd credentials, never
sent into the guest. The application integration must enforce admin and chat
ownership before calling the runner.

Underclass pools subscriptions on host loopback with distinct model and UI
credentials. A separate streaming HTTP proxy binds the guest gateway and admits
only POST `/v1/messages` and `/v1/messages/count_tokens`. It replaces client auth
with the host-held model credential. It exposes no UI, account management,
redirects or general forward-proxy capability. Guest traffic to other host
services, private networks, tailnet and other guests remains blocked. Public
IPv4 egress is still allowed; this is not an internet destination allowlist.

Claude Code receives a placeholder token and the gateway URL through an
executable wrapper, including for noninteractive SSH. Home and working directory
live on the persistent guest disk. Telemetry, error reporting, nonessential
traffic and automatic updates are disabled; Nix owns CLI upgrades.

## Consequences

The worker emits sanitized MissionEvents, not a terminal relay. Model responses
and session acceptance require the owner to enroll a Claude subscription. An
empty pool proves transport and failure handling, not model success.

This change does not implement Dolt proxying, Beads access inside the guest,
repository workers, sandbox registration, raw terminal relay, OAuth MCP, or
production web-app acceptance. (Amended by
[0021](0021-hc-terminal-runtime.md): Claude Code runs interactively in an hc
terminal in the guest, the runner reaches it with `ssh <guest> hc connect`,
and admins may attach through Beadsmith's audited relay.) No database or repository authority is implied
by a running agent. The initial instructions tell the agent those limits.

## Alternatives considered

- Install Overalls: its broader host and storage lifecycle is unnecessary for
  this increment. Its independent host pool design is a reference only.
- Put model credentials or a tailnet identity in the guest: violates the
  credential and network boundaries in ADR-0015.
- Run the CLI directly on the host: shares the host kernel and authority.
- Use git-remote database sync: introduces stale copies rather than the intended
  future live, scoped Dolt path. The web process becoming a writer is a separate
  decision and is not needed for agent-owned writes.

## Implementation notes

See [`runtime.nix`](../../fleet/hosts/forge/runtime.nix),
[`model-proxy.mjs`](../../fleet/hosts/forge/model-proxy.mjs),
[`mate.nix`](../../fleet/hosts/forge/guests/mate.nix) and
[`scripts/mate-runner.ts`](../../scripts/mate-runner.ts).
[Operations](../../docs/operations/host-forge.md) describes credential handling,
onboarding, activation and rollback. Deployment and owner acceptance must be
recorded separately from source implementation.

The production application configuration supplies the runner origin from sops
and the shared signing key through a systemd credential. Admin and owner checks
remain in the application; guest SSH and model credentials stay on the worker
host. Deploying this configuration does not certify successful model turns or
browser acceptance.

[ADR-0021](0021-hc-terminal-runtime.md) replaces the headless stream-json
process with an interactive Claude Code in an hc terminal, keeps the SSH key
and model credential on the host as above, and builds the guest's `hc` from
the version and hash pinned in the repository.

[ADR-0022](0022-underclass-model-gateway.md) records Underclass as the model
gateway: it stays on loopback, this filter stays the guest's only door and
keeps injecting the key (widened per harness, never to the UI or admin API),
and the console reads Underclass's admin API server-side.
