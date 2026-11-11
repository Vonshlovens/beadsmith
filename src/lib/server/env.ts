import type {
	DispatchProviderError,
	DispatchProviderId,
	UnderclassConfigError
} from '#lib/types.js';
import { MATE_RUNNER_IDS, type MateRunnerId } from '#lib/mate.js';
import { normalizeCloudflareAccessIssuer } from './cloudflare-access.js';
import {
	loadTackleRepositoriesFromEnv,
	type TackleRepositoryMapping
} from './dispatch/repositories.js';
import { resolveStateDir } from './state/dir.js';
import { EFFORT_PATTERN, MODEL_PATTERN } from '#lib/agent-session/claude-code.js';
import type { E2bBaseSettings } from './e2b/sandbox.js';

export { resolveStateDir };

/**
 * Typed, validated view of the process environment.
 *
 * The Dolt password is deliberately NOT part of this type. `dolt-password.ts`
 * resolves it and hands it straight to the consumer that needs it.
 */
export interface ServerEnv {
	dolt_host?: string;
	dolt_port: number;
	dolt_user: string;
	/** true when a host was configured at all */
	dolt_configured: boolean;
	/**
	 * Optional Cloudflare Access in front of the app (ADR-0005): every request
	 * must then carry a JWT signed for this issuer and audience. Accounts still
	 * decide who a person is; the allowlisted service tokens may read `/api`.
	 */
	cloudflare_access?: {
		issuer: string;
		audience: string;
		/** Access service-token Client IDs (JWT `common_name`). Never secrets. */
		allowed_service_token_ids: string[];
	};
	cloudflare_access_error?: 'incomplete' | 'invalid_service_token_id';
	/**
	 * Team host from a valid Cloudflare Access issuer (`*.cloudflareaccess.com`).
	 * Omitted when the issuer is absent or is not a Cloudflare One origin
	 * (JWKS URLs never appear here).
	 */
	cloudflare_access_issuer_host?: string;
	/** True when `BDX_CF_ACCESS_AUDIENCE` is non-empty. Never the AUD tag. */
	cloudflare_access_audience_configured: boolean;
	/** Successfully normalized service-token Client IDs. Never secrets. */
	cloudflare_access_service_token_ids: string[];
	/**
	 * The operator-configured public origin for the one host reached through a
	 * TLS-terminating proxy (Cloudflare Tunnel). Used only to correct the
	 * scheme half of the Origin comparison for that exact host; never derived
	 * from a client-supplied header.
	 */
	public_origin?: { hostname: string; origin: string };
	public_origin_error?: 'invalid' | 'host_not_allowed';
	allowed_hosts: string[];
	state_dir: string;
	/**
	 * `BDX_SECRET_KEY_FILE`: master key for secrets stored in `state.db`.
	 * Unset means `<state_dir>/secret.key`, generated on first use.
	 */
	secret_key_file?: string;
	agent_actors: string[];
	/**
	 * Default agent dispatch provider: the first usable entry of
	 * `BDX_DISPATCH_PROVIDER`, or `none`.
	 */
	dispatch_provider: DispatchProviderId | 'none';
	/**
	 * Every usable provider, in `BDX_DISPATCH_PROVIDER` order (a comma list;
	 * the first is the default). A launch may pick any of them.
	 */
	dispatch_providers: DispatchProviderId[];
	/** Display name per provider (`BDX_DISPATCH_WEBHOOK_LABEL`, `BDX_E2B_LABEL`). */
	dispatch_labels: Record<DispatchProviderId, string>;
	/** Why a requested provider is not active; absent when all are. */
	dispatch_provider_error?: DispatchProviderError;
	/** E2B sandbox settings when `e2b` is requested and complete. Paths, not secrets. */
	dispatch_e2b?: E2bSettings;
	/** `BDX_DISPATCH_WEBHOOK_URL`, validated (https, or http on loopback). */
	dispatch_webhook_url?: string;
	/**
	 * Project id → GitHub checkout used for Tackle. Empty when none are
	 * configured; SQLite console maps may still apply. Tackle fails closed
	 * when this env/file config is present but unusable.
	 */
	tackle_repositories: Record<string, TackleRepositoryMapping>;
	/** Set when BDX_TACKLE_REPOSITORIES(_FILE) is present but unusable. */
	tackle_repositories_error?: 'invalid';
	/**
	 * `BDX_MATE_RUNNER_URL`, validated like the webhook URL (https, or http on
	 * loopback). Set only when a secret is configured too; First Mate then
	 * answers admins through the mate runner (docs/first-mate.md).
	 */
	mate_runner_url?: string;
	/** Why a requested chat runner is not active although something was configured. */
	mate_runner_error?: 'url_invalid' | 'secret_missing' | 'invalid' | 'e2b_config_missing';
	/**
	 * Usable First Mate chat runners, default first: `BDX_MATE_RUNNERS`
	 * (`remote`, `e2b`), or just `remote` when unset. A new chat may pick any
	 * of them and keeps it for its life.
	 */
	mate_runners: MateRunnerId[];
	/** Display names (`BDX_MATE_RUNNER_LABEL`; `BDX_E2B_LABEL` for e2b). */
	mate_labels: Record<MateRunnerId, string>;
	/** E2B chat settings when `e2b` is a usable chat runner. */
	mate_e2b?: E2bMateSettings;
	/**
	 * Most missions one First Mate chat may start through crew tools in a
	 * sliding window (ADR-0020 rule 6): `BDX_CREW_LAUNCH_LIMIT` (default 10)
	 * per `BDX_CREW_LAUNCH_WINDOW_MINUTES` (default 10).
	 */
	crew_launch_limit: { count: number; window_minutes: number };
	/**
	 * The models and reasoning efforts a launch may ask for, in the
	 * operator's order: `BDX_AGENT_MODELS` and `BDX_AGENT_EFFORTS` (comma
	 * lists). Empty means launches take the runner's default only; an entry
	 * that is not a model name or effort level is dropped.
	 */
	agent_models: string[];
	agent_efforts: string[];
	/**
	 * Underclass's admin API, read by the console (ADR-0022 rule 4): its
	 * origin (`BDX_UNDERCLASS_URL`) and the path of its UI token
	 * (`BDX_UNDERCLASS_UI_TOKEN_FILE`). Absent unless both are set and the URL
	 * is usable; the model pool console is then off.
	 */
	underclass?: UnderclassSettings;
	/** Why Underclass is off although one of its settings is present. */
	underclass_error?: UnderclassConfigError;
}

