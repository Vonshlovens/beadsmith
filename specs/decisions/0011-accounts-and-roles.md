# 0011. Built-in accounts and roles with Better Auth

Date: 2026-10-17

## Status

accepted (amends [0005](./0005-bind-policy-and-cloudflare-access.md) and
[0009](./0009-edge-identity-and-catalog-gate.md)); amended 2026-10-27: accounts
are always on, the secret is generated when not given, and the no-accounts
mode, bind policy, and `BDX_AUTH_TOKEN` are removed.

## Context

Remote access depended on Cloudflare Access with one Google identity, plus a
shared `BDX_AUTH_TOKEN` that let any holder in through `/auth`. That works for
one operator who already runs a Zero Trust team. It does not work for someone
self-hosting the open-source release, and it gives no answer to “who is this”
beyond one email.

Two shipped features need a real identity. Backups store encrypted bucket
credentials in `state.db` ([0010](./0010-in-app-backups.md)), so whoever can
reach the console can redirect every future backup; the console must become
admin-only. Later work (per-project membership; an MCP
server) needs accounts and roles to extend.

The owner chose the Better Auth library (MIT) on 2026-10-17.

Out of scope here: passkeys, social sign-in, email delivery (invites and
password reset), per-project membership, API keys for agents.

## Decision

We will add built-in accounts with Better Auth, stored in the service-local
SQLite file, with two roles, and make Cloudflare Access an optional outer
layer.

- **Always on.** Every route except sign-in needs an account. The secret that
  signs session cookies comes from `BETTER_AUTH_SECRET_FILE` when set,
  otherwise from `<state_dir>/auth-secret`, generated (mode 0600) on first
  start. It must be at least 32 characters. If it cannot be read or created,
  every request fails closed with 503 and the reason goes to the server log.
  *(Before 2026-10-27 accounts were off unless a secret was configured.)*
- **Storage.** Better Auth's Drizzle adapter over the existing libsql client.
  Tables `auth_user`, `auth_session`, `auth_account`, `auth_verification`
  (`state/schema.ts`; created at startup like the others). Passwords exist
  only as scrypt hashes in `auth_account.password`.
- **Sign-in.** Email and password, 12–128 characters. Sessions last 7 days and
  slide daily; the session row is read on every request (no cookie cache), so
  a role change or removal applies at once. The cookie keeps the name
  `__Host-bdx_session` (Secure, HttpOnly, SameSite=Strict, Path=/).
- **First run.** While no account exists the server writes a one-time token to
  `<state_dir>/setup-token` (mode 0600) and logs its path. Creating the first
  account requires that token and makes the account an admin; the file is then
  deleted. Afterwards self sign-up is closed. An admin can open it (new
  accounts are members) or create accounts with an initial password.
- **Roles.** `admin` and `member`, expressed as Better Auth access-control
  statements (`auth/roles.ts`): the admin plugin's `user`/`session`
  statements plus `console:manage` and `dispatch:launch`. The request gate
  asks for a permission, not a role name, so new roles and resources slot in.
  - `console:manage`: `/console` and every `/api/console/*` route, backups
    included, and any API write not listed below.
  - `dispatch:launch`: File/Tackle/comment launch, cancel, and follow-up.
  - Any signed-in role: every read, `/api/auth/*` (own session and password),
    the theme setting, and project refresh.
  - The last admin cannot be removed or demoted, and nobody can remove or
    demote themselves.
- **Surface.** `/api/auth/*` exposes only `get-session`, `sign-in/email`,
  `sign-up/email`, `sign-out`, and `change-password`. Account management runs
  through `/api/console/accounts*`, which calls the admin plugin server-side
  with the admin's own headers. Every existing gate still runs first: Host
  allowlist, Origin, fetch metadata, the `x-bdx-request` header on every
  mutation (Better Auth's included), CSP, rate limits, secret scrubbing.
  Password attempts also draw on a 10-per-minute per-address bucket; Better
  Auth's own limiter, IP tracking, and telemetry are off.
- **No implicit operator.** There is no unauthenticated mode and no bind
  policy: any bind address is fine because nothing is served signed out.
  `BDX_AUTH_TOKEN` is no longer read.
- **Access.** When configured it stays in front of everything, sign-in
  included, and a human still needs an account after Access. Allowlisted
  service-token principals keep sessionless GET/HEAD `/api` reads as members
  ([0005](./0005-bind-policy-and-cloudflare-access.md)).
- **Subrequests.** SSR `event.fetch` calls get fresh `locals`, so the hooks
  establish identity and role for them again from the forwarded cookie
  instead of letting them through.

## Consequences

Anyone self-hosting gets real sign-in without Cloudflare or any secret to
create, and Access remains available as defense in depth. Backups and every other console setting are
admin-only. Signed-out visitors no longer receive the shell's project list.

Members cannot launch agents yet: that authority belongs to per-project
membership. The theme is still one server-wide setting.

There is no email: invites are an admin-set initial password, and a forgotten
password needs another admin. A lost last-admin password is recovered from
the host with `deno task accounts` (`scripts/accounts.ts`), which sets a
password or promotes an account directly in `state.db`.

Behind a tunnel every client shares one address, so the credential bucket is
effectively global there.

Agents with only accounts (no Access) have no read principal yet; Better Auth
API keys are the candidate.

## Alternatives considered

**Generic OIDC or trusted proxy headers instead of accounts.** Lets
self-hosters bring an identity provider, but still needs a user table for
roles, and most small installs have no IdP. Better Auth can add OIDC later.

**Keep `BDX_AUTH_TOKEN` as an admin password.** One shared secret, no
subject, no roles; rejected in 0005 for the same reasons.

**Admin plugin endpoints straight from the browser.** Less code, but a larger
public surface and no place for the last-admin rule. Console routes wrap it.

## Implementation notes

- Service and Better Auth options: `src/lib/server/auth/service.ts`. Roles and
  the request permission map: `auth/roles.ts`. Bootstrap token:
  `auth/bootstrap.ts`. Secret: `auth/secret.ts`. Tables and counts:
  `auth/store.ts`, `state/schema.ts`. Console account changes: `auth/admin.ts`.
  Host-side recovery: `auth/recovery.ts` behind `scripts/accounts.ts`.
- Gate: `establishIdentity` and `roleDenial` in `src/hooks.server.ts`; console
  page check in `src/routes/console/+layout.server.ts`.
- Routes: `src/routes/api/auth/[...all]/`, `src/routes/api/console/accounts/`,
  `src/routes/auth/`, `src/routes/account/`. UI:
  `src/lib/components/account-settings.svelte`, `src/lib/client/auth.ts`.
- Env: optional `BETTER_AUTH_SECRET_FILE` (`auth/secret.ts`); otherwise
  `<state_dir>/auth-secret`.
- Tests: `src/hooks.accounts.test.ts`, `src/lib/server/auth/*.test.ts`,
  `src/routes/api/auth/[...all]/server.test.ts`, `src/lib/server/env.test.ts`.
- Row in [`specs/README.md`](../README.md).
