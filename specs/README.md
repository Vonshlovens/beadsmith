# Beadsmith specifications

Beadsmith is a web dashboard and agent launcher over Beads projects stored
in a remote Dolt SQL server. This
directory is the canonical record of its accepted architecture.
Implementation and review follow the ADRs in the
[decision index](decisions/README.md).

The long-form product/security contract remains
[`docs/contract.md`](../docs/contract.md). Specs describe intent; **code is
reality**. Search `src/` before treating a spec as implemented.

## Current architecture

- The product is a **server over one remote Dolt SQL server**, not a local
  Beads client: no workspace scanning, no desktop credential helpers. Runtime
  identity is still `beads-web`
  ([ADR-0001](decisions/0001-remote-sql-control-plane.md)).
- Today the web process **only reads Beads**; agents launched through
  dispatch change issues with `bd`. Editing issues from the UI is welcome
  future work, not something the architecture rules out.
- Beads data is read from **one configured Dolt server** with parameterized
  `SELECT`/`SHOW` and four sanitized failure classes
  ([ADR-0003](decisions/0003-dolt-read-plane.md)).
- Service-local SQLite holds **theme settings, dispatch records, safety
  policy, operator-edited Tackle mappings, optional File checkout maps,
  admin todos, First Mate chats, and accounts**, never issue rows
  ([ADR-0004](decisions/0004-service-local-sqlite.md)).
- HTTP bind policy requires a Dolt host, and a non-loopback bind requires
  accounts. Cloudflare Access is an optional outer layer; one allowlisted
  service-token principal may make sessionless GET/HEAD `/api` reads
  ([ADR-0005](decisions/0005-bind-policy-and-cloudflare-access.md)).
- **Built-in accounts** (Better Auth, email+password) turn on with
  `BETTER_AUTH_SECRET_FILE`. The first account needs a one-time setup token
  and becomes admin; sign-up is closed afterwards. `admin` runs the console
  (backups included) and launches agents; `member` reads
  ([ADR-0011](decisions/0011-accounts-and-roles.md)).
- Lifecycle UI checks a **global arm and per-project File/Tackle allow**, then
  persists a dispatch request and launches an agent through a configured
  provider (signed webhook, E2B, or none; provider-neutral; several may be
  configured and a launch may name one). Board drag
  and keyboard Send-to-agent confirm the same dispatch rather than PATCHing
  status. Comment uses the File checkout
  ([ADR-0006](decisions/0006-durable-agent-dispatch.md)).
- First Mate's runner runs Claude Code in one persistent Firecracker guest,
  `mate`, on the fleet host forge. Model and signing credentials stay on the
  host, behind a key-injecting proxy that admits only the Anthropic message
  API; the guest has no Beads or repository access yet
  ([ADR-0016](decisions/0016-first-mate-worker-runtime.md)).
- **Sand** runs missions and First Mate chats in hosted E2B sandboxes, one
  Firecracker microVM per mission or chat, beside the self-hosted runners.
  First Mate's **Runs on** picker chooses where new work goes; each mission
  and chat keeps its runner. Model and GitHub keys are added by E2B's egress,
  never inside the sandbox; mission sandboxes join the tailnet with
  single-use tagged keys and hold only their project's Dolt account. Beadsmith
  drives E2B in-process, reusing the mate runner core for chats
  ([ADR-0018](decisions/0018-sand-e2b-sandboxes.md)).
- Target, partly shipped (0016, 0018): **agents run in scoped sandboxes**. A beads sandbox
  (the orchestrator) holds per-project Dolt grants and asks for repository
  work through dispatch; a repo sandbox reaches one repository. Model and
  repository keys stay outside sandboxes, behind a proxy. Beadsmith may
  connect to registered sandboxes and relay their raw terminals to admins.
  It never connects to a personal device; agents there reach Beadsmith
  through an OAuth-authorized MCP server instead
  ([ADR-0015](decisions/0015-scoped-agent-sandboxes.md)).