/** Where the console reads the model pool. A path, never the token itself. */
export interface UnderclassSettings {
	/** An `https://` origin (or `http://` on loopback, for development), no path. */
	origin: string;
	ui_token_file: string;
}

/** First Mate chats in E2B sandboxes: one sandbox per chat (docs/sand-e2b.md). */
export interface E2bMateSettings extends E2bBaseSettings {
	/** `BDX_E2B_MATE_IDLE_MINUTES`: a quiet chat's sandbox pauses after this. */
	idle_minutes: number;
	/** `BDX_E2B_MATE_MAX_SESSIONS`: live chat processes at once. */
	max_sessions: number;
	/** Where the runner keeps each chat's event log (under the state dir). */
	state_dir: string;
}

export const DEFAULT_DOLT_PORT = 3306;
export const DEFAULT_DOLT_USER = 'root';
export const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '::1', '[::1]', '0:0:0:0:0:0:0:1'];

/** Validate a webhook runner base URL: https, or http only on loopback. */
export function parseWebhookUrl(raw: string | undefined): string | undefined {
	if (raw === undefined || raw.trim() === '') return undefined;
	try {
		const url = new URL(raw.trim());
		const loopback = LOOPBACK_HOSTNAMES.includes(url.hostname.toLowerCase());
		if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return undefined;
		if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
			return undefined;
		}
		return url.toString().replace(/\/$/, '');
	} catch {
		return undefined;
	}
}

