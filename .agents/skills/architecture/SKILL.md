---
name: architecture
description: >
  Consult and maintain Beadsmith architecture specs and ADRs. Use when a
  task changes system shape (Dolt/SQL topology, bd/web authority, bind/authz
  policy, catalog vs project visibility, dispatch, iOS data plane, or
  deploy/runtime contract), when planning a feature that might, or when the
  user asks why the app is built this way. Do not use for UI copy, styling,
  or bugfixes that stay inside an existing decision. Not every conversation
  writes or updates an ADR.
---

# Architecture specs

Beadsmith records accepted architecture in `specs/`. Numbered ADRs in
`specs/decisions/` are the **why**. `docs/contract.md` is the long-form
product/security contract; ADRs must not contradict it.

This skill is the write protocol. The always-on pointer lives in `AGENTS.md`.
**Most conversations only read.** Do not update specs because a session
happened.

## First step

1. Open `specs/README.md`. That page is the current architecture (bullets →
   ADRs) and the spec index.
2. Follow the linked ADR(s) for the area you are touching. Do not read the
   whole `specs/decisions/` tree unless the README points there.
3. **Code is reality.** If an ADR and `src/` disagree, believe the code, then
   decide whether the ADR is stale (update) or the change is wrong (fix code).

## Consult vs write

**Consult only** (default):

- Implementing inside an accepted decision
- Bugfix, copy, styling, tests, refactors that do not change system shape
- Reading “why is it like this?”
- Subagent implementation work the orchestrator already scoped

**Update an existing ADR** when the decision still holds but details drifted
(paths, env vars, shipped-vs-target notes, related issue ids).

**New ADR** when you accept a new choice with real alternatives, or when a
new choice supersedes an accepted ADR.

**Never write an ADR for:**

- A local refactor, a CSS tweak, or a bead that does not change architecture
- “We discussed architecture” without a decision that will ship
- Rephrasing `docs/contract.md` or duplicating an existing ADR
- Every planning session, PR, or conversation

If you are unsure, consult and skip the write. Missing an ADR is cheaper than
a junk decision file.

## Write protocol

1. Copy `specs/adr-template.md` to
   `specs/decisions/NNNN-kebab-title.md` using the next unused number.
2. One decision per file. Default `Status: accepted` only if this change is
   shipping; otherwise `proposed`.
3. Do not rewrite history. Supersede: set the old file to
   `superseded by NNNN` and point the README bullet at the new file.
4. In the **same change**, update the current-architecture bullets in
   `specs/README.md` and the decision table. Add a Spec | Code | Purpose row
   if a new surface exists.
5. Keep `docs/contract.md` aligned if the product/security contract changed.
   ADRs are the why; the contract is the invariant list.
6. Do not paste ADR bodies into `AGENTS.md`. Do not create markdown TODO
   architecture notes; file leftover work with `bd`.

## Orchestrator note

When using subagents, the parent reads `specs/README.md` once and passes the
relevant ADR ids and invariants into the child prompt. Children consult;
they do not invent a parallel spec. Only the parent (or a child explicitly
asked to) edits ADRs.

## Related

- Index: `specs/README.md`
- Template: `specs/adr-template.md`
- Contract: `docs/contract.md`
- Beads memories that already encode decisions: `bd memories architecture`
  (or `bd prime`)
