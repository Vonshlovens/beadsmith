import type { Client } from '@libsql/client';
import type { ConsoleTackleMapSource } from '$lib/types.js';
import type { TackleRepositoryConfig, TackleRepositoryMapping } from './repositories.js';

/**
 * Service-local Tackle maps written from the operator console.
 *
 * Env/file maps remain the override. This store never holds passwords, API
 * keys, or Git credentials — only a public GitHub URL, ref, and PR flag.
 */
export interface TackleMapStore {
	list(): Promise<Record<string, TackleRepositoryMapping>>;
	get(project_id: string): Promise<TackleRepositoryMapping | undefined>;
	put(project_id: string, mapping: TackleRepositoryMapping): Promise<void>;
	delete(project_id: string): Promise<boolean>;
}

export interface EffectiveTackleMaps {
	invalid: boolean;
	mappings: Record<string, TackleRepositoryMapping>;
	sources: Record<string, ConsoleTackleMapSource>;
}

export const ENV_LOCKED_TACKLE_MAP_MESSAGE =
	"This project's Tackle map is set in service configuration and cannot be changed here.";
export const INVALID_CONSOLE_TACKLE_MAP_MESSAGE = 'Invalid Tackle repository mapping.';

/**
 * Merge env/file maps over SQLite maps. An unusable env/file config fails
 * closed for the whole catalog (SQLite rows stay stored, but are not used).
 * @param env Parsed env/file config.
 * @param sqlite Console-persisted maps.
 */
export function mergeTackleMaps(
	env: TackleRepositoryConfig,
	sqlite: Record<string, TackleRepositoryMapping>
): EffectiveTackleMaps {
	if (env.error === 'invalid') {
		return { invalid: true, mappings: {}, sources: {} };
	}

	const mappings: Record<string, TackleRepositoryMapping> = { ...sqlite };
	const sources: Record<string, ConsoleTackleMapSource> = {};
	for (const project_id of Object.keys(sqlite)) {
		sources[project_id] = 'sqlite';
	}
	for (const [project_id, mapping] of Object.entries(env.mappings)) {
		mappings[project_id] = mapping;
		sources[project_id] = 'env';
	}
	return { invalid: false, mappings, sources };
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

function rowToMapping(row: Record<string, unknown>): TackleRepositoryMapping | undefined {
	const url = asText(row.url);
	const ref = asText(row.ref);
	const auto_create_pr = asBool(row.auto_create_pr);
	if (url === undefined || ref === undefined || auto_create_pr === undefined) {
		return undefined;
	}
	return { url, ref, auto_create_pr };
}

/** Build a Tackle-map store over an already-initialised libsql client. */
export function createTackleMapStore(client: Client): TackleMapStore {
	return {
		async list(): Promise<Record<string, TackleRepositoryMapping>> {
			const result = await client.execute(
				'SELECT project_id, url, ref, auto_create_pr FROM tackle_repository_maps'
			);
			const mappings: Record<string, TackleRepositoryMapping> = {};
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

		async get(project_id: string): Promise<TackleRepositoryMapping | undefined> {
			const result = await client.execute({
				sql: 'SELECT url, ref, auto_create_pr FROM tackle_repository_maps WHERE project_id = ?',
				args: [project_id]
			});
			const row = result.rows[0] as Record<string, unknown> | undefined;
			return row === undefined ? undefined : rowToMapping(row);
		},

		async put(project_id: string, mapping: TackleRepositoryMapping): Promise<void> {
			await client.execute({
				sql: `INSERT INTO tackle_repository_maps (project_id, url, ref, auto_create_pr, updated_at)
					VALUES (?, ?, ?, ?, ?)
					ON CONFLICT(project_id) DO UPDATE SET
						url = excluded.url,
						ref = excluded.ref,
						auto_create_pr = excluded.auto_create_pr,
						updated_at = excluded.updated_at`,
				args: [
					project_id,
					mapping.url,
					mapping.ref,
					mapping.auto_create_pr ? 1 : 0,
					new Date().toISOString()
				]
			});
		},

		async delete(project_id: string): Promise<boolean> {
			const result = await client.execute({
				sql: 'DELETE FROM tackle_repository_maps WHERE project_id = ?',
				args: [project_id]
			});
			return result.rowsAffected > 0;
		}
	};
}