/**
 * Underclass settings. The URL must be a bare origin: the client appends
 * only its own fixed `/admin/api/...` routes, so a configured path could
 * only point those routes somewhere unintended. Plain HTTP is accepted on
 * loopback only, so the bearer token never crosses a network unencrypted.
 * @param source Environment to read.
 */
export function resolveUnderclass(source: NodeJS.ProcessEnv): {
	underclass?: UnderclassSettings;
	error?: ServerEnv['underclass_error'];
} {
	const raw = source.BDX_UNDERCLASS_URL?.trim() ?? '';
	const ui_token_file = source.BDX_UNDERCLASS_UI_TOKEN_FILE?.trim() ?? '';
	if (raw === '' && ui_token_file === '') return {};
	if (raw === '') return { error: 'url_missing' };
	const url = parseWebhookUrl(raw);
	if (url === undefined || new URL(url).pathname !== '/') return { error: 'url_invalid' };
	if (ui_token_file === '') return { error: 'token_file_missing' };
	return { underclass: { origin: new URL(url).origin, ui_token_file } };
}

/**
 * The First Mate runner: a URL and a shared secret
 * (`BDX_MATE_RUNNER_SECRET_FILE`, or `BDX_MATE_RUNNER_SECRET` for development).
 * Neither set means First Mate is not connected, which is not an error.
 * @param source Environment to read.
 */
function resolveMateRunner(source: NodeJS.ProcessEnv): {
	url?: string;
	error?: ServerEnv['mate_runner_error'];
} {
	const raw = source.BDX_MATE_RUNNER_URL?.trim() ?? '';
	const has_secret =
		(source.BDX_MATE_RUNNER_SECRET_FILE?.trim() ?? '') !== '' ||
		(source.BDX_MATE_RUNNER_SECRET?.trim() ?? '') !== '';
	if (raw === '') {
		return {};
	}
	const url = parseWebhookUrl(raw);
	if (url === undefined) return { error: 'url_invalid' };
	if (!has_secret) return { error: 'secret_missing' };
	return { url };
}

/** Every First Mate chat runner: the HTTP one above, and E2B sandboxes. */
function resolveMateRunners(
	source: NodeJS.ProcessEnv,
	state_dir: string
): {
	runners: MateRunnerId[];
	url?: string;
	error?: ServerEnv['mate_runner_error'];
	labels: Record<MateRunnerId, string>;
	e2b?: E2bMateSettings;
} {
	const remote = resolveMateRunner(source);
	const requested = splitList(source.BDX_MATE_RUNNERS?.toLowerCase());
	const labels: Record<MateRunnerId, string> = {
		remote: parseLabel(source.BDX_MATE_RUNNER_LABEL, 'Mate runner'),
		e2b: parseLabel(source.BDX_E2B_LABEL, DEFAULT_PROVIDER_LABELS.e2b)
	};
	const result: ReturnType<typeof resolveMateRunners> = {
		runners: [],
		url: remote.url,
		error: remote.error,
		labels
	};
	for (const entry of requested.length > 0 ? requested : ['remote']) {
		if (!(MATE_RUNNER_IDS as readonly string[]).includes(entry)) {
			result.error ??= 'invalid';
			continue;
		}
		const id = entry as MateRunnerId;
		if (id === 'remote') {
			if (remote.url === undefined) continue;
		} else {
			const base = parseE2bBaseSettings(source);
			if (base === undefined) {
				result.error ??= 'e2b_config_missing';
				continue;
			}
			result.e2b = {
				...base,
				idle_minutes: Math.min(parsePositiveInt(source.BDX_E2B_MATE_IDLE_MINUTES, 15), 60),
				max_sessions: Math.min(parsePositiveInt(source.BDX_E2B_MATE_MAX_SESSIONS, 3), 20),
				state_dir: `${state_dir}/sand-mate`
			};
		}
		if (!result.runners.includes(id)) result.runners.push(id);
	}
	return result;
}

