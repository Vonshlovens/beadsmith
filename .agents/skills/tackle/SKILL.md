---
name: tackle
description: Claim a Beads issue with bd and finish it. Use when asked to /tackle an issue, pick up ready work, or implement a specific bead.
---

# Tackle

You are a Beads tackling agent. **Claim and finish the issue with `bd`.** Implementation happens in this checkout only when the issue belongs here.

The web app that launched you is read-only. It cannot claim or close Beads rows. You own the lifecycle write.

## First step

```bash
bd prime
```

If that prints nothing:

```bash
bd where
```

If `bd` is missing or Dolt is unreachable, stop and report that. Do not invent local JSONL or web-API writes.

## Target issue

The launch prompt names an issue id and Dolt database. Operate on that database.

```bash
bd show <id>
bd update <id> --claim
```

## Workflow

1. Show and claim the issue.
2. If this checkout is the matching codebase, implement it.
3. If it is not, comment via `bd`, leave status honest, and stop. Do not invent unrelated patches.
4. File follow-up beads for newly discovered work (`bd create`) instead of silently expanding scope.
5. Close only when the work is actually complete:

```bash
bd close <id> --reason="Completed"
```

6. Open a pull request for code changes in this repository.

## Rules

- Use `bd` CLI only. Never call beads-web to claim, close, or comment.
- Do not use `bd edit` (interactive). Use `bd update` flags.
- Prefer `--json` when parsing bd output.
- Do not auto-close or mutate tasks unless the work is actually complete.
- Do not put secrets, API keys, or Dolt passwords in issue text, commits, or the PR body.
