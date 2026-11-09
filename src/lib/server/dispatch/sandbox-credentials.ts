/**
 * Short-lived credentials the E2B provider hands to one sandbox run
 * (ADR-0018). Each is minted per run and scoped as narrowly as its issuer
 * allows:
 *
 * - a Tailscale auth key: single use, pre-authorized, ephemeral, tagged, ten
 *   minutes to live. The node it creates disappears when the sandbox stops.
 * - a GitHub App installation token for exactly one repository, contents and
 *   pull requests only (read-only when the run cannot open a PR). It never
 *   enters the sandbox: E2B's egress adds it to requests to GitHub.
 * - the project's own Dolt account, from an operator file. This is the one
 *   credential the sandbox holds itself (ADR-0015, rule 6).
 *
 * Long-lived secrets (the OAuth client secret, the App private key, the E2B
 * and Anthropic keys) stay in files on the Beadsmith host.
 */
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DispatchError } from './types.js';

type Fetch = typeof fetch;
const REQUEST_TIMEOUT_MS = 15_000;
const TAILSCALE_API = 'https://api.tailscale.com/api/v2';
const GITHUB_API = 'https://api.github.com';
const DOLT_USER_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const DATABASE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Read one secret file, trimmed. The path never appears in an error. */
export async function readSecretFile(path: string, what: string): Promise<string> {
	try {
		const value = (await readFile(path, 'utf8')).trim();
		if (value.length > 0) return value;
	} catch {
		// Fall through to the generic message.
	}
	throw new DispatchError('unavailable', `The ${what} file could not be read.`);
}

