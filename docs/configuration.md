# Configuration

Beadsmith reads its settings from environment variables. It does not load
`.env` or other dotenv files itself: under Compose, `compose.yaml` passes the
values from `.env` into the container. Secrets are always files, named by a
`*_FILE` variable and mounted read-only (Compose: `./secrets` at
`/run/secrets`). Never put a password value in `.env` or `compose.yaml`.

## Environment variables

| Variable                                  | Meaning                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BEADS_DOLT_SERVER_HOST`                  | Required hostname or private address of the Dolt SQL server.                                                                                                                                                                                                                                                                                                                                                         |
| `BEADS_DOLT_SERVER_PORT`                  | Dolt SQL port; defaults to `3306`.                                                                                                                                                                                                                                                                                                                                                                                   |
| `BEADS_DOLT_SERVER_USER`                  | SQL user; defaults to `root`. A user with only `SELECT` is enough and recommended.                                                                                                                                                                                                                                                                                                                                   |
| `BEADS_DOLT_PASSWORD_FILE`                | Path to a file holding the Dolt password. Compose: `/run/secrets/dolt-password`.                                                                                                                                                                                                                                                                                                                                     |
| `BEADS_DOLT_PASSWORD`                     | Local development fallback only; see [Running from source](#running-from-source).                                                                                                                                                                                                                                                                                                                                    |
| `BETTER_AUTH_SECRET_FILE`                 | Optional path to a file holding at least 32 random characters that sign account session cookies. Unset: Beadsmith generates `<state dir>/auth-secret` (mode 0600) on first start. Set it only to supply the secret from a secret manager.                                                                                                                                                                            |
| `BDX_STATE_DIR`                           | Directory for service-local application state (settings, dispatch records, accounts, `auth-secret`, `secret.key`, the first-admin `setup-token`).                                                                                                                                                                                                                                                                    |
| `BDX_SECRET_KEY_FILE`                     | Master key (32 bytes) for backup credentials saved in the console; default `<state dir>/secret.key`, generated on first use. See [backups.md](backups.md).                                                                                                                                                                                                                                                           |
| `BDX_ALLOWED_HOSTS`                       | Additional accepted HTTP Host values (comma-separated), for a public hostname. Loopback names are always accepted.                                                                                                                                                                                                                                                                                                   |
| `BDX_CF_ACCESS_ISSUER`                    | Optional Cloudflare Access team origin (`https://<team>.cloudflareaccess.com`). With the audience, every request must carry a valid Access JWT; people still sign in to their account. See [public-access.md](public-access.md).                                                                                                                                                                                     |
| `BDX_CF_ACCESS_AUDIENCE`                  | Cloudflare Access Application Audience (AUD) tag; set together with the issuer.                                                                                                                                                                                                                                                                                                                                      |
| `BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS` | Optional comma-separated Cloudflare Access service-token **Client IDs** (JWT `common_name`), with issuer and audience. Each may read `/api` with GET/HEAD and no account, as a read-only member. Never the Client secret. Invalid IDs fail closed. See [agent-access.md](agent-access.md).                                                                                                                           |
| `BDX_PUBLIC_ORIGIN`                       | Exact public `scheme://host` for the one host reached through a TLS-terminating proxy (Cloudflare Tunnel), e.g. `https://beads.example.com`. Corrects only the scheme half of the Origin/CSRF comparison for that host; its hostname must also appear in `BDX_ALLOWED_HOSTS`. Absent by default — omitting it keeps the strict `event.url.origin` comparison. Malformed or mismatched values fail closed at startup. |
| `BDX_AGENT_ACTORS`                        | Actor substrings used only for read-side activity presentation; default `agent`.                                                                                                                                                                                                                                                                                                                                     |
| `BDX_DISPATCH_PROVIDER`                   | Agent dispatch provider: `webhook` or `none`. Unset means `none`. See [file-tackle-dispatch.md](file-tackle-dispatch.md#providers).                                                                                                                                                                                                                                                                                  |
| `BDX_DISPATCH_WEBHOOK_URL`                | Base URL of a webhook agent runner (https, or http on loopback).                                                                                                                                                                                                                                                                                                                                                     |
| `BDX_DISPATCH_WEBHOOK_SECRET_FILE`        | File holding the shared HMAC secret (32+ characters) for webhook requests; `BDX_DISPATCH_WEBHOOK_SECRET` is the development fallback.                                                                                                                                                                                                                                                                                |

Compose-only settings (`BEADSMITH_IMAGE`, `BEADSMITH_UID`/`GID`,
`BEADSMITH_PORT`, `BEADSMITH_NETWORK`, `BEADSMITH_BIND`) are described in
[`.env.example`](../.env.example).

Every route except sign-in needs an account, whatever address the server binds.
On first start with no account, the server writes a one-time token to
`<state dir>/setup-token`; open `/auth` and paste it to create the first admin.

Removed: `BDX_AUTH_TOKEN`, `BETTER_AUTH_SECRET` and
`BDX_CF_ACCESS_ALLOWED_EMAILS` are no longer read. Delete them from older
`.env` files. `HOST` only tells the server adapter where to bind.

## Running from source

```sh
pnpm install
pnpm run serve
```

`pnpm run serve` builds the current source before it launches the service, so
it cannot accidentally run an older generated server. The service binds
`127.0.0.1:4321`. Open it, follow the first-admin prompt, and sign in.

Set `BEADS_DOLT_SERVER_HOST` (and any non-default port or user) in the shell
that starts the server. The service uses `BEADS_DOLT_PASSWORD_FILE` when it is
set; otherwise `BEADS_DOLT_PASSWORD` is a local fallback. To keep that password
out of your shell history and environment, scope it to one server session:

**POSIX `sh` (restores terminal echo if cancelled):**

```sh
(
	restore_tty() {
		stty echo
	}
	trap 'restore_tty' 0 1 2 15
	printf 'Dolt password: ' >&2
	stty -echo
	if ! IFS= read -r BEADS_DOLT_PASSWORD; then
		printf '\n' >&2
		exit 1
	fi
	restore_tty
	printf '\n' >&2
	export BEADS_DOLT_PASSWORD
	pnpm run serve
)
```

**Fish:**

```fish
begin
	set --local BEADS_DOLT_PASSWORD
	read --silent --prompt-str 'Dolt password: ' BEADS_DOLT_PASSWORD
	and set --local --export BEADS_DOLT_PASSWORD "$BEADS_DOLT_PASSWORD"
	and pnpm run serve
end
```

The password disappears when the server exits. Beadsmith does not fall back to
PowerShell, `secret-tool`, or any other desktop credential helper. A missing or
rejected password is a configuration failure, not an empty project list.

After rotating the Dolt password, restart the service so its SQL connections
use the new file. A value added in another terminal or a changed source file
does not update a running service.
