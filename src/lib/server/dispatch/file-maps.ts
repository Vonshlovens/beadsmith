import type { Client } from '@libsql/client';
import { parseGitHubRepositoryUrl, parseGitRef } from './repositories.js';

/**
 * Optional per-project File checkout. Distinct from Tackle maps: no PR flag,
 * no env overlay. Missing row → no checkout; the runner uses its default.
 * Present-but-unusable row → fail closed (do not fall back).
 */
export interface FileCheckoutMapping {
	url: string;
	ref: string;
}

export type FileCheckoutRecord =
	{ kind: 'none' } | { kind: 'valid'; mapping: FileCheckoutMapping } | { kind: 'invalid' };

export interface FileMapStore {
	list(): Promise<Record<string, FileCheckoutMapping>>;
	inspect(project_id: string): Promise<FileCheckoutRecord>;
	put(project_id: string, mapping: FileCheckoutMapping): Promise<void>;
	delete(project_id: string): Promise<boolean>;
}

export const INVALID_FILE_CHECKOUT_MESSAGE =
	'File checkout mapping is unavailable. Check the service configuration.';
export const INVALID_CONSOLE_FILE_MAP_MESSAGE = 'Invalid File checkout mapping.';

function asText(value: unknown): string | undefined {
	if (typeof value === 'string' && value.length > 0) {
		return value;
	}
	return undefined;
}

function rowToMapping(row: Record<string, unknown>): FileCheckoutMapping | undefined {
	const raw_url = asText(row.url);
	const raw_ref = asText(row.ref);
	if (raw_url === undefined || raw_ref === undefined) {
		return undefined;
	}
	const url = parseGitHubRepositoryUrl(raw_url);
	const ref = parseGitRef(raw_ref);
	if (url === undefined || ref === undefined) {
		return undefined;
	}
	return { url, ref };
}

function recordFromRow(row: Record<string, unknown> | undefined): FileCheckoutRecord {
	if (row === undefined) {
		return { kind: 'none' };
	}
	const mapping = rowToMapping(row);
	if (mapping === undefined) {
		return { kind: 'invalid' };
	}
	return { kind: 'valid', mapping };
}

/** Build a File-checkout store over an already-initialised libsql client. */
export function createFileMapStore(client: Client): FileMapStore {
	return {
		async list(): Promise<Record<string, FileCheckoutMapping>> {
			const result = await client.execute('SELECT project_id, url, ref FROM file_checkout_maps');
			const mappings: Record<string, FileCheckoutMapping> = {};
			for (const raw of result.rows) {
				const row = raw as Record<string, unknown>;
				const project_id = asText(row.project_id);
				const mapping = rowToMapping(row);
				if (project_id === undefined || mapping === undefined) {
					continue;
				}
				mappings[project_id] = mapping;
			}
			return mappings;
		},

		async inspect(project_id: string): Promise<FileCheckoutRecord> {
			const result = await client.execute({
				sql: 'SELECT url, ref FROM file_checkout_maps WHERE project_id = ?',
				args: [project_id]
			});
			const row = result.rows[0] as Record<string, unknown> | undefined;
			return recordFromRow(row);
		},

		async put(project_id: string, mapping: FileCheckoutMapping): Promise<void> {
			await client.execute({
				sql: `INSERT INTO file_checkout_maps (project_id, url, ref, updated_at)
					VALUES (?, ?, ?, ?)
					ON CONFLICT(project_id) DO UPDATE SET
						url = excluded.url,
						ref = excluded.ref,
						updated_at = excluded.updated_at`,
				args: [project_id, mapping.url, mapping.ref, new Date().toISOString()]
			});
		},

		async delete(project_id: string): Promise<boolean> {
			const result = await client.execute({
				sql: 'DELETE FROM file_checkout_maps WHERE project_id = ?',
				args: [project_id]
			});
			return result.rowsAffected > 0;
		}
	};
}