/** Default display names; operators rename them with the `*_LABEL` vars. */
export const DEFAULT_PROVIDER_LABELS: Record<DispatchProviderId, string> = {
	webhook: 'Webhook agent runner',
	e2b: 'Sand'
};
const LABEL_PATTERN = /^[\p{L}\p{N} ._()-]{1,40}$/u;

function parseLabel(raw: string | undefined, fallback: string): string {
	const text = raw?.trim() ?? '';
	return LABEL_PATTERN.test(text) ? text : fallback;
}

/**
 * E2B sandbox settings (docs/sand-e2b.md). Every secret is a file path the
 * provider reads at use; none is copied into the sandbox.
 */
export interface E2bSettings extends E2bBaseSettings {
	/** `BDX_E2B_DOLT_ACCOUNTS_FILE`: JSON `{ "<database>": { "user", "password" } }`. */
	dolt_accounts_file: string;
	/** `BDX_E2B_DOLT_TAILNET_HOST` / `_PORT`: Dolt as the sandbox reaches it over the tailnet. */
	dolt_tailnet_host: string;
	dolt_tailnet_port: number;
	/** `BDX_E2B_TAILSCALE_OAUTH_CLIENT_ID` / `_SECRET_FILE`: mints one ephemeral key per run. */
	tailscale_client_id: string;
	tailscale_client_secret_file: string;
	/** `BDX_E2B_TAILSCALE_TAGS`: tags the sandbox node joins with. */
	tailscale_tags: string[];
	/** `BDX_E2B_GITHUB_APP_ID` / `_PRIVATE_KEY_FILE`: per-repository tokens. Unset: no checkouts. */
	github_app_id?: string;
	github_app_private_key_file?: string;
	/** `BDX_E2B_MAX_RUN_MINUTES`: sandbox time limit while a run works. */
	max_run_minutes: number;
	/** `BDX_E2B_IDLE_MINUTES`: how long a finished sandbox waits for a follow-up before pausing. */
	idle_minutes: number;
}

const TAILSCALE_TAG_PATTERN = /^tag:[a-z0-9-]{1,64}$/;
const GITHUB_APP_ID_PATTERN = /^[0-9]{1,12}$/;

function nonEmpty(raw: string | undefined): string | undefined {
	const text = raw?.trim() ?? '';
	return text === '' ? undefined : text;
}

/**
 * The settings every E2B use needs (dispatch and First Mate): the E2B key,
 * the template, and one model credential. Undefined when one is missing.
 */
export function parseE2bBaseSettings(source: NodeJS.ProcessEnv): E2bBaseSettings | undefined {
	const api_key_file = nonEmpty(source.BDX_E2B_API_KEY_FILE);
	const anthropic_api_key_file = nonEmpty(source.BDX_E2B_ANTHROPIC_API_KEY_FILE);
	const claude_oauth_token_file = nonEmpty(source.BDX_E2B_CLAUDE_OAUTH_TOKEN_FILE);
	if (api_key_file === undefined) return undefined;
	if (anthropic_api_key_file === undefined && claude_oauth_token_file === undefined)
		return undefined;
	const allow_out = splitList(source.BDX_E2B_ALLOW_OUT);
	return {
		api_key_file,
		template: nonEmpty(source.BDX_E2B_TEMPLATE) ?? 'beadsmith-agent',
		// The API key wins when both are set.
		...(anthropic_api_key_file === undefined
			? { claude_oauth_token_file }
			: { anthropic_api_key_file }),
		allow_out: allow_out.length > 0 ? allow_out : undefined
	};
}

