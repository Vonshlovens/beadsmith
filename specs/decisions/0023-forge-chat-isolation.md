# 0023. Each forge First Mate chat runs as its own Unix identity

Date: 2026-11-13

## Status

accepted. Amends [0016](./0016-first-mate-worker-runtime.md) (one nonroot
guest user for every chat) and [0021](./0021-hc-terminal-runtime.md) rule 1
on forge (one hc core per guest, as the `agent` account's user service).
Sand is unchanged: each Sand chat already has an E2B sandbox of its own
([0018](./0018-sand-e2b-sandboxes.md)).

## Context

The forge guest `mate` ran every First Mate chat as the same Unix user, with
one home, one working directory and one hc core. Claude Code keeps its
transcripts, settings and history under that home, and the CLI runs with
permission prompts bypassed. Beadsmith's HTTP routes keep chats to their
owner, but inside the guest an agent in one admin's chat could read or edit
another admin's transcript, working files or Claude configuration, and
signal or kill its processes. The per-chat cleanup from 0016 and 0021 was
lifecycle containment, never a security boundary (0016 said so).

The boundary has to hold against the agent itself: a prompt-injected or
careless agent runs arbitrary commands as its user. Directory names under
one user, or a check in the runner, do not stop that. Chats must still
resume after a runner restart, a guest restart or a lost channel, and
deleting a chat must remove what it left behind.

## Decision

1. **One chat, one Unix identity.** Every forge chat runs in a systemd unit
   of its own in the guest, `mate-chat@<instance>.service`, whose instance is
   the first 24 hex digits of the SHA-256 of the chat's CLI session id. The
   unit uses `DynamicUser=`: its user `mc-<instance>` exists only while the
   unit runs, and systemd chowns the chat's state to whatever UID it gets
   next, so state outlives the UID. Per chat rather than per owner: the
   guest learns no Beadsmith account, the contract is unchanged, and two
   chats of the same admin are kept apart too.
2. **A private home at a fixed path.** The chat's home is its
   `StateDirectory`, under systemd's root-only `/var/lib/private`, on a
   guest volume of its own. Inside the unit it is bound at
   `/var/lib/agent/home`, the path every chat uses, so the runner's working
   and config directories stay the same for every chat. The rest of the
   guest's state volume is hidden behind an empty read-only tmpfs. The unit
   also has its own `/tmp`, sees only its own processes in `/proc`
   (`ProtectProc=invisible`), has no capabilities, and gets the usual
   `DynamicUser=` protections (read-only system, no setuid, IPC removed).
3. **One hc core per chat.** The unit runs the chat's hc core, with its
   socket in `/run/mate-chat/<instance>` (0700, the chat's user). The core,
   every terminal and whatever they start are in the unit's cgroup. hc's
   terminal kill still ends a CLI (eviction, shutdown); stopping the unit
   ends the rest. The guest's shared `agent` account and its `hc-core` user
   service are gone.
4. **The runner may only ask for a chat.** The runner still reaches the
   guest over SSH with the pinned host key and its own key (0016, 0021 rule
   1), now as `root` but forced (`restrict,command=`) to one helper,
   `mate-chat`. `connect <session id>` starts the chat's unit and runs
   `hc connect` as the chat's user (no capabilities, no new privileges)
   against that chat's socket; `discard <session id>` stops the unit and
   removes its state. Anything else is refused. The session id must be a
   lowercase UUID, which the runner checks too.
5. **Delete discards.** Deleting a chat stops its CLI, discards it in the
   guest, then forgets the chat log. A discard that fails keeps the chat and
   answers 503, so Beadsmith's delete (which keeps the chat when the runner
   refuses) can be retried. Eviction and shutdown only end the CLI; the
   chat's home stays for the next message, which resumes its transcript.

## Consequences

- One admin's chat agent cannot read, change or signal another chat's
  transcript, files, configuration, socket or processes through the guest's
  filesystem or process table. Chats still share the guest's kernel, network
  (the model filter and public egress) and resources; a guest escape or a
  kernel bug crosses this boundary, as it would any shared-kernel one.
  Memory and task limits per chat are not set yet.
- The runner can still reach every chat: it is the trusted party that
  drives them, as before. Its key no longer gives a shell.
- Idle chats keep a running hc core until they are deleted or the guest
  restarts; the runner's live-session limit counts CLIs, not cores.
- Transcripts from before this change are in the old shared home, which no
  chat sees. Existing forge chats start fresh sessions on their next
  message; the operator can delete `/var/lib/agent/home` in the guest once
  it is no longer wanted.
- Verification is live: `fleet/hosts/forge/guest-lifecycle.test.mjs` runs on
  forge against the deployed guest and checks the lifecycle checks from
  0021 per chat, a second chat probing the first (read, write, socket,
  `/proc`, signal), a restart keeping a chat's home, and discard
  ([host-forge.md](../../docs/operations/host-forge.md#guest-lifecycle-smoke-test)).
  There is no NixOS VM test of the guest.

## Implementation

- Guest: `fleet/hosts/forge/guests/mate.nix` (the `mate-chat@` unit, the
  `mate-chat` helper, the `chats` volume at `/var/lib/private`, root's
  forced runner key).
- Host: `fleet/hosts/forge/runtime.nix` (`MATE_AGENT_SSH` is `root@` the
  guest; `MATE_AGENT_HC` is no longer used on forge).
- Runner: `src/lib/mate-runner/spawn.ts` (`sshArgs`, `sshConnector`,
  `sshDiscarder`), `src/lib/mate-runner/server.ts` (`discard` on delete),
  `scripts/mate-runner.ts`.
