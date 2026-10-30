/**
 * Webhook dispatch provider: launch agents on any runner
 * that implements this signed HTTP contract (docs/file-tackle-dispatch.md):
 *
 *   POST {base}/agents                          launch  -> { agent_id, run_id?, agent_url? }
 *   GET  {base}/agents/{id}/latest-run          -> { run_id }            (404 = none yet)
 *   GET  {base}/agents/{id}/runs/{run}          -> { status, summary?, duration_ms?, pr_url?, error? }
 *   POST {base}/agents/{id}/runs                follow-up { prompt } -> { run_id }   (optional)
 *   POST {base}/agents/{id}/runs/{run}/cancel   (optional)
 *
 * Every request carries `x-beadsmith-timestamp` (unix seconds) and
 * `x-beadsmith-signature: v1=<hex>`, an HMAC-SHA256 under the shared secret
 * of `<timestamp>.<METHOD> <path>\n<body>`, so a captured request cannot be
 * replayed against another endpoint. Runners should reject timestamps more
 * than five minutes old.
 */
import { readFileSync } from 'node:fs';
import { ISSUE_ID_PATTERN } from '../validation.js';
import { getEnv, type ServerEnv } from '../env.js';
import type {
	AgentFollowUpRun,
	AgentLaunch,
	AgentLaunchInput,
	AgentProvider,
	AgentRunUpdate
} from './provider.js';
import {
	asNonEmptyString,
	readDurationMs,
	readGithubPullUrl,
	sanitizeResultSummary
} from './sanitize.js';
import { DispatchError } from './types.js';

export const WEBHOOK_CONTRACT_VERSION = 1;
export const MIN_WEBHOOK_SECRET_LENGTH = 32;
const AGENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const REQUEST_TIMEOUT_MS = 15_000;
const RUN_STATUSES = new Set(['running', 'succeeded', 'cancelled', 'failed']);

export interface WebhookProviderDeps {
	server_env?: ServerEnv;
	fetch?: typeof fetch;
	now?: () => Date;
	/** Secret override for tests; production reads the env or file. */
	secret?: string;
}

/** Resolve the shared secret from `BDX_DISPATCH_WEBHOOK_SECRET_FILE` or the env fallback. */
export function resolveWebhookSecret(source: NodeJS.ProcessEnv = process.env): string {
	const file = source.BDX_DISPATCH_WEBHOOK_SECRET_FILE?.trim();
	let secret: string | undefined;
	if (file !== undefined && file.length > 0) {
		try {
			secret = readFileSync(file, 'utf8').trim();
		} catch {
			throw new DispatchError('unavailable', 'The webhook secret file could not be read.');
		}
	} else {
		secret = source.BDX_DISPATCH_WEBHOOK_SECRET?.trim();
	}
	if (secret === undefined || secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
		throw new DispatchError(
			'unavailable',
			`The webhook secret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters.`
		);
	}
	return secret;
}