- **First Mate** is a chat with one long-lived orchestrator agent on a
  separately deployed mate runner, after
  [firstmate](https://github.com/kunchenguid/firstmate): admin-only, chats
  private to their owner and stored in `state.db`, messages and events
  relayed over a signed HTTP + SSE contract as the sanitized MissionEvent
  union ([`docs/first-mate.md`](../docs/first-mate.md)). Without a runner it
  answers with a placeholder.
- Deployment is **one root `compose.yaml` + `.env`** (bridge with token,
  or host network on loopback), GHCR images, Dolt always separate.
  Tailscale is for Cloud Agent VMs, not the app image
  ([ADR-0008](decisions/0008-runtime-and-deployment.md)).
- **One Nix toolchain** (`nix/overlay.nix`) feeds the devenv shell, the flake
  checks, a NixOS VM test and the published GHCR image; the maintainer's host
  (`fleet/`) and its sops secrets live in this public repo
  ([ADR-0014](decisions/0014-public-repo-nix-and-fleet.md)).
- Proposed, prototype only: a **native desktop client** on Rune in
  `desktop/` reads the same Dolt server directly with the web app's read
  contract and a SELECT-only account. It bypasses accounts and the project
  gate, so it is for the server's owner; it never scans workspaces or runs
  `bd` ([ADR-0018](decisions/0017-native-desktop-prototype.md)).
- **One Google IdP** when Cloudflare Access is used. Per-project
  catalog/membership is still the gate before projects are shared selectively;
  today every account sees every SQL-visible project
  ([ADR-0009](decisions/0009-edge-identity-and-catalog-gate.md)).
- **Backups are an app feature**: the console configures an S3-compatible
  bucket; the server dumps every project database over read-only SQL on a
  schedule. Backup credentials are the one reversible secret `state.db`
  holds, encrypted under `BDX_SECRET_KEY_FILE`; only admins can change them
  ([ADR-0010](decisions/0010-in-app-backups.md)).
- **New projects** are a plain `bd init` from the owner's machines: on a
  single-owner server their account has `ALL ON *.*` (an administrator in
  practice), and the reader and backup accounts have `SELECT ON *.*`, so a
  new database appears with no grant. The beads host applies these grants
  after every Dolt start. Every account has a long random
  password because readers can see `mysql.user`. Other agents get accounts
  scoped to projects
  ([ADR-0013](decisions/0013-owner-account-and-global-readers.md)).

## How agents should use this

Follow the `architecture` skill at
[`.agents/skills/architecture/SKILL.md`](../.agents/skills/architecture/SKILL.md).

- **Before changing system behavior**, read this page and the linked ADR(s).
- **Routine bugfixes, copy, styling, and work inside an accepted decision
  do not need an ADR.** Do not update specs on every conversation.
- **If the task changes architecture**, update the matching ADR or add the
  next numbered file from [`adr-template.md`](adr-template.md), then refresh
  the bullets on this page in the same change.

## Architecture decisions

| Spec | Code | Purpose |
| --- | --- | --- |
| [decisions/README.md](decisions/README.md) | — | Decision index |
| [0001-remote-sql-control-plane.md](decisions/0001-remote-sql-control-plane.md) | [`src/lib/product.ts`](../src/lib/product.ts), [`src/lib/server/discovery.ts`](../src/lib/server/discovery.ts) | Server over remote Dolt; no local workspaces |
| [0003-dolt-read-plane.md](decisions/0003-dolt-read-plane.md) | [`src/lib/server/dolt/client.ts`](../src/lib/server/dolt/client.ts) | Read-only Dolt SQL client |
| [0004-service-local-sqlite.md](decisions/0004-service-local-sqlite.md) | [`src/lib/server/state/schema.ts`](../src/lib/server/state/schema.ts), [`src/lib/server/mate/store.ts`](../src/lib/server/mate/store.ts) | App settings, dispatch, policy, Tackle maps, File checkouts, admin todos, First Mate chats |
| [0005-bind-policy-and-cloudflare-access.md](decisions/0005-bind-policy-and-cloudflare-access.md) | [`src/hooks.server.ts`](../src/hooks.server.ts), [`src/lib/server/env.ts`](../src/lib/server/env.ts) | Bind policy, Access, session |
| [0006-durable-agent-dispatch.md](decisions/0006-durable-agent-dispatch.md) | [`src/lib/server/dispatch/`](../src/lib/server/dispatch/) | File/Tackle/comment persist-then-launch |
| [0008-runtime-and-deployment.md](decisions/0008-runtime-and-deployment.md) | [`compose.yaml`](../compose.yaml), [`package.json`](../package.json), [`flake.nix`](../flake.nix) | Node/SvelteKit runtime; Compose production; Nix-built image |
| [0009-edge-identity-and-catalog-gate.md](decisions/0009-edge-identity-and-catalog-gate.md) | [`src/lib/server/cloudflare-access.ts`](../src/lib/server/cloudflare-access.ts) | One Access IdP; catalog before a second identity |
| [0010-in-app-backups.md](decisions/0010-in-app-backups.md) | [`src/lib/server/backup/`](../src/lib/server/backup/) | Scheduled SQL backups to S3-compatible storage |
| [0011-accounts-and-roles.md](decisions/0011-accounts-and-roles.md) | [`src/lib/server/auth/`](../src/lib/server/auth/), [`src/hooks.server.ts`](../src/hooks.server.ts) | Better Auth accounts; admin/member roles; first-run setup token |
| [0013-owner-account-and-global-readers.md](decisions/0013-owner-account-and-global-readers.md) | [`scripts/ci/dolt-grants-smoke.sh`](../scripts/ci/dolt-grants-smoke.sh), [`docs/new-project.md`](../docs/new-project.md), [`fleet/hosts/beads/dolt.nix`](../fleet/hosts/beads/dolt.nix) (`beads-dolt-grants`) | Plain `bd init` creates projects; global readers; accounts scoped to projects for other agents |
| [0015-scoped-agent-sandboxes.md](decisions/0015-scoped-agent-sandboxes.md) | [`fleet/hosts/forge/`](../fleet/hosts/forge/) (initial guest only) | Beads and repo sandboxes; admin terminal relay to sandboxes only; personal devices reach in through MCP |
| [0016-first-mate-worker-runtime.md](decisions/0016-first-mate-worker-runtime.md) | [`fleet/hosts/forge/runtime.nix`](../fleet/hosts/forge/runtime.nix) | Persistent guest Claude Code, host model proxy and signed runner |
| [0017-native-desktop-prototype.md](decisions/0017-native-desktop-prototype.md) | [`desktop/`](../desktop/README.md) | Proposed: native Rune client reading Dolt directly (prototype) |
| [0018-sand-e2b-sandboxes.md](decisions/0018-sand-e2b-sandboxes.md) | [`src/lib/server/e2b/`](../src/lib/server/e2b/), [`src/lib/server/dispatch/e2b-provider.ts`](../src/lib/server/dispatch/e2b-provider.ts), [`src/lib/server/mate/e2b-runner.ts`](../src/lib/server/mate/e2b-runner.ts), [`sandbox/e2b/`](../sandbox/e2b/) | Sand: E2B sandboxes for missions and chats; several runners, picked in First Mate |
| [0020-first-mate-crew-tools.md](decisions/0020-first-mate-crew-tools.md) | [`src/lib/server/crew/`](../src/lib/server/crew/) | Crew tools: one transport-free MCP tool module for First Mate chats (read tools so far), relayed into Sand chats by [`src/lib/server/mate/crew-bridge.ts`](../src/lib/server/mate/crew-bridge.ts) |

## UI map

The shipped screens are the source of truth for the visual language; tokens
live in [`src/app.css`](../src/app.css).

| Code | Purpose |
| --- | --- |
| [`src/routes/+layout.svelte`](../src/routes/+layout.svelte), [`src/lib/components/`](../src/lib/components/) | Shell, rail, shared components |
| [`src/routes/+page.ts`](../src/routes/+page.ts), [`src/lib/client/home.ts`](../src/lib/client/home.ts) | `/` redirects to your own work: Todos for admins, First Mate for members |
| [`src/routes/projects/`](../src/routes/projects/) | Project catalogue: one sortable row per project |
| [`src/lib/components/activity-drawer.svelte`](../src/lib/components/activity-drawer.svelte) | Recent changes drawer (top bar, `.`): events folded to one line per issue per day |
| [`src/routes/ready/`](../src/routes/ready/) | Cross-project Ready deck |
| [`src/routes/todos/`](../src/routes/todos/), [`src/lib/todos/`](../src/lib/todos/) | Admin todo agenda: local capture parser, due-date columns, derived urgency; `/api/todos/:id/route` files a todo through File dispatch ([`src/lib/server/todos/route.ts`](../src/lib/server/todos/route.ts)) |
| [`src/lib/components/first-mate.svelte`](../src/lib/components/first-mate.svelte), [`src/lib/client/first-mate.ts`](../src/lib/client/first-mate.ts) | Command palette (⌘K): go anywhere, open an issue ID, recent issues, add a todo, local actions; also hosts the agent dialog and keyboard host |
| [`src/routes/first-mate/`](../src/routes/first-mate/), [`src/lib/server/mate/`](../src/lib/server/mate/) | First Mate: server-side chats with the mate runner's agent beside agent threads, palette when none is open |
| [`src/lib/components/agent-dialog.svelte`](../src/lib/components/agent-dialog.svelte), [`agent-thread.svelte`](../src/lib/components/agent-thread.svelte) | Issue → agent (Discuss, Elaborate, Close, Tackle) and the provider-agnostic thread |
| [`src/lib/client/hotkeys.ts`](../src/lib/client/hotkeys.ts) | Keyboard map ([`docs/keyboard.md`](../docs/keyboard.md)) |
| [`src/routes/p/[id]/+page.svelte`](../src/routes/p/[id]/+page.svelte) | Dense issue table and board |
| [`src/routes/p/[id]/i/[issue_id]/+page.svelte`](../src/routes/p/[id]/i/[issue_id]/+page.svelte) | Issue body and relationships |
| [`src/lib/components/empty-state.svelte`](../src/lib/components/empty-state.svelte), skeletons | Empty, loading, error, confirm, narrow viewport |
| [`src/lib/client/tooltip.ts`](../src/lib/client/tooltip.ts), [`select-field.svelte`](../src/lib/components/select-field.svelte), [`date-picker.svelte`](../src/lib/components/date-picker.svelte), [`confirm-dialog.svelte`](../src/lib/components/confirm-dialog.svelte) | The app's own tooltip, dropdown, calendar and confirmation, in place of the browser's `title`, `<select>`, `<input type=date>` and `confirm()`. Icons are Phosphor (`phosphor-svelte`) |

## Related long-form docs

| Doc | Role |
| --- | --- |
| [`docs/contract.md`](../docs/contract.md) | Product/security contract (invariants) |
| [`docs/public-access.md`](../docs/public-access.md) | Access + catalog/membership (target vs interim) |
| [`docs/file-tackle-dispatch.md`](../docs/file-tackle-dispatch.md) | File/Tackle launch path |
| [`docs/first-mate.md`](../docs/first-mate.md) | First Mate chats and the mate runner contract v1 |
| [`docs/sand-e2b.md`](../docs/sand-e2b.md) | Sand: setting up and running agents in E2B sandboxes |
| [`docs/keyboard.md`](../docs/keyboard.md) | Keyboard shortcuts |
| [`docs/agent-access.md`](../docs/agent-access.md) | Service-token read principal; operator activation remains |
| [`docs/server-deployment.md`](../docs/server-deployment.md) | VPS topology |
| [`adr-template.md`](adr-template.md) | New ADR skeleton |
