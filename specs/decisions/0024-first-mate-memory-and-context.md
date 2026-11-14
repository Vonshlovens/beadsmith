# 0024. First Mate keeps its memory in Beadsmith and slides its own context

Date: 2026-11-14

## Status

accepted, being implemented. Builds on
[0020](./0020-first-mate-crew-tools.md) (crew tools are how a chat reaches
Beadsmith) and [0004](./0004-service-local-sqlite.md)
(app-owned rows live in `state.db`). Leaves the runners of
[0016](./0016-first-mate-worker-runtime.md),
[0018](./0018-sand-e2b-sandboxes.md) and
[0023](./0023-forge-chat-isolation.md) unchanged.

## Context

First Mate is meant to be one long-lived crewmate. Today each chat is one
Claude Code session that grows until Claude Code compacts it, and everything
the agent learns lives in that one transcript:

- **Context only grows.** A runner restart, an evicted session or a new
  sandbox runs `claude --resume <session_id>` and replays the whole
  transcript. The captain has to start a new chat to get a fresh head, and a
  new chat knows nothing the old one learned.
- **Nothing outlives a chat.** Preferences, decisions and how a project
  works are relearned in every chat. Deleting a chat deletes them.
- **Files live where the runner puts them.** On Sand a chat's files are in
  its E2B sandbox (`/home/user/mate`), which pauses and can be lost or
  recreated; on forge they are on one chat's home in one laptop's guest.
  Neither is a durable place for a workspace that should span chats, and
  each runner would need its own answer.
- **Beads must stay the work tracker.** Whatever First Mate keeps for itself
  must not become a shadow issue list. Work is filed in Beads (through
  missions, 0020 rule 4) and the captain's own list is Beadsmith's todos.

Out of scope: memory for dispatch missions, sharing memory between
accounts, and giving the chat sandbox any new credential or network path.

## Decision

1. **Beadsmith owns First Mate's memory and meta folder, per owner.** Both
   are app-owned rows in `state.db`, keyed by the account that owns the
   chats, never stored in a sandbox or guest. They survive chat deletion,
   sandbox loss, runner restarts and a change of runner, and a second chat
   starts with what the first one learned. First Mate is admin-only, so
   these are too; one account's memory is never read in another account's
   chat.
2. **The agent reaches them through crew tools.** New tools in the crew
   module (0020 rule 1) remember, recall, update and forget memories, and
   list, read, write, move and delete meta files, acting as the chat's
   owner. No transport-specific code: any runner with a crew-tool transport
   gets them, which today is Sand, and forge once it has one.
3. **Memories are small, single facts with a scope.** A memory is a short
   text (bounded, a few hundred characters) under a key unique per owner,
   with exactly one scope: `owner` (about the captain, always relevant),
   `project:<id>` or `topic:<slug>`. Writing an existing key replaces it, so
   memories are updated rather than duplicated. Each records the chat that
   last wrote it. First Mate writes memories on its own judgment, without
   asking first; the owner curates them afterwards (rule 8). There is no
   bulk delete tool.
4. **Recall is selective and bounded.** Before each user turn, Beadsmith
   picks the memories worth showing: every `owner` memory, the chat's
   current project's, and the best text matches for the message (SQLite
   FTS5), up to a fixed count and size. They go to the agent inside the
   tagged turn context, marked as data, never mixed into the user's words.
   Anything else the agent needs it asks for with the recall tool. Talking
   about one project does not pull in memories about another.
5. **The meta folder is the agent's own workspace.** A per-owner tree of
   text files (paths and sizes bounded) that First Mate organizes as it sees
   fit: working notes, docs it writes for itself, drafts, its own running
   checklist. The turn context names the folder's top-level index, not its
   contents.
6. **Work goes to Beads; the captain's list stays todos.** First Mate's
   instructions say: a fact or preference is a memory; something the agent
   is thinking through is a meta file; work to be done is filed as a bead
   (File mission) or, if it is the captain's personal task, a Beadsmith
   todo. Meta checklists hold the agent's own next steps, not work the
   captain would track.
7. **The runner slides the context, not the captain.** The shared runner
   core (`src/lib/mate-runner/`) bounds each chat's live context. When a
   turn ends past a size threshold (from the usage Claude Code records in
   its transcript), the runner asks the agent, in a runner-authored turn the
   chat shows as maintenance, for a **carry-over note**: what is in flight,
   what was decided, open threads, pointers to beads and meta files. The
   note is from the outgoing CLI session to the next one in the same chat;
   nobody else reads it, and the captain sees one continuous chat. The
   runner keeps the note with the chat's session record and starts a fresh
   CLI session from it, plus recalled memory, instead of resuming the old
   transcript. A restart, eviction or new sandbox also starts from the
   latest note. The chat's Beadsmith log
   and the runner contract do not change: windows are internal to the
   runner, and the chat keeps its `session_id` for life.