/** Parse the E2B dispatch settings, or undefined when a required one is missing or invalid. */
export function parseE2bSettings(source: NodeJS.ProcessEnv): E2bSettings | undefined {
	const base = parseE2bBaseSettings(source);
	const dolt_accounts_file = nonEmpty(source.BDX_E2B_DOLT_ACCOUNTS_FILE);
	const tailscale_client_id = nonEmpty(source.BDX_E2B_TAILSCALE_OAUTH_CLIENT_ID);
	const tailscale_client_secret_file = nonEmpty(source.BDX_E2B_TAILSCALE_OAUTH_CLIENT_SECRET_FILE);
	if (
		base === undefined ||
		dolt_accounts_file === undefined ||
		tailscale_client_id === undefined ||
		tailscale_client_secret_file === undefined
	) {
		return undefined;
	}
	const tailscale_tags = splitList(source.BDX_E2B_TAILSCALE_TAGS);
	const tags = tailscale_tags.length > 0 ? tailscale_tags : ['tag:beads-sandbox'];
	if (!tags.every((tag) => TAILSCALE_TAG_PATTERN.test(tag))) return undefined;
	const github_app_id = nonEmpty(source.BDX_E2B_GITHUB_APP_ID);
	const github_app_private_key_file = nonEmpty(source.BDX_E2B_GITHUB_APP_PRIVATE_KEY_FILE);
	if ((github_app_id === undefined) !== (github_app_private_key_file === undefined)) {
		return undefined;
	}
	if (github_app_id !== undefined && !GITHUB_APP_ID_PATTERN.test(github_app_id)) return undefined;
	return {
		...base,
		dolt_accounts_file,
		dolt_tailnet_host: nonEmpty(source.BDX_E2B_DOLT_TAILNET_HOST) ?? 'beads',
		dolt_tailnet_port: parsePositiveInt(source.BDX_E2B_DOLT_TAILNET_PORT, DEFAULT_DOLT_PORT),
		tailscale_client_id,
		tailscale_client_secret_file,
		tailscale_tags: tags,
		github_app_id,
		github_app_private_key_file,
		// E2B caps a sandbox at 1 h on Hobby and 24 h on Pro.
		max_run_minutes: Math.min(parsePositiveInt(source.BDX_E2B_MAX_RUN_MINUTES, 55), 24 * 60),
		idle_minutes: Math.min(parsePositiveInt(source.BDX_E2B_IDLE_MINUTES, 10), 60)
	};
}

interface ResolvedDispatch {
	providers: DispatchProviderId[];
	error?: DispatchProviderError;
	webhook_url?: string;
	labels: Record<DispatchProviderId, string>;
	e2b?: E2bSettings;
}

function resolveDispatchProvider(source: NodeJS.ProcessEnv): ResolvedDispatch {
	const requested = splitList(source.BDX_DISPATCH_PROVIDER?.toLowerCase());
	const webhook_url = parseWebhookUrl(source.BDX_DISPATCH_WEBHOOK_URL);
	const labels: Record<DispatchProviderId, string> = {
		webhook: parseLabel(source.BDX_DISPATCH_WEBHOOK_LABEL, DEFAULT_PROVIDER_LABELS.webhook),
		e2b: parseLabel(source.BDX_E2B_LABEL, DEFAULT_PROVIDER_LABELS.e2b)
	};
	const resolved: ResolvedDispatch = { providers: [], webhook_url, labels };
	const fail = (error: DispatchProviderError) => {
		resolved.error ??= error;
	};
	for (const entry of requested) {
		if (entry === 'none') continue;
		if (entry === 'webhook') {
			if (webhook_url === undefined) {
				fail('webhook_url_invalid');
				continue;
			}
			const has_secret =
				(source.BDX_DISPATCH_WEBHOOK_SECRET_FILE?.trim() ?? '') !== '' ||
				(source.BDX_DISPATCH_WEBHOOK_SECRET?.trim() ?? '') !== '';
			if (!has_secret) {
				fail('webhook_secret_missing');
				continue;
			}
		} else if (entry === 'e2b') {
			const e2b = parseE2bSettings(source);
			if (e2b === undefined) {
				fail('e2b_config_missing');
				continue;
			}
			resolved.e2b = e2b;
		} else {
			fail('invalid');
			continue;
		}
		if (!resolved.providers.includes(entry)) resolved.providers.push(entry);
	}
	return resolved;
}

