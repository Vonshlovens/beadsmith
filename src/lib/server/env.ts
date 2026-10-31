import type { DispatchProviderId } from '$lib/types.js';
import { normalizeCloudflareAccessIssuer } from './cloudflare-access.js';
import {
	loadTackleRepositoriesFromEnv,
	type TackleRepositoryMapping
} from './dispatch/repositories.js';
import { resolveStateDir } from './state/dir.js';

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
	 * Active agent dispatch provider. `BDX_DISPATCH_PROVIDER`
	 * selects it; unset means `none`.
	 */
	dispatch_provider: DispatchProviderId | 'none';
	/** Why the requested provider is not active; absent when it is. */
	dispatch_provider_error?: 'invalid' | 'webhook_url_invalid' | 'webhook_secret_missing';
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

function resolveDispatchProvider(source: NodeJS.ProcessEnv): {
	provider: ServerEnv['dispatch_provider'];
	error?: ServerEnv['dispatch_provider_error'];
	webhook_url?: string;
} {
	const requested = source.BDX_DISPATCH_PROVIDER?.trim().toLowerCase() ?? '';
	const webhook_url = parseWebhookUrl(source.BDX_DISPATCH_WEBHOOK_URL);
	if (requested === '' || requested === 'none') return { provider: 'none', webhook_url };
	if (requested === 'webhook') {
		if (webhook_url === undefined) return { provider: 'none', error: 'webhook_url_invalid' };
		const has_secret =
			(source.BDX_DISPATCH_WEBHOOK_SECRET_FILE?.trim() ?? '') !== '' ||
			(source.BDX_DISPATCH_WEBHOOK_SECRET?.trim() ?? '') !== '';
		return has_secret
			? { provider: 'webhook', webhook_url }
			: { provider: 'none', error: 'webhook_secret_missing', webhook_url };
	}
	return { provider: 'none', error: 'invalid', webhook_url };
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
		dispatch_provider: dispatch.provider,
		dispatch_provider_error: dispatch.error,
		dispatch_webhook_url: dispatch.webhook_url,
		tackle_repositories: tackle_repositories.mappings,
		tackle_repositories_error: tackle_repositories.error
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
