# 0025. Grown capabilities: views, catalog surfaces and sandboxed apps as revisioned data

Date: 2026-11-14

## Status

accepted, being implemented. Builds on
[0003](./0003-dolt-read-plane.md) (views compile through the existing
parameterized read plane, unchanged), [0004](./0004-service-local-sqlite.md)
(grown things are app-owned rows in `state.db`),
[0011](./0011-accounts-and-roles.md) (roles),
[0006](./0006-durable-agent-dispatch.md) and
[0020](./0020-first-mate-crew-tools.md) (every write or launch reuses their
authority), and borrows the owner-curation rule of
[0024](./0024-first-mate-memory-and-context.md) (rule 8).

## Context

First Mate can use Beadsmith through crew tools (0020) but cannot extend it.
A new view of the work, a dashboard for one project or a small purpose-built
tool all go through the repository: a mission, a pull request, CI, an image
and a redeploy. For a question like "show me everything blocked on review in
these three projects, as a board" that is far too heavy, and the answer is
then frozen into code everyone sees.

The goal is a layer of **definitions** that the running product holds, that
the owner and First Mate grow by talking, and that afterwards run with no
model in the loop: they show up in a catalogue, have a history and can be
rolled back. The danger is just as clear. Anything First Mate writes may have
been shaped by prompt injection (an issue body, a mission transcript), and
the product's authority boundary ([`docs/contract.md`](../../docs/contract.md))
rests on the web process never running untrusted code, building SQL only from
validated parts, and authorizing every action as a signed-in account.

Today's code that this decision leans on:

- The read plane builds every issue query from `BrowseFilters` with bound
  parameters (`buildIssueWhere` in
  [`src/lib/server/dolt/client.ts`](../../src/lib/server/dolt/client.ts)).
- Crew tools are defined once, with zod inputs and a `permission` each, in
  [`src/lib/server/crew/`](../../src/lib/server/crew/); they run as the
  chat's owner (0020 rule 3).
- Roles and the request gate are in
  [`src/lib/server/auth/roles.ts`](../../src/lib/server/auth/roles.ts);
  unknown API writes default to admin.
- The app's CSP (`vite.config.ts`) allows only same-origin scripts with
  SvelteKit's nonces and sets `frame-ancestors 'none'`.

Out of scope: editing Beads from grown things (Beads writes stay delegated
to missions, contract invariant 1), sharing grown things between Beadsmith
instances, and exporting apps to outside MCP clients (a later follow-on,
below).

## Decision

Beadsmith gains a revisioned store of **grown things** in three tiers, from
most to least constrained. A request goes to the lowest tier that can
express it.

1. **Views** are declarative specs: a scope (one project or all), browse
   filters (`BrowseFilters`), a sort and a presentation (list or board,
   optional grouping). A view runs by compiling its spec through the
   existing browse path, the same one the project page uses. A view never
   holds SQL, column names or expressions; its spec is a strict zod schema
   that rejects unknown keys, and every value reaches Dolt as a bound
   parameter (0003 unchanged).
2. **Catalog surfaces** are a JSON component tree, in the style of the A2UI
   protocol and Vercel's json-render, over a **catalog of Beadsmith
   components** (layout, headings, text, stat tiles, issue lists and boards,
   charts, buttons) whose props are zod-typed. Data comes from bindings to
   saved views or allowlisted read tools; buttons bind to allowlisted
   actions. Svelte renders the tree natively, and a node that names a
   component or prop the catalog does not define is rejected when saved,
   not skipped when rendered. Surface data is never interpreted as code or
   markup (text is text; Markdown goes through the app's sanitizing
   renderer, [`markdown-body`](../../src/lib/components/markdown-body.svelte)).
3. **Sandboxed apps** are model-written HTML, CSS and JavaScript, stored as
   data, for what the catalog cannot express. An app's code runs **only in
   the viewer's browser**, inside a sandboxed iframe, and talks to Beadsmith
   only over the bridge (rule 6):
   - The iframe is `<iframe sandbox="allow-scripts">` with no
     `allow-same-origin`, `allow-top-navigation`, `allow-popups`,
     `allow-forms` or `allow-modals`, so the app runs in an opaque origin:
     it cannot read Beadsmith's cookies, storage or DOM, navigate the page
     or open windows.
   - Its document is served by a dedicated frame route that checks the
     viewer may see the app, with its own response CSP: `sandbox
     allow-scripts`, `default-src 'none'`, inline scripts and styles only,
     `img-src data:`, `connect-src 'none'`, `form-action 'none'`,
     `base-uri 'none'` and `frame-ancestors 'self'`. The `sandbox`
     directive keeps the document sandboxed even if it is opened directly.
     No network request is possible from the app: no `fetch`, XHR,
     WebSocket, external script, stylesheet, font or image.
   - **No network-loaded code, ever.** The host inlines into the app
     document a vendored allowlist of libraries, each pinned by version and
     SHA-256 in one file in the repository, starting with Beadsmith's
     design-token CSS and one chart library. Extending the allowlist is a
     repository change through review, never something First Mate or an app
     can do.