/** A comma list of launch choices, de-duplicated, keeping only well-formed entries. */
function parseChoices(raw: string | undefined, pattern: RegExp): string[] {
	return [...new Set(splitList(raw).filter((entry) => pattern.test(entry)))];
}

/** Client-safe configuration class for the console. Never names an env var. */
export type ConfigClass =
	'ok' | 'dolt_unconfigured' | 'incomplete' | 'invalid_service_token_id' | 'public_origin_error';

/**
 * Split a comma separated env value into trimmed, non-empty entries.
 * @param raw Raw env value.
 */
function splitList(raw: string | undefined): string[] {
	if (raw === undefined) {
		return [];
	}
	return raw
		.split(',')
		.map((entry) => {
			return entry.trim();
		})
		.filter((entry) => {
			return entry.length > 0;
		});
}

/**
 * Normalize a Cloudflare Access service-token Client ID. These are identifiers
 * in `BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS` and JWT `common_name`, never the
 * Client secret. Fail closed on emails, URLs, whitespace, and short junk.
 */
export function normalizeServiceTokenId(raw: string): string | undefined {
	const value = raw.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value)) {
		return undefined;
	}
	return value;
}

/** True when a verified service-token Client ID is on the configured allowlist. */
export function isAllowedCloudflareAccessServiceToken(
	client_id: string | undefined,
	allowed_ids: string[]
): boolean {
	if (client_id === undefined || allowed_ids.length === 0) {
		return false;
	}
	const normalized = normalizeServiceTokenId(client_id);
	return normalized !== undefined && allowed_ids.includes(normalized);
}

/**
 * Parse the operator-configured `BDX_PUBLIC_ORIGIN`: the public
 * `scheme://host` seen by the browser for the one hostname reached through a
 * TLS-terminating proxy (Cloudflare Tunnel). Only an exact origin — no path,
 * query, fragment, or credentials — is accepted; anything else returns
 * `undefined` so the caller fails closed instead of guessing at a partial
 * parse.
 * @param raw Raw `BDX_PUBLIC_ORIGIN` value.
 */
function parsePublicOrigin(raw: string): { hostname: string; origin: string } | undefined {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return undefined;
	}
	if (url.username !== '' || url.password !== '') {
		return undefined;
	}
	if (url.pathname !== '/' && url.pathname !== '') {
		return undefined;
	}
	if (url.search !== '' || url.hash !== '') {
		return undefined;
	}
	const hostname = url.hostname.toLowerCase();
	if (hostname.length === 0) {
		return undefined;
	}
	return { hostname, origin: url.origin };
}

/**
 * Parsed Cloudflare Access issuer host for operator display. Rejects JWKS
 * URLs and anything that is not a Cloudflare One `https://*.cloudflareaccess.com` origin.
 * @param raw Raw `BDX_CF_ACCESS_ISSUER` value.
 */
function accessIssuerHost(raw: string | undefined): string | undefined {
	if (raw === undefined || raw.length === 0) {
		return undefined;
	}
	const origin = normalizeCloudflareAccessIssuer(raw);
	if (origin === undefined) {
		return undefined;
	}
	return new URL(origin).hostname;
}

/**
 * Parse a positive integer env value, falling back when absent or invalid.
 * @param raw Raw env value.
 * @param fallback Value used when parsing fails.
 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}
	return parsed;
}

/**
 * Read and normalise the server environment.
 * @param source Environment to read (injectable for tests).
 */