8. **The owner can see and change everything.** Because First Mate writes
   memories unprompted, this page is part of the feature, not a follow-up. A
   First Mate page lists the
   owner's memories and meta files, shows which chat wrote each, and lets
   the owner edit or delete them. Memory and meta writes show in the chat
   as crew activity lines like any other crew call.

### Limits

Fixed values for rules 3, 4 and 7. Writes over a limit are refused with a
message saying what to do, never truncated.

| What | Limit |
| --- | --- |
| Memory body | 500 characters |
| Memory key | 64 characters, `^[a-z0-9]+(-[a-z0-9]+)*$` |
| Topic slug (`topic:<slug>`) | 40 characters, same grammar as keys |
| Memories per owner | 500 in all; past it, forget or update first |
| `owner`-scoped memories | 40 (they are recalled every turn) |
| Per-turn recall | every `owner` memory (up to 40), up to 20 of the chat project's (most recently updated first), up to 8 FTS5 matches by BM25 (deduplicated, never another project's) |
| Per-turn recall budget | 12,000 characters. Over it, `owner` memories win, then FTS matches, then project memories by recency; whole memories are dropped, never cut, and the block ends with how many were left out and that the recall tool finds them |
| Recall tool | 25 results, within the crew tools' existing result cap, with the total match count |
| Sliding threshold | a turn ends with 100,000 or more live context tokens (input, cache read and cache creation of its last assistant message), half a 200k window, well before Claude Code's own compaction |
| Carry-over note | 8,000 characters |

## Consequences

First Mate keeps a small, current head and a durable memory, and neither
depends on which runner a chat is on. Choosing Sand or forge as First Mate's
home becomes a question of cost, reachability and crew tools, not of where
its memory lives.

Recall injects stored text into every turn, so a poisoned memory (written by
a prompt-injected chat) persists across chats. Mitigations: memories are
bounded and tagged as data, each records its writing chat, the owner can
review and delete them, and memory tools cannot launch anything.

A carry-over note is lossy by design. The full transcript stays in the runner's
event log and Beadsmith's chat log for the captain, but the agent no longer
carries it. The threshold and the carry-over prompt need evals.

Forge chats get the sliding window (it is in the runner core) but not
memory or the meta folder until the remote runner has a crew-tool
transport.

## Alternatives considered

**Memory in the sandbox or guest (a `~/meta` directory, Claude Code's own
memory files).** No new Beadsmith code, but it is per chat or per runner,
lost with a sandbox, invisible to the owner and different on each runner.

**Memory in Beads (a memories project, or `bd remember`).** Durable and
already shared with other agents, but every write is a Beads change, which
only missions make (0020 rule 4); a mission per remembered fact is too slow
and too visible. It also mixes the agent's notes into the work tracker this
decision keeps separate.

**Rely on Claude Code's auto-compact and `--resume`.** Nothing to build, but
compaction happens when the CLI decides, its summary is not ours to shape or
keep, and resume still replays a transcript that only grows.

**Embedding search for recall.** Better matching for vague messages, but it
needs a model or service for embeddings and is hard to explain. Scopes plus
FTS5 come first; embeddings can be added behind the same recall step.

## Implementation notes

Shipped: the memory store
([`src/lib/server/mate/memory-store.ts`](../../src/lib/server/mate/memory-store.ts),
table `mate_memories` with FTS5 index `mate_memories_fts`) and the
`remember`, `recall` and `forget` crew tools
([`src/lib/server/crew/memory-tools.ts`](../../src/lib/server/crew/memory-tools.ts)).
A write is one guarded upsert, so the limits hold against concurrent
writes. Not yet: per-turn recall, the meta folder, sliding windows and the
owner's page. Expected places for the rest: a store beside
[`src/lib/server/mate/store.ts`](../../src/lib/server/mate/store.ts); tools
in [`src/lib/server/crew/`](../../src/lib/server/crew/); recall in the turn
context built for each message (shared with the tagged turn context work);
windows in [`src/lib/mate-runner/session.ts`](../../src/lib/mate-runner/session.ts)
and its event log. Describe the shipped behavior in
[`docs/first-mate.md`](../../docs/first-mate.md) as each slice ships.
