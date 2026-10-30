# 0005. Request gates and optional Cloudflare Access

Date: 2026-08-12; revised 2026-10-27

## Status

accepted; revised 2026-10-27. Supersedes
[0009](./0009-edge-identity-and-catalog-gate.md). Accounts
([0011](./0011-accounts-and-roles.md)) are always on, so the bind policy, the
no-accounts mode, `BDX_AUTH_TOKEN`, and the Access email allowlist are gone.
The file name keeps its old slug so links stay valid.

## Context

Beadsmith is meant to be self-hosted by people who have never heard of
Cloudflare Zero Trust, often behind a tunnel or reverse proxy, sometimes bound
to `0.0.0.0` in a container. The first design (2026-08-12) assumed one operator
behind Cloudflare Access with a Google login, plus a bind policy that refused a
non-loopback address unless a shared token or, later, accounts were configured.
By October that meant five overlapping ideas: bind-policy classes, loopback
detection, an Access JWT with an email allowlist and a service-token
allowlist, Better Auth sessions, and an implicit-operator mode when accounts
were off. The owner found it too hard to follow.

## Decision

We will require a signed-in account on every route, whatever the bind
address, and keep Cloudflare Access only as an optional outer layer whose job
is to verify that traffic came through Access and to let one machine principal
read.

`src/hooks.server.ts` runs these gates in order:

1. **Config check.** `checkConfig` (`src/lib/server/env.ts`) fails every
   request with 403 when `BEADS_DOLT_SERVER_HOST` is missing, Access is half
   configured, the service-token allowlist is malformed, or
   `BDX_PUBLIC_ORIGIN` is malformed or not in `BDX_ALLOWED_HOSTS`. The reason
   goes to the server log; the console shows a class (`configClass`).
2. **Health.** `GET /healthz` returns a bodyless 204 only when both the socket
   peer and the Host header are loopback; anything else gets 403. It needs no
   account and returns no identity.
3. **Host allowlist.** Loopback names plus `BDX_ALLOWED_HOSTS` (DNS rebinding).
4. **Origin and fetch metadata.** A present `Origin` must equal the request
   origin, corrected to `BDX_PUBLIC_ORIGIN` for that one host behind a
   TLS-terminating proxy. `Sec-Fetch-Site: cross-site` is refused except for a
   GET/HEAD top-level navigation.
5. **Cloudflare Access (optional).** With `BDX_CF_ACCESS_ISSUER` and
   `BDX_CF_ACCESS_AUDIENCE` set, every route, sign-in included and even from
   loopback, needs `Cf-Access-Jwt-Assertion`.
   `src/lib/server/cloudflare-access.ts` verifies RS256 against the team JWKS,
   issuer, audience, expiry / nbf / iat (60s skew) and `type: app`. A human
   token passes; which people get one is the Access policy's business, and they
   still need an account. A service token (empty `sub`) passes only when its
   `common_name` is in `BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS`. Denials log a
   fixed reason code, never a token, email, or Client ID.
6. **CSRF header.** Every mutation under `/api` needs `x-bdx-request: 1`.
7. **Account session and role** ([0011](./0011-accounts-and-roles.md)).
   Everything except `/auth`, its assets, and `/api/auth/*` needs a Better
   Auth session; pages redirect to `/auth`, `/api` answers 401. The one
   exception is a verified service token, which may GET/HEAD `/api` as a
   read-only `member` with no cookie, no HTML, and no writes.
8. **Rate limits**, CSP and security headers, and secret scrubbing on every
   response.

## Consequences

Any bind is fine, so the container default (`0.0.0.0`), a reverse proxy, and
a tunnel all work without extra settings. Removed env vars: `BDX_AUTH_TOKEN`,
`BETTER_AUTH_SECRET`, `BDX_CF_ACCESS_ALLOWED_EMAILS`; `HOST` is now only the
adapter's bind address.

Access users sign in twice: once to Access, once to Beadsmith. That is the cost
of having one identity system that works without Cloudflare.

Agents still depend on Access for reads: without it there is no machine
principal. Account-scoped read tokens would remove that
dependency, and then Access support could be deleted.

Every account and the service token see every SQL-visible project until the
catalog and membership model in `docs/public-access.md` exists.

## Alternatives considered

**Keep the bind policy and the no-accounts mode for loopback installs.**
Rejected 2026-10-27: it is the reason the model had two of everything, and
the secret it needed can be generated on first start.

**Delete Cloudflare Access support now.** Removes about 320 lines and three
env vars, but agents would lose their only read path until API tokens exist.
Deferred until read-only API tokens exist ([agent access](../../docs/agent-access.md#follow-up)).

**Keep the Access email allowlist.** It duplicated the Access policy and,
with accounts always on, no longer decided who a person is. Removed.

**`BDX_AUTH_TOKEN` as the public user or machine identity.** Rejected in
2026-08: shared secret, no subject, rotation logs everyone out. Removed.

**Trust Access email headers without verifying the JWT.** Rejected: a tunnel
or routing mistake must not become an identity.

## Implementation notes

- Config and Access parsing: `readEnv`, `checkConfig`, `configClass`,
  `isLoopbackHost` in `src/lib/server/env.ts`; tests in
  `src/lib/server/env.test.ts`.
- Gates: `src/hooks.server.ts`; transport and Access tests in
  `src/hooks.server.test.ts`, account paths in `src/hooks.accounts.test.ts`.
- JWT verifier: `src/lib/server/cloudflare-access.ts` and its test.
- CSRF header, rate limits, security headers, scrubbing:
  `src/lib/server/security.ts`. The client sends the CSRF header from
  `src/lib/client/api.ts`.
- `deno task preflight:server` (`scripts/preflight-server.ts`) runs `checkConfig`.
- Operator docs: `docs/configuration.md`, `docs/server-deployment.md`,
  `docs/public-access.md`, `docs/agent-access.md`.