export function readEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
	const dolt_host_raw = source.BEADS_DOLT_SERVER_HOST;
	const dolt_host =
		dolt_host_raw !== undefined && dolt_host_raw.trim().length > 0
			? dolt_host_raw.trim()
			: undefined;
	const agent_actors = splitList(source.BDX_AGENT_ACTORS);
	const cloudflare_issuer_raw = source.BDX_CF_ACCESS_ISSUER?.trim();
	const cloudflare_audience_raw = source.BDX_CF_ACCESS_AUDIENCE?.trim();
	const cloudflare_service_token_raw = splitList(source.BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS);
	const cloudflare_allowed_service_token_ids =
		cloudflare_service_token_raw.map(normalizeServiceTokenId);
	const cloudflare_display_service_token_ids = [
		...new Set(cloudflare_allowed_service_token_ids.filter((id): id is string => id !== undefined))
	];
	const cloudflare_access_issuer_host = accessIssuerHost(cloudflare_issuer_raw);

	const cloudflare_access_configured =
		cloudflare_issuer_raw !== undefined && cloudflare_issuer_raw.length > 0;
	const cloudflare_audience_configured =
		cloudflare_audience_raw !== undefined && cloudflare_audience_raw.length > 0;
	const cloudflare_service_tokens_configured = cloudflare_service_token_raw.length > 0;
	const cloudflare_service_tokens_valid = cloudflare_allowed_service_token_ids.every(
		(id): id is string => id !== undefined
	);
	const cloudflare_access_complete =
		cloudflare_access_configured &&
		cloudflare_audience_configured &&
		cloudflare_service_tokens_valid;
	const allowed_hosts = splitList(source.BDX_ALLOWED_HOSTS).map((entry) => {
		return entry.toLowerCase();
	});

	const public_origin_raw = source.BDX_PUBLIC_ORIGIN?.trim();
	const public_origin_configured = public_origin_raw !== undefined && public_origin_raw.length > 0;
	const parsed_public_origin = public_origin_configured
		? parsePublicOrigin(public_origin_raw)
		: undefined;
	const public_origin_malformed = public_origin_configured && parsed_public_origin === undefined;
	const public_origin_host_allowed =
		parsed_public_origin === undefined || allowed_hosts.includes(parsed_public_origin.hostname);

	const tackle_repositories = loadTackleRepositoriesFromEnv(source);
	const dispatch = resolveDispatchProvider(source);
	const mate_runner = resolveMateRunners(source, resolveStateDir(source));
	const underclass = resolveUnderclass(source);

	return {
		dolt_host,
		dolt_port: parsePositiveInt(source.BEADS_DOLT_SERVER_PORT, DEFAULT_DOLT_PORT),
		dolt_user:
			source.BEADS_DOLT_SERVER_USER !== undefined && source.BEADS_DOLT_SERVER_USER.length > 0
				? source.BEADS_DOLT_SERVER_USER
				: DEFAULT_DOLT_USER,
		dolt_configured: dolt_host !== undefined,
		cloudflare_access: cloudflare_access_complete
			? {
					issuer: cloudflare_issuer_raw,
					audience: cloudflare_audience_raw,
					allowed_service_token_ids: cloudflare_display_service_token_ids
				}
			: undefined,
		cloudflare_access_issuer_host,
		cloudflare_access_audience_configured: cloudflare_audience_configured,
		cloudflare_access_service_token_ids: cloudflare_display_service_token_ids,
		cloudflare_access_error: !cloudflare_service_tokens_valid
			? 'invalid_service_token_id'
			: !cloudflare_access_complete &&
				  (cloudflare_access_configured ||
						cloudflare_audience_configured ||
						cloudflare_service_tokens_configured)
				? 'incomplete'
				: undefined,
		public_origin: parsed_public_origin,
		public_origin_error: public_origin_malformed
			? 'invalid'
			: parsed_public_origin !== undefined && !public_origin_host_allowed
				? 'host_not_allowed'
				: undefined,
		allowed_hosts,
		state_dir: resolveStateDir(source),
		secret_key_file:
			source.BDX_SECRET_KEY_FILE !== undefined && source.BDX_SECRET_KEY_FILE.trim().length > 0
				? source.BDX_SECRET_KEY_FILE.trim()
				: undefined,
		agent_actors: agent_actors.length > 0 ? agent_actors : ['agent'],
		dispatch_provider: dispatch.providers[0] ?? 'none',
		dispatch_providers: dispatch.providers,
		dispatch_labels: dispatch.labels,
		dispatch_provider_error: dispatch.error,
		dispatch_webhook_url: dispatch.webhook_url,
		dispatch_e2b: dispatch.e2b,
		tackle_repositories: tackle_repositories.mappings,
		tackle_repositories_error: tackle_repositories.error,
		mate_runner_url: mate_runner.url,
		mate_runner_error: mate_runner.error,
		mate_runners: mate_runner.runners,
		mate_labels: mate_runner.labels,
		mate_e2b: mate_runner.e2b,
		crew_launch_limit: {
			count: parsePositiveInt(source.BDX_CREW_LAUNCH_LIMIT, 10),
			window_minutes: parsePositiveInt(source.BDX_CREW_LAUNCH_WINDOW_MINUTES, 10)
		},
		agent_models: parseChoices(source.BDX_AGENT_MODELS, MODEL_PATTERN),
		agent_efforts: parseChoices(source.BDX_AGENT_EFFORTS, EFFORT_PATTERN),
		underclass: underclass.underclass,
		underclass_error: underclass.error
	};
}