4. **Nothing model-written runs in the Node process.** No tier evaluates,
   imports, templates or compiles stored content on the server. Views and
   surfaces are parsed as data against schemas; app code is opaque bytes the
   server stores and serves to the sandboxed frame. This is the line in the
   contract, not an implementation detail.
5. **Everything runs as the viewer.** A grown thing has an owner (its
   author's account) but no authority of its own. Running a view, resolving
   a surface binding or answering an app's tool call happens as the
   signed-in account looking at it, with that account's role and visibility,
   through the same checks the browser path uses. The author's role never
   carries over: an admin's app opened by a member reads as a member and
   cannot launch anything.
6. **The bridge is MCP Apps' wire shape, with Beadsmith as the only host.**
   Surfaces and apps reach Beadsmith through one tool bridge. For apps it is
   the MCP Apps (SEP-1865) shape over `postMessage` JSON-RPC: `ui/initialize`,
   `tools/call`, and the tool-input and tool-result notifications. The host
   page accepts messages only from its own iframe's window, validates each
   frame against a schema and a size limit, and forwards an allowed call to a
   Beadsmith endpoint under the viewer's session. Surfaces call the same
   endpoint directly. The bridge has an allowlist:
   - **Reads:** the crew read tools that make sense outside a chat (projects,
     ready work, issues, an issue, missions, a mission) and running a saved
     view, each keeping its own `permission`, so `list_todos` answers admins
     only. Chat-bound tools (memory, meta folder, mission follow-ups and
     notices) are not on it.
   - **Actions:** only ones that reuse existing authority: todo changes and
     mission launches through dispatch, under the global arm, per-project
     allow and repository map (0006), with the viewer's role checked as the
     HTTP gate checks it. A launch records the grown thing it came from.
   - **Host-side confirmation:** every action that writes or launches shows
     a confirmation the host renders (the app's
     [`confirm-dialog`](../../src/lib/components/confirm-dialog.svelte)),
     naming the operation, project and issue, outside the iframe and the
     surface tree. The grown thing cannot draw, skip or pre-answer it. Reads
     need no confirmation.
7. **Owner-private by default; members see only what an admin publishes.**
   Creating and revising grown things is admin-only in this version (First
   Mate is admin-only, and unknown writes already default to admin). A new
   thing is visible to its owner alone. Sharing **publishes one revision**:
   members see the published revision, the owner sees the latest. A later
   revision, whether a person or First Mate wrote it, stays owner-only until
   an admin publishes it, so an agent never changes what members see without
   an admin action. Publishing and unpublishing are browser actions by a
   signed-in admin; there is no crew tool for them. The owner publishes;
   any admin may unpublish a thing members can see.
8. **Revisions are append-only.** Every create, revise and revert writes a
   new revision; a revert copies an old revision forward. Each revision
   records its author kind (person or First Mate), the account and, for
   First Mate, the chat. One store holds all three tiers, distinguished by
   kind, each kind with its own spec schema, so there is one revision and
   visibility implementation rather than three.
9. **The owner can see and change everything.** A catalogue lists the
   owner's grown things and the published ones, with author kind, project,
   last change and published state; each has a history with revert, publish
   and delete. First Mate's writes show in the chat as crew activity lines
   like any other crew call, and the tools that create or revise a grown
   thing return its URL.
10. **When the grown layer cannot express a request, it becomes code.** An
    admin-only "change this" action, and a crew tool, dispatch a mission
    against the Beadsmith repository through existing dispatch with the page
    and request as context. Automations First Mate proposes are created
    paused, and only a person resumes them (0019's automations are already
    data).

### Limits

Writes over a limit are refused with a message saying what to do, never
truncated.

| What | Limit |
| --- | --- |
| Grown things per owner | 200 views, 100 surfaces, 50 apps |
| Name | 80 characters |
| Slug | 64 characters, `^[a-z0-9]+(-[a-z0-9]+)*$`, unique across all owners (it is the URL) |
| Description | 500 characters |
| Revisions kept per thing | the newest 50, plus the published one; older revisions are dropped whole, never edited |
| View spec | 4 KB of JSON; text search up to 200 characters; row limit up to the read plane's `MAX_LIMIT` (1,000) |
| Surface tree | 32 KB of JSON, 200 nodes, depth 8, 12 data bindings |
| App document | 256 KB of model-written HTML, CSS and JS, not counting inlined libraries |
| Bridge frame | 64 KB per message in either direction; malformed or oversized frames are dropped and logged |
| Bridge tool calls | 60 per minute per open surface or app; results bounded by the crew tools' `RESULT_MAX_CHARS` |
| Launches from grown things | one host confirmation per launch, within dispatch's existing idempotency and the viewer's launch limits |

## Consequences

The owner and First Mate can answer "show me X" in seconds with something
durable, reviewable and reversible, and First Mate can reuse its own views
as tools instead of rebuilding queries. The common case (a filtered list or
board) is the safest tier and runs entirely through code that already
exists.

Grown things are a new place for a prompt-injected chat to leave something
behind. Mitigations: nothing runs on the server, nothing runs with the
author's authority, apps have no network and no Beadsmith origin, actions
need a host confirmation, members never see an unpublished revision, and
the owner sees every change with its author and can revert or delete it.
What a grown thing can still do is show the viewer misleading content built
from data the viewer could read anyway; publishing is the admin's review
point for that.

An opaque-origin iframe is not a perfect barrier against every side channel
of a hostile document (timing, resource exhaustion in the viewer's tab).
It holds no data the viewer cannot read, and the CSP and sandbox flags leave
it no way to send that data anywhere.

The frame route needs its own CSP and `frame-ancestors 'self'`, the one
place the app's global `frame-ancestors 'none'` is relaxed, and only for a
document that is itself sandboxed.

Shipped versus target: the store, the view spec, the views catalogue, the
view crew tools and proposed automations are implemented; the surface spec
is stored but surfaces are not yet served or rendered, and apps are not yet
(see Implementation notes).

## Alternatives considered

**Evaluate model-written code on the server** (a JS sandbox in Node, or
templates rendered server-side). Most expressive, but it puts untrusted code
inside the process that holds the session secret, the Dolt reader and the
dispatch path, which is exactly the authority boundary the contract draws.
Rejected.

**Raw SQL views.** Flexible and familiar, but it reverses 0003: SQL would be
built from stored, model-written text, and a member's view could read any
table the reader can. Rejected; `BrowseFilters` grows when a view needs a new
filter.

**Run apps in a Sand sandbox.** Strong isolation, but heavy (a microVM per
app), slow to start, costly, and it has no UI of its own; the result would
still need a safe way into the page. The browser's sandboxed iframe is the
isolation this needs, at no cost.

**`srcdoc` iframes.** One less route, but a `srcdoc` document inherits the
embedding page's CSP, which allows only nonce'd same-origin scripts; running
inline app code would mean relaxing the policy of every page that embeds an
app, or computing per-revision hashes into it. A dedicated frame route gives
the app its own, stricter policy and an access check on the document itself.

**Invent a bridge protocol.** No dependency on a draft specification, but
MCP Apps already defines the message shapes for exactly this (a UI asking a
host to call tools), and matching it keeps open serving apps to outside MCP
clients later. Beadsmith implements only the subset above.

**Load libraries from a CDN.** Convenient for the model, but it needs
network access from the app and trusts a third party at view time. Rejected
in favour of vendored, hash-pinned libraries.

**Only views, no surfaces or apps.** Smallest, but dashboards and
purpose-built tools would still need a redeploy. The tiers let each request
use the least power that expresses it.

## Implementation notes

Implemented so far, in [`src/lib/server/grown/`](../../src/lib/server/grown/):

- `store.ts` is the one revisioned store (rule 8): tables `grown_things`
  (slug, kind, owner, published revision) and `grown_revisions` (name,
  description, spec JSON, author kind, account and chat). Kinds are
  registered in `GROWN_KINDS` with their spec schema, byte limit,
  per-owner limit and an optional async `check`; `view` and `surface` are
  registered, apps add theirs. Visibility and roles (rules 5 and 7) are enforced in the store,
  not the routes, so the browser API and crew tools share one rule set.
  Writes are single `batch` calls rather than interactive transactions; the
  per-owner limit and the next revision number are computed inside the
  insert, so concurrent writers cannot exceed or share them.
- `view-spec.ts` is the strict view spec and `runView`, which compiles the
  filters onto `listProjectIssues`. The read plane orders by last update
  and applies the row limit, so `sort` orders the rows the limit selected;
  `limit_reached` tells the reader when that cut applied. An all-projects
  view skips a project it cannot read and says so, as Ready does.
- `errors.ts` holds `GrownError`, which `safeError` maps to a response.
- `grown-api.ts` turns a request into a viewer (an Access service token has
  no account, so it owns nothing and reads as a member) and a stored thing
  into the summary the browser reads (`GrownSummary` in `src/lib/grown.ts`,
  typed per kind as `ViewSummary` and `SurfaceSummary`). Every kind's routes
  share it, so the request bodies and the summary change in one place. Its
  `requireGrown` answers "not found" for another kind under the same slug,
  and every route calls it before any store write, so the views routes never
  touch a surface and the surfaces routes never touch a view.
- Routes under [`src/routes/api/views/`](../../src/routes/api/views/) and
  [`src/routes/api/surfaces/`](../../src/routes/api/surfaces/) add
  no role rule of their own: their reads are open to any signed-in role and
  their writes fall to the request gate's admin default
  ([`roles.ts`](../../src/lib/server/auth/roles.ts)), with the store
  checking ownership and role again behind it. Running a view is its own
  route (`/run`), so a view whose project left the catalogue can still be
  read, reverted or deleted. Surfaces have no run route: a renderer reads
  each binding through the bridge as the viewer.
- Pages: [`/views`](../../src/routes/views/) is the catalogue (name,
  project, author kind, last change, who can see it);
  `/views/[slug]` runs the view with the Ready page's rows (shared as
  `issue-rows.svelte`), optionally grouped, or the project board, one board
  per project for an all-projects view, since a board's columns are one
  project's statuses. The owner sees the history there with revert and
  per-revision publish.
- Saving from the project page: `/p/[id]` offers "Save view" when it has
  filters, and writes the same record through `/api/views` that
  `define_view` writes, so people and First Mate share one kind of view.
  Its filters and presentation map onto a spec (parade is the
  status-grouped list); table sorting is not in the URL and is not captured.
  `/views/[slug]` links back to the page with `?saved=<slug>` when the page
  can show the view exactly (one project, no label, assignee or row limit,
  no grouping but the parade's), and there the owner can save changed
  filters as a new revision. The mapping lives in
  [`src/lib/client/views.ts`](../../src/lib/client/views.ts); the name,
  slug and description limits are shared with the store from
  [`src/lib/grown.ts`](../../src/lib/grown.ts).

- Crew tools: [`src/lib/server/crew/view-tools.ts`](../../src/lib/server/crew/view-tools.ts)
  (`define_view`, `list_views`, `run_view`, `view_history`, `revert_view`)
  call the same store with the chat owner as viewer and First Mate as
  author, so they add no rule of their own. `define_view` creates or
  revises under one slug and returns the view's URL (rule 9); `run_view`
  returns the rows the view's page shows, so First Mate reuses a view
  rather than rebuilding its query. The writes need the same admin
  permission as the `/api/views` writes. There is no publish or share
  tool (rule 7).
- Proposed automations (rule 10):
  [`src/lib/server/crew/automation-tools.ts`](../../src/lib/server/crew/automation-tools.ts)
  (`define_automation`, `list_automations`) reuse 0019's `createAutomation`
  and the `POST /api/automations` field schemas, for the chat owner with
  `dispatch:launch`. The automation store, not the tool, saves an
  automation that names its proposing chat (`proposed_chat_id`) paused with
  a reason, so no crew path can create one that fires; resuming clears the
  reason and keeps the marker, which the browser reads as
  `proposed_by_first_mate` (never the chat id) and /automations shows.
  There is no crew tool to resume, edit, run or delete an automation.

- Surface spec: [`surface-spec.ts`](../../src/lib/server/grown/surface-spec.ts).
  **Renderer choice (the spike):** Beadsmith's own schema and Svelte
  renderer, in A2UI's shape (a flat list of components, each with an id and
  its children's ids, under one `root`), rather than json-render's Svelte
  renderer. The catalog is ten components whose props are already zod
  objects here; json-render would add a pre-1.0 dependency and its own
  catalog and action model in front of the bridge allowlist, which this
  decision needs to own exactly (rule 6). Keeping A2UI's shape leaves room to
  stream and patch by id, or to speak A2UI to outside clients, later. Each
  catalog entry is a strict object, so an unknown component or prop is a
  schema error; the tree checks (one parent each, reachable from the root,
  no cycles, depth, node, binding and action limits, every reference used
  and resolved, a component's binding yielding what it shows) run in the
  same parse. Data bindings name a saved view or a bridge read; buttons name
  a bridge action. The props are plain text except `Markdown`, which the
  renderer sends through `markdown-body`.
- Bridge allowlist: [`bridge.ts`](../../src/lib/server/grown/bridge.ts) names
  the reads and actions of rule 6 and what each read yields; the tool behind
  a name is the crew tool itself, loaded on first use through `crew/mcp.ts`
  (a static import would form a cycle through the state database). Tools
  that default `project` to the chat's project must name one, since a grown
  thing has no chat. Tool inputs are checked against the crew tool's own
  schema by the kind's async `check`, so a bad input is refused when saved.

Still expected: the vendored library allowlist pinned in one file, like hc's pin
([0021](./0021-hc-terminal-runtime.md)); the surfaces API, binding
resolution, renderer, actions and crew tools. Exporting apps as
`ui://` resources to outside MCP clients is a later follow-on, not v1. See
the matching row in [`specs/README.md`](../README.md).