async function postJson(
	fetch_impl: Fetch,
	url: string,
	init: { headers: Record<string, string>; body: string },
	what: string
): Promise<Record<string, unknown>> {
	let response: Response;
	try {
		response = await fetch_impl(url, {
			method: 'POST',
			headers: init.headers,
			body: init.body,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch {
		throw new DispatchError('unavailable', `${what} could not be reached.`);
	}
	if (!response.ok) {
		throw new DispatchError(
			'unavailable',
			`${what} refused the request (HTTP ${response.status}).`
		);
	}
	try {
		const parsed: unknown = await response.json();
		if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
	} catch {
		// Fall through.
	}
	throw new DispatchError('unavailable', `${what} returned an unreadable answer.`);
}

export interface TailscaleKeyOptions {
	client_id: string;
	client_secret: string;
	tags: string[];
	fetch?: Fetch;
}

/**
 * Mint one single-use, pre-authorized, ephemeral auth key through a
 * Tailscale OAuth client (scope `auth_keys`, owning the tags).
 */
export async function mintTailscaleAuthKey(options: TailscaleKeyOptions): Promise<string> {
	const fetch_impl = options.fetch ?? fetch;
	const token = await postJson(
		fetch_impl,
		`${TAILSCALE_API}/oauth/token`,
		{
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: options.client_id,
				client_secret: options.client_secret,
				grant_type: 'client_credentials'
			}).toString()
		},
		'Tailscale'
	);
	if (typeof token.access_token !== 'string') {
		throw new DispatchError('unavailable', 'Tailscale returned no access token.');
	}
	const key = await postJson(
		fetch_impl,
		`${TAILSCALE_API}/tailnet/-/keys`,
		{
			headers: {
				authorization: `Bearer ${token.access_token}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				capabilities: {
					devices: {
						create: { reusable: false, ephemeral: true, preauthorized: true, tags: options.tags }
					}
				},
				expirySeconds: 600,
				description: 'beadsmith sandbox run'
			})
		},
		'Tailscale'
	);
	if (typeof key.key !== 'string' || !key.key.startsWith('tskey-')) {
		throw new DispatchError('unavailable', 'Tailscale returned no auth key.');
	}
	return key.key;
}

/** `https://github.com/<owner>/<repo>(.git)` → owner and repo, or undefined. */
export function parseGithubRepository(url: string): { owner: string; repo: string } | undefined {
	try {
		const parsed = new URL(url);
		const match = /^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(
			parsed.pathname
		);
		if (
			parsed.protocol !== 'https:' ||
			parsed.hostname !== 'github.com' ||
			parsed.username !== '' ||
			parsed.password !== '' ||
			match === null
		) {
			return undefined;
		}
		return { owner: match[1], repo: match[2] };
	} catch {
		return undefined;
	}
}

function base64url(value: string | Buffer): string {
	return Buffer.from(value).toString('base64url');
}

/** RS256 app JWT, valid for nine minutes (GitHub allows ten). */
export function githubAppJwt(app_id: string, private_key: string, now = new Date()): string {
	const iat = Math.floor(now.getTime() / 1000) - 60;
	const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const payload = base64url(JSON.stringify({ iat, exp: iat + 540, iss: app_id }));
	const signer = createSign('RSA-SHA256');
	signer.update(`${header}.${payload}`);
	return `${header}.${payload}.${base64url(signer.sign(private_key))}`;
}

export interface GithubTokenOptions {
	app_id: string;
	private_key: string;
	repository_url: string;
	/**
	 * Contents and pull requests write; otherwise both read only, so an agent
	 * can still look up a pull request's state with `gh`.
	 */
	write: boolean;
	fetch?: Fetch;
	now?: Date;
}

/** An installation token limited to one repository. */
export async function mintGithubRepositoryToken(options: GithubTokenOptions): Promise<string> {
	const fetch_impl = options.fetch ?? fetch;
	const repository = parseGithubRepository(options.repository_url);
	if (repository === undefined) {
		throw new DispatchError(
			'unavailable',
			'Sandbox checkouts must be https://github.com repositories.'
		);
	}
	const jwt = githubAppJwt(options.app_id, options.private_key, options.now);
	const headers = {
		accept: 'application/vnd.github+json',
		authorization: `Bearer ${jwt}`,
		'x-github-api-version': '2022-11-28'
	};
	let installation: Response;
	try {
		installation = await fetch_impl(
			`${GITHUB_API}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/installation`,
			{ headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
		);
	} catch {
		throw new DispatchError('unavailable', 'GitHub could not be reached.');
	}
	if (installation.status === 404) {
		throw new DispatchError('unavailable', 'The GitHub App is not installed on this repository.');
	}
	if (!installation.ok) {
		throw new DispatchError(
			'unavailable',
			`GitHub refused the installation lookup (HTTP ${installation.status}).`
		);
	}
	const found = (await installation.json().catch(() => ({}))) as Record<string, unknown>;
	if (typeof found.id !== 'number') {
		throw new DispatchError('unavailable', 'GitHub returned no installation for this repository.');
	}
	const minted = await postJson(
		fetch_impl,
		`${GITHUB_API}/app/installations/${found.id}/access_tokens`,
		{
			headers: { ...headers, 'content-type': 'application/json' },
			body: JSON.stringify({
				repositories: [repository.repo],
				permissions: options.write
					? { contents: 'write', pull_requests: 'write' }
					: { contents: 'read', pull_requests: 'read' }
			})
		},
		'GitHub'
	);
	if (typeof minted.token !== 'string' || minted.token.length < 20) {
		throw new DispatchError('unavailable', 'GitHub returned no installation token.');
	}
	return minted.token;
}

export interface DoltAccount {
	user: string;
	password: string;
}

/**
 * The sandbox Dolt account for one project database, from
 * `{ "<database>": { "user": "...", "password": "..." } }`. Each account
 * should hold `ALL PRIVILEGES ON <database>.*` and nothing on `*.*`
 * (docs/sand-e2b.md). A project without an entry cannot launch in a sandbox.
 */
export async function readDoltAccount(path: string, database: string): Promise<DoltAccount> {
	if (!DATABASE_PATTERN.test(database)) {
		throw new DispatchError('unavailable', 'The project database name is not usable in a sandbox.');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, 'utf8'));
	} catch {
		throw new DispatchError('unavailable', 'The sandbox Dolt accounts file could not be read.');
	}
	const entry =
		typeof parsed === 'object' && parsed !== null
			? (parsed as Record<string, unknown>)[database]
			: undefined;
	if (typeof entry !== 'object' || entry === null) {
		throw new DispatchError(
			'forbidden',
			'This project has no sandbox Dolt account. Add one before launching it in a sandbox.'
		);
	}
	const { user, password } = entry as Record<string, unknown>;
	if (
		typeof user !== 'string' ||
		!DOLT_USER_PATTERN.test(user) ||
		typeof password !== 'string' ||
		password.length < 16
	) {
		throw new DispatchError('unavailable', "This project's sandbox Dolt account is malformed.");
	}
	return { user, password };
}
