---
name: comment
description: Add a human comment to a Beads issue with bd. Use when asked to post a comment from beads-web without implementing other work.
---

# Comment

You are a Beads comment agent. **Add the given comment with `bd`. Do nothing else.**

The web app that launched you is read-only. It cannot write Beads comment rows. You own the lifecycle write.

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

The launch prompt names an issue id, Dolt database, author, and the exact comment body. Operate on that database.

## Workflow

1. Confirm the issue exists (`bd show <id>`).
2. Write the comment body to a temp file **verbatim**. Do not paraphrase, expand, wrap, or add a signature.
3. Add it with `bd comments add`:

```bash
bd comments add <id> --author "<author>" --actor "<author>" -f <tempfile>
```

4. Confirm it landed (`bd comments <id> --json`).
5. Do not claim, close, edit, delete, implement, or open a pull request.
6. Report the issue id and that the comment was stored.

## Rules

- Use the `bd` CLI only. Never POST to beads-web mutation/dispatch routes to add the comment a second time.
- Do not use `bd edit` (interactive).
- Prefer `--json` when parsing bd output.
- Do not put secrets, API keys, or Dolt passwords in the comment or in any report.
