# Decision index

Numbered Architecture Decision Records for Beadsmith. The **current**
architecture (short bullets that link here) lives in
[`../README.md`](../README.md). Copy [`../adr-template.md`](../adr-template.md)
for a new record.

Agents: consult these when the work might change system shape. Do not add or
edit an ADR on every conversation — see `.agents/skills/architecture/SKILL.md`.

| ADR | Decision |
| --- | --- |
| [0001](./0001-remote-sql-control-plane.md) | Server over one remote Dolt SQL server; no local workspaces or desktop credential helpers |
| [0003](./0003-dolt-read-plane.md) | One Dolt reader; parameterized SELECT/SHOW; four failure classes |
| [0004](./0004-service-local-sqlite.md) | `state.db` holds settings, dispatch, policy, and checkout maps |
| [0005](./0005-bind-policy-and-cloudflare-access.md) | Bind policy + optional Access JWT + `__Host-bdx_session` |
| [0006](./0006-durable-agent-dispatch.md) | File/Tackle persist-then-launch; board drag is dispatch, not PATCH |
| [0008](./0008-runtime-and-deployment.md) | Deno 2.9.8 / SvelteKit 2; Compose production; Tailscale is for agents |
| [0009](./0009-edge-identity-and-catalog-gate.md) | One Google Access IdP; catalog is the gate before a second identity |
| [0010](./0010-in-app-backups.md) | Scheduled SQL backups to any S3-compatible bucket; encrypted credentials in `state.db` |
| [0011](./0011-accounts-and-roles.md) | Better Auth accounts in `state.db`; admin/member roles; Access optional |
| [0012](./0012-project-helper.md) | **Superseded by 0013.** New project databases from a tailnet project helper on the Dolt host |
| [0013](./0013-owner-account-and-global-readers.md) | Single-owner server: the owner's `bd` account has `ALL ON *.*`, so plain `bd init` creates projects; readers have `SELECT ON *.*` |
| [0014](./0014-public-repo-nix-and-fleet.md) | Public repo with its host and sops secrets; one Nix overlay feeds devenv, checks, VM test and the published image |
