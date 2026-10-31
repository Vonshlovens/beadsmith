# 0009. Edge identity and catalog gate

Date: 2026-08-12

## Status

superseded by [0005](./0005-bind-policy-and-cloudflare-access.md) (revised
2026-10-27) and [0011](./0011-accounts-and-roles.md).

## What this decided

Cloudflare Access with one Google identity provider was to be the only login,
with an exact email allowlist at the origin and one Access service token as a
read-only machine principal. Selective project sharing was to wait for a
curated catalog and membership tables.

## What replaced it

- Identity: Beadsmith accounts, always on
  ([0011](./0011-accounts-and-roles.md)). Access is an optional outer layer
  without an email allowlist ([0005](./0005-bind-policy-and-cloudflare-access.md)).
  Which identity provider Access uses is the operator's choice, not this app's.
- Machine reads: the Access service-token path is unchanged
  (`docs/agent-access.md`); account-scoped API tokens are the follow-up.
- Catalog gate: still the rule before projects are shared selectively. Every
  account sees every SQL-visible project today. The target model lives in
  `docs/public-access.md`; per-project membership is not built yet.
- Unchanged: membership never grants raw Dolt SQL, host access, or agent-worker
  capability ([0006](./0006-durable-agent-dispatch.md)); Tailscale + `bd` is
  the agent write path, not the read path
  ([0008](./0008-runtime-and-deployment.md)).
