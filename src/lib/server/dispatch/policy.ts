import type { Client } from '@libsql/client';
import type { DiscussIntent, DispatchOperation, DispatchProjectAllow } from '$lib/types.js';

/**
 * Service-local File/Tackle policy: a global arm switch and per-project allow.
 *
 * Stored in SQLite, never in Beads Dolt, and never accepted from a File/Tackle
 * POST body. Missing rows default to armed + both operations allowed so
 * existing deployments keep working until an operator tightens them.
 */
export const DISPATCH_ARMED_SETTING_KEY = 'dispatch.armed';

export const DEFAULT_DISPATCH_ALLOW: DispatchProjectAllow = { file: true, tackle: true };

export const DISARMED_DISPATCH_MESSAGE = 'Agent dispatch is disarmed.';
export const FILE_NOT_ALLOWED_MESSAGE = 'File is not allowed for this project.';
export const TACKLE_NOT_ALLOWED_MESSAGE = 'Tackle is not allowed for this project.';
export const COMMENT_NOT_ALLOWED_MESSAGE = 'Comment is not allowed for this project.';
export const DISCUSS_NOT_ALLOWED_MESSAGE = 'Agent discussion is not allowed for this project.';
export const ELABORATE_NOT_ALLOWED_MESSAGE =
	'Elaborate changes the issue, so it needs Tackle allowed for this project.';
export const CLOSE_NOT_ALLOWED_MESSAGE =
	'Close changes the issue, so it needs Tackle allowed for this project.';

export interface DispatchPolicy {
	armed: boolean;
	allow: DispatchProjectAllow;
}

export interface DispatchPolicyStore {
	getArmed(): Promise<boolean>;
	setArmed(armed: boolean): Promise<void>;
	getAllow(project_id: string): Promise<DispatchProjectAllow>;
	listAllows(): Promise<Record<string, DispatchProjectAllow>>;
	putAllow(project_id: string, allow: DispatchProjectAllow): Promise<void>;
}

function asText(value: unknown): string | undefined {
	if (typeof value === 'string' && value.length > 0) {
		return value;
	}
	return undefined;
}

function asBool(value: unknown): boolean | undefined {
	if (value === true || value === 1 || value === '1') {
		return true;
	}
	if (value === false || value === 0 || value === '0') {
		return false;
	}
	return undefined;
}

function parseArmed(value: string | undefined): boolean {
	if (value === undefined) {
		return true;
	}
	return value !== '0' && value !== 'false';
}

function rowToAllow(row: Record<string, unknown>): DispatchProjectAllow | undefined {
	const file = asBool(row.file_allowed);
	const tackle = asBool(row.tackle_allowed);
	if (file === undefined || tackle === undefined) {
		return undefined;
	}
	return { file, tackle };
}

/** Build a dispatch-policy store over an already-initialised libsql client. */
export function createDispatchPolicyStore(client: Client): DispatchPolicyStore {
	return {
		async getArmed(): Promise<boolean> {
			const result = await client.execute({
				sql: 'SELECT value FROM settings WHERE key = ?',
				args: [DISPATCH_ARMED_SETTING_KEY]
			});
			const row = result.rows[0] as Record<string, unknown> | undefined;
			return parseArmed(row === undefined ? undefined : asText(row.value));
		},

		async setArmed(armed: boolean): Promise<void> {
			await client.execute({
				sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
				args: [DISPATCH_ARMED_SETTING_KEY, armed ? '1' : '0']
			});
		},

		async getAllow(project_id: string): Promise<DispatchProjectAllow> {
			const result = await client.execute({
				sql: 'SELECT file_allowed, tackle_allowed FROM dispatch_project_allows WHERE project_id = ?',
				args: [project_id]
			});
			const row = result.rows[0] as Record<string, unknown> | undefined;
			if (row === undefined) {
				return { ...DEFAULT_DISPATCH_ALLOW };
			}
			return rowToAllow(row) ?? { ...DEFAULT_DISPATCH_ALLOW };
		},

		async listAllows(): Promise<Record<string, DispatchProjectAllow>> {
			const result = await client.execute(
				'SELECT project_id, file_allowed, tackle_allowed FROM dispatch_project_allows'
			);
			const allows: Record<string, DispatchProjectAllow> = {};
			for (const raw of result.rows) {
				const row = raw as Record<string, unknown>;
				const project_id = asText(row.project_id);
				const allow = rowToAllow(row);
				if (project_id === undefined || allow === undefined) {
					continue;
				}
				allows[project_id] = allow;
			}
			return allows;
		},

		async putAllow(project_id: string, allow: DispatchProjectAllow): Promise<void> {
			await client.execute({
				sql: `INSERT INTO dispatch_project_allows (project_id, file_allowed, tackle_allowed, updated_at)
					VALUES (?, ?, ?, ?)
					ON CONFLICT(project_id) DO UPDATE SET
						file_allowed = excluded.file_allowed,
						tackle_allowed = excluded.tackle_allowed,
						updated_at = excluded.updated_at`,
				args: [project_id, allow.file ? 1 : 0, allow.tackle ? 1 : 0, new Date().toISOString()]
			});
		}
	};
}

/** Effective public `dispatch.enabled`: key present and globally armed. */
export function dispatchEnabled(key_configured: boolean, armed: boolean): boolean {
	return key_configured && armed;
}

/**
 * Whether this operation may proceed after the global arm check. Comment and
 * a plain discussion only talk, so either allow admits them; elaborate and
 * close change the issue the way Tackle does, so they need Tackle.
 *
 * @param allow - The project's allow row.
 * @param operation - Requested operation.
 * @param intent - Discuss intent; ignored for other operations.
 */
export function operationAllowed(
	allow: DispatchProjectAllow,
	operation: DispatchOperation,
	intent?: DiscussIntent
): boolean {
	if (operation === 'file') {
		return allow.file;
	}
	if (operation === 'tackle') {
		return allow.tackle;
	}
	if (operation === 'discuss' && (intent === 'elaborate' || intent === 'close')) {
		return allow.tackle;
	}
	return allow.file || allow.tackle;
}

/** Sanitized refusal for a denied File/Tackle/comment/discuss operation. */
export function deniedOperationMessage(
	operation: DispatchOperation,
	intent?: DiscussIntent
): string {
	if (operation === 'file') {
		return FILE_NOT_ALLOWED_MESSAGE;
	}
	if (operation === 'tackle') {
		return TACKLE_NOT_ALLOWED_MESSAGE;
	}
	if (operation === 'discuss') {
		if (intent === 'elaborate') {
			return ELABORATE_NOT_ALLOWED_MESSAGE;
		}
		if (intent === 'close') {
			return CLOSE_NOT_ALLOWED_MESSAGE;
		}
		return DISCUSS_NOT_ALLOWED_MESSAGE;
	}
	return COMMENT_NOT_ALLOWED_MESSAGE;
}
