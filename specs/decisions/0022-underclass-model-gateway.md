# 0022. Underclass is the model gateway; the console reads it, sandboxes never reach it

Date: 2026-11-11

## Status

accepted. Records how Beadsmith uses
[Underclass](https://github.com/ghuntley/underclass), which
[0016](./0016-first-mate-worker-runtime.md) already runs on forge behind the
guest's key-injecting filter. Keeps rule 6 of
[0015](./0015-scoped-agent-sandboxes.md) as written and leaves Sand's model
path from [0018](./0018-sand-e2b-sandboxes.md) unchanged.

## Context

Underclass pools Claude Code, Codex and Copilot subscriptions behind one
endpoint. It routes each request to an account that serves its surface
(`/v1/messages` for Anthropic, `/v1/responses` and `/v1/chat/completions`
for OpenAI), keeps sessions on one account so prompt caches stay warm, takes
exhausted accounts out of rotation until their window resets, and fails fast
with the earliest reset time when nothing is left. It has two credentials: a
**proxy key** that clients send to `/v1/*`, and a **UI token** for its web UI
and `/admin/api/*`. Its Anthropic surface serves only the official Claude
Code client and swaps that client's bearer for the pooled subscription
credential.

On forge it already runs from its flake's NixOS module, bound to loopback,
with both credentials from sops through systemd credentials
(`fleet/hosts/forge/runtime.nix`). The `mate` guest reaches it through
`fleet/hosts/forge/model-proxy.mjs`, a filter on the guest's host address
that admits only `POST /v1/messages` and `/v1/messages/count_tokens`, drops
every other header, and replaces the guest's placeholder bearer with the
proxy key. Sand chats and missions do not use the pool: E2B's egress adds a
direct Anthropic API key or subscription token to their HTTPS requests.

Two things are missing. The operator cannot see the pool from Beadsmith
(which accounts are healthy, how much of each quota window is left, what is
in flight) and has to tunnel to Underclass's own UI. And the earlier records
left open whether agents should talk to Underclass directly, now that agents
run as interactive CLIs ([0021](./0021-hc-terminal-runtime.md)) and Codex is
the next harness.

Underclass serves its UI, its admin API and its model surface on **one
listener** (`bind` is a single `host:port`). The admin API reaches far
beyond reading: it removes accounts, starts onboarding flows, edits the
model catalog, spends banked resets, and `GET /admin/api/client-key` returns
the proxy key. Whoever can reach that listener is one token away from all
of it.

Out of scope: adding or re-logging accounts from Beadsmith, and model choice
per launch (its own item).

## Decision

Underclass is the one model gateway for agents on the self-hosted runner,
and Beadsmith reads it as an admin console. No sandbox reaches its listener,
and no sandbox holds its keys.

1. **It runs on the forge host, from its own flake.** The flake input and
   `services.underclass` stay as they are, bound to `127.0.0.1` only. The
   proxy key and UI token are sops secrets (`underclass-proxy-key`,
   `underclass-ui-token` in `fleet/secrets/forge.yaml`), delivered as
   systemd credentials; neither is generated at deploy time or written to the
   Nix store. Underclass's listener is never bound to a guest-facing,
   LAN or tailnet address, and its UI is never published (no Funnel, no
   public route).

2. **Guests reach the pool through the host filter, which keeps the key.**
   `model-proxy.mjs` stays the guest's only door to the host, and stays a
   key-injecting filter: the guest's CLI sends a placeholder bearer to
   `ANTHROPIC_BASE_URL` on the guest's host address, and the filter sends the
   proxy key to Underclass on loopback. The guest never holds the proxy key.
   This is the filter's job, not a fallback: it is what keeps Underclass's UI
   and admin API off the guest link, since Underclass cannot serve them on a
   different address from `/v1/*`.
   - The filter admits only the inference routes of the surfaces a shipped
     harness uses. Today that is the Anthropic Messages pair. When Codex
     ships as a harness (0021's seam), the filter gains `POST /v1/responses`
     and the OpenAI headers Codex needs, with tests, in that change. It never
     admits `/`, `/admin/*` or any route a harness does not call, and never
     passes a redirect.
   - Rule 6 of 0015 holds as written: the model credentials (the pooled
     subscriptions) stay inside Underclass, the proxy key stays on the host,
     and the agent can use the pool, within the filter's rules, while the
     guest runs, but cannot read, print or copy either.
   - nftables keeps admitting from each guest's tap only that guest's filter
     port on its host address (`fleet/hosts/forge/microvms.nix`). A future
     forge guest gets its own filter listener on its own host address.

3. **Sand keeps E2B's egress injection.** Sand sandboxes keep receiving a
   direct Anthropic credential from E2B's egress proxy (0018 rule 3); they do
   not use the pool. Reaching Underclass from Sand would mean exposing a
   filter on the tailnet to E2B-hosted nodes, joining Sand chats to the
   tailnet (0018 rule 5 keeps them off it), granting `tag:beads-sandbox` a
   port on forge, and, because tailnet traffic does not pass E2B's egress
   proxy, either putting the proxy key inside every Sand sandbox or running
   our own injecting filter on the tailnet for them. That is a new network
   path from hosted sandboxes into the operator's own host for a gain in
   quota pooling only. A later item may revisit it; it would need its own
   decision.

4. **Beadsmith reads Underclass's admin API, server-side, as admin only.**
   - Settings `BDX_UNDERCLASS_URL` (an HTTPS origin) and
     `BDX_UNDERCLASS_UI_TOKEN_FILE`; without both the feature is off. The
     token is read from the file like every other Beadsmith secret, sent only
     as the bearer to that origin, and never reaches the browser, `state.db`,
     logs or error messages.
   - Transport: forge publishes Underclass's loopback listener on a
     dedicated tailnet HTTPS port with `tailscale serve` (not Funnel), as it
     does for the mate runner, and the tailnet policy lets only the Beadsmith
     host reach that port. This exposes Underclass to one tailnet node, never
     to sandboxes or the internet.
   - Beadsmith calls a fixed allowlist of Underclass routes and never
     forwards a path, query or body from the browser. Reads: `monitor`,
     `state`, `stats`, `usage`. Actions, each its own console route: an
     account's `refresh`, `enable`, `disable` and `reset`. Never called:
     `client-key`, `flows`, account deletion, `relogin`, catalog writes,
     `events/import`.
   - Console routes under `/api/console/` (admin-only, same-origin,
     CSRF-checked) return a typed, sanitized view: accounts (label, backend,
     plan, state, cooldown, quota windows, banked resets), in-flight
     requests, month totals and recent outcomes. Upstream failures map to
     four sanitized classes, as the Dolt reader's do
     ([0003](./0003-dolt-read-plane.md)). Account labels are the
     subscriptions' emails: personal data, shown to admins, never logged;
     an action records its actor and the account id, not the label.
   - A reset spends a banked credit of the operator's own subscription, so
     the console confirms it in words before calling Underclass.

5. **Not doing.** Beadsmith never stores, receives or relays subscription
   credentials, onboarding codes or the proxy key; adding and re-logging
   accounts stays in Underclass's own UI over the operator's SSH tunnel.
   Underclass's UI is not exposed publicly or to members, and no browser
   talks to Underclass.

## Consequences

The operator watches and tends the pool from the console: which account is
cooling and until when, quota left in each window, live requests, and the
month's usage, plus refresh, enable, disable and reset without a tunnel.

Beadsmith now holds the Underclass UI token, a file on its host. That token
is strictly more than the console uses: it can read the proxy key, remove
accounts and start onboarding. Whoever controls the Beadsmith server can
therefore use the pool's quota and disrupt it, though not read the
subscriptions' credentials, which Underclass never returns. The route
allowlist limits what Beadsmith does with it, not what a compromised server
could; the tailnet grant limits where the token works.

Underclass's README records that Anthropic restricts subscription OAuth to
its own clients; Underclass serves only the official Claude Code client.
Beadsmith keeps to that: its agents run the official CLI, and it never
handles the credentials. The same risk already applied to Sand's injected
subscription token (0018).

The guest's environment does not change: placeholder token, base URL on its
host address. Pool routing, stickiness and fail-fast apply to every forge
turn; Sand turns are outside the pool's accounting.

Codex in the guest needs one reviewed widening of the filter, not a new
path. A harness that needs a surface the filter cannot carry gets a new
decision.

## Alternatives considered

**Give the guest the proxy key and point it at Underclass directly.** One
component fewer, and every surface (Codex included) without filter changes.
The proxy key only works against Underclass, so it would be worthless off
the guest link. Rejected because Underclass would have to listen on the
guest's host address, which puts its UI and admin API on the same link as
the agent: one leaked UI token (from a misconfiguration, a log, an operator
paste) would let the agent read the proxy key, remove accounts or spend
resets. It also contradicts rule 6 as written, which keeps any usable key
out of the sandbox.

**Keep the filter as a path allowlist but pass the guest's own bearer.**
Puts the proxy key in the guest for no gain over injection.

**Reach Underclass from Sand over the tailnet.** See rule 3: a new path from
hosted sandboxes into forge, for pooling only.

**Let the forge runner relay Underclass's admin API.** Keeps the UI token
on forge, but makes the runner, whose contract is chats, an admin proxy for
the pool with its own allowlist to keep in step with Underclass. The tailnet
grant gives the same reach with one fewer hop.

## Implementation notes

Shipped before this record: Underclass on forge
([`runtime.nix`](../../fleet/hosts/forge/runtime.nix)), the filter
([`model-proxy.mjs`](../../fleet/hosts/forge/model-proxy.mjs) and its
tests) and the guest firewall
([`microvms.nix`](../../fleet/hosts/forge/microvms.nix)).
[Operations](../../docs/operations/host-forge.md) has account enrollment.

Planned, each in its own change:

- the Underclass client and read-only console routes, with
  `BDX_UNDERCLASS_URL` and `BDX_UNDERCLASS_UI_TOKEN_FILE` in
  `src/lib/server/env.ts` and `docs/configuration.md`;
- the console's model pool page;
- the console's account actions (refresh, enable, disable, reset):
  shipped as `POST /api/console/model-pool/accounts/:id/:action`
  (contract in [`docs/contract.md`](../../docs/contract.md)). The account
  id is the one browser value that reaches Underclass, behind a pattern
  that admits no path characters, and the log line names the acting user's
  id, not their email. Underclass's refusals become fixed codes, since its
  messages can carry upstream text; a refused reset Underclass would accept
  with `force` offers a second, forced confirmation;
- forge's tailnet HTTPS route to Underclass for the Beadsmith host, the
  production secrets by name, and the operator check in
  `docs/operations/host-forge.md`.

The current architecture bullet is in [`specs/README.md`](../README.md).