/**
 * True for a loopback hostname or address (the health probe's peer and Host).
 * @param host Hostname without port, or a client address.
 */
export function isLoopbackHost(host: string): boolean {
	return LOOPBACK_HOSTNAMES.includes(host.toLowerCase());
}

/**
 * Map `checkConfig` onto a class the operator console may send to the browser.
 * @param env Server environment.
 */
export function configClass(env: ServerEnv): ConfigClass {
	if (!env.dolt_configured) {
		return 'dolt_unconfigured';
	}
	if (env.cloudflare_access_error !== undefined) {
		return env.cloudflare_access_error;
	}
	if (env.public_origin_error !== undefined) {
		return 'public_origin_error';
	}
	return 'ok';
}

/**
 * Configuration the server cannot run safely without. Any bind is fine:
 * every route needs a signed-in account (ADR-0011).
 * @param env Server environment.
 * @returns An error message for the server log, or undefined when usable.
 */
export function checkConfig(env: ServerEnv): string | undefined {
	if (!env.dolt_configured) {
		return 'remote service requires a configured Dolt server';
	}
	if (env.cloudflare_access_error === 'incomplete') {
		return 'Cloudflare Access issuer and audience must be configured together (and before a service-token allowlist)';
	}
	if (env.cloudflare_access_error === 'invalid_service_token_id') {
		return 'Cloudflare Access service-token allowlist is invalid';
	}
	if (env.public_origin_error === 'invalid') {
		return 'BDX_PUBLIC_ORIGIN must be an absolute http(s) origin with no path, query, or credentials';
	}
	if (env.public_origin_error === 'host_not_allowed') {
		return 'BDX_PUBLIC_ORIGIN hostname must be included in BDX_ALLOWED_HOSTS';
	}
	return undefined;
}

let cached_env: ServerEnv | undefined;

/** Cached read of `process.env`. */
export function getEnv(): ServerEnv {
	if (cached_env === undefined) {
		cached_env = readEnv(process.env);
	}
	return cached_env;
}

/** Drop the cached env (tests only). */
export function resetEnvCache(): void {
	cached_env = undefined;
}