/** Compute the `v1=` signature for one request. Exported for runner authors' tests. */
export async function signWebhookRequest(
	secret: string,
	timestamp: string,
	method: string,
	path: string,
	body: string
): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const mac = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(`${timestamp}.${method} ${path}\n${body}`)
	);
	return `v1=${Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function readIssueId(value: unknown): string | undefined {
	const text = asNonEmptyString(value);
	return text !== undefined && ISSUE_ID_PATTERN.test(text) ? text : undefined;
}

function agentId(value: unknown): string | undefined {
	const text = asNonEmptyString(value);
	return text !== undefined && AGENT_ID_PATTERN.test(text) ? text : undefined;
}

function requireId(value: string, what: string): string {
	if (!AGENT_ID_PATTERN.test(value)) throw new DispatchError('unavailable', `Invalid ${what}.`);
	return value;
}

function safeAgentUrl(value: unknown): string | undefined {
	const text = asNonEmptyString(value);
	if (text === undefined || text.length > 500) return undefined;
	try {
		const url = new URL(text);
		return url.protocol === 'https:' && url.username === '' && url.password === ''
			? url.toString()
			: undefined;
	} catch {
		return undefined;
	}
}

export function createWebhookProvider(deps: WebhookProviderDeps = {}): AgentProvider {
	const env = deps.server_env ?? getEnv();
	const fetch_impl = deps.fetch ?? fetch;
	const now = deps.now ?? (() => new Date());
	const base = env.dispatch_webhook_url;

	async function call(
		method: 'GET' | 'POST',
		path: string,
		body?: unknown
	): Promise<{ status: number; json: Record<string, unknown> }> {
		if (base === undefined) {
			throw new DispatchError('unavailable', 'The webhook runner URL is not configured.');
		}
		const secret = deps.secret ?? resolveWebhookSecret();
		const text = body === undefined ? '' : JSON.stringify(body);
		const timestamp = String(Math.floor(now().getTime() / 1000));
		const url = new URL(base);
		const full_path = `${url.pathname.replace(/\/$/, '')}${path}`;
		let response: Response;
		try {
			response = await fetch_impl(`${url.origin}${full_path}`, {
				method,
				headers: {
					accept: 'application/json',
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					'x-beadsmith-contract': String(WEBHOOK_CONTRACT_VERSION),
					'x-beadsmith-timestamp': timestamp,
					'x-beadsmith-signature': await signWebhookRequest(
						secret,
						timestamp,
						method,
						full_path,
						text
					)
				},
				body: body === undefined ? undefined : text,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
		} catch {
			throw new DispatchError('unavailable', 'The webhook runner could not be reached.');
		}
		let json: Record<string, unknown> = {};
		try {
			const parsed: unknown = await response.json();
			if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>;
		} catch {
			json = {};
		}
		return { status: response.status, json };
	}

	function refused(status: number, action: string): DispatchError {
		if (status === 404 || status === 405 || status === 501) {
			return new DispatchError('forbidden', `The webhook runner does not support ${action}.`);
		}
		return new DispatchError(
			'unavailable',
			`The webhook runner refused to ${action} (HTTP ${status}).`
		);
	}

	return {
		id: 'webhook',
		label: 'Webhook agent runner',

		async launch(input: AgentLaunchInput): Promise<AgentLaunch> {
			const { status, json } = await call('POST', '/agents', {
				version: WEBHOOK_CONTRACT_VERSION,
				name: input.name,
				prompt: input.prompt,
				auto_create_pr: input.auto_create_pr,
				...(input.repository === undefined ? {} : { repository: input.repository })
			});
			if (status < 200 || status >= 300) throw refused(status, 'launch an agent');
			const id = agentId(json.agent_id);
			if (id === undefined) {
				throw new DispatchError('unavailable', 'The webhook runner returned no valid agent_id.');
			}
			return {
				agent_id: id,
				run_id: agentId(json.run_id),
				agent_url: safeAgentUrl(json.agent_url)
			};
		},

		async getLatestRunId(agent_id: string): Promise<string | undefined> {
			const { status, json } = await call(
				'GET',
				`/agents/${encodeURIComponent(requireId(agent_id, 'agent id'))}/latest-run`
			);
			if (status === 404) return undefined;
			if (status < 200 || status >= 300) throw refused(status, 'report the latest run');
			return agentId(json.run_id);
		},

		async getRun(agent_id: string, run_id: string): Promise<AgentRunUpdate> {
			const { status, json } = await call(
				'GET',
				`/agents/${encodeURIComponent(requireId(agent_id, 'agent id'))}/runs/${encodeURIComponent(requireId(run_id, 'run id'))}`
			);
			if (status < 200 || status >= 300) throw refused(status, 'report run status');
			const run_status = typeof json.status === 'string' ? json.status : '';
			if (!RUN_STATUSES.has(run_status)) {
				throw new DispatchError(
					'unavailable',
					'The webhook runner returned an unknown run status.'
				);
			}
			// Redact the shared secret if a runner ever echoes it back.
			const secret = deps.secret ?? resolveWebhookSecret();
			const error = asNonEmptyString(json.error);
			return {
				status: run_status as AgentRunUpdate['status'],
				result_summary: sanitizeResultSummary(json.summary, secret),
				duration_ms: readDurationMs(json.duration_ms),
				git_pr_url: readGithubPullUrl(json.pr_url, secret),
				issue_id: readIssueId(json.issue_id),
				error_message:
					error === undefined
						? undefined
						: (sanitizeResultSummary(error, secret) ?? 'The agent run failed.')
			};
		},

		async createRun(agent_id: string, prompt: string): Promise<AgentFollowUpRun> {
			const { status, json } = await call(
				'POST',
				`/agents/${encodeURIComponent(requireId(agent_id, 'agent id'))}/runs`,
				{ version: WEBHOOK_CONTRACT_VERSION, prompt }
			);
			if (status < 200 || status >= 300) throw refused(status, 'follow-up');
			const run_id = agentId(json.run_id);
			if (run_id === undefined) {
				throw new DispatchError('unavailable', 'The webhook runner returned no valid run_id.');
			}
			return { run_id };
		},

		async cancelRun(agent_id: string, run_id: string): Promise<void> {
			const { status } = await call(
				'POST',
				`/agents/${encodeURIComponent(requireId(agent_id, 'agent id'))}/runs/${encodeURIComponent(requireId(run_id, 'run id'))}/cancel`
			);
			if (status < 200 || status >= 300) throw refused(status, 'cancel');
		}
	};
}
