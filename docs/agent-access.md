# Agent Access to Beadsmith

- **Status:** Agents read the JSON API through one Cloudflare Access service
  token, implemented at the origin. Creating the token and putting its secret in
  the agent's environment are operator steps. Deployments without Cloudflare
  Access have no machine read path yet; account-scoped API tokens
  are the planned replacement.
- **Companions:** [public-access.md](./public-access.md),
  [contract.md](./contract.md), [server-deployment.md](./server-deployment.md).

## Objective

Let an isolated agent (a cloud agent VM, or any runtime without a browser)
read the same cross-repo Beads catalog a signed-in person sees, without giving
it Dolt SQL, a server shell, the web process's password, or lifecycle
authority.

## Two jobs, two tools

| Job                                                     | Owner                         | What an agent needs                                            |
| ------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------- |
| Cross-repo **read** (the reason this app exists)        | Beadsmith                     | A machine principal that can call the existing read API.       |
| Same-repo **lifecycle** (create, claim, close, comment) | `bd` in the agent's workspace | The Beads CLI plus a private path to that project's Dolt data. |

Beadsmith stays read-only. It does not grow a `bd` binary, a workspace mount,
or a Dolt write path to help agents. File and Tackle in the UI launch an agent
that owns `bd` ([file-tackle-dispatch.md](./file-tackle-dispatch.md)).

## How it works

```text
Agent
  |
  | HTTPS + CF-Access-Client-Id + CF-Access-Client-Secret
  v
Cloudflare Access (Service Auth policy for that token,
                   plus the Allow policy for people)
  |
  | Cf-Access-Jwt-Assertion (service-token application JWT)
  v
Beadsmith
  |  verify the JWT (issuer, audience, signature, time claims)
  |  common_name must be in BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS
  |  GET/HEAD under /api only, as a read-only member, no cookie
  v
private Dolt (read-only SQL)
```

A service-token JWT has an empty `sub` and carries the Client ID in
`common_name`. The origin accepts an empty `sub` only when `common_name`
exactly matches the allowlist; otherwise it answers a generic 403 and logs
`reason=service_token_not_allowlisted` (never the ID, token, or secret).

The principal is a read-only `member` with no account and no session. It may
call GET/HEAD under `/api` (`/api/projects`, issue lists, issue detail,
activity, status). It may not mint a cookie, load HTML, call any mutation
(theme, refresh, dispatch), or reach admin-only `/api/console/*` reads.
Host, Origin, and rate-limit checks still apply. Identity comes only from the
verified JWT, never from a `CF-Access-Client-Id` request header.

People behind the same Access application still sign in to their own account.

## Operator setup

Not in git, and never pasted into an agent transcript.

1. Configure Access on the origin: `BDX_CF_ACCESS_ISSUER`,
   `BDX_CF_ACCESS_AUDIENCE` ([configuration.md](./configuration.md)).
2. In Cloudflare Zero Trust, create one service token for this use, for example
   `agent-beadsmith-read`, and add a **Service Auth** policy on the Access
   application that includes only that token. Do not add Everyone or Bypass.
3. Put its Client ID in `BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS` and restart
   Beadsmith.
4. Store the Client ID and secret in the agent environment's secret store
   (for example `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`).
   Never in the repository or a dotenv file. The agent gets no Dolt password,
   Tailscale key, or SSH key for this path.

Smoke read from the agent:

```sh
curl -sS -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "accept: application/json" \
  https://beads.example.com/api/projects
```

## Scope

Until per-project membership exists, the service token reads every project the
SQL reader can discover, the same as any member account. A second Client ID
gets the same scope; list it only if that is acceptable.

## Rejected alternatives

1. **Commit `.beads/issues.jsonl` for agents to read.** JSONL is a passive
   export, not cross-repo, and stale as soon as another workspace writes Dolt.
2. **Expose Dolt SQL to agents.** Publishes the data plane, bypasses the
   control plane, and hands every agent a database credential.
3. **Tailscale in every agent so it reaches the private Dolt host.** Couples
   every agent VM to the private network and still skips this service.
4. **A shared static token.** No subject, no per-caller revocation. The old
   `BDX_AUTH_TOKEN` is gone for that reason.
5. **Bypass or Everyone on the Access application.** A machine caller is not a
   reason to weaken human login.
6. **Drive the HTML UI.** Sign-in, CSRF, and cookies are browser flows.
7. **MCP or `bd` inside the web process as a command proxy.** MCP, if added,
   is a facade over these authorized HTTP reads, not a shell.

## Follow-up

Planned: an admin mints and revokes read-only API tokens in the
console, scoped to the `member` role and the same sessionless GET/HEAD `/api`
path. That gives agents read access without Cloudflare Access, after which
Access support can be dropped entirely.
