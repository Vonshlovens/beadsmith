import { discoverProjects } from './discovery.js';
import { configClass, getEnv, type ServerEnv } from './env.js';
import {
	loadTackleRepositoriesFromEnv,
	type TackleRepositoryConfig,
	type TackleRepositoryMapping
} from './dispatch/repositories.js';
import { DEFAULT_DISPATCH_ALLOW } from './dispatch/policy.js';
import { mergeTackleMaps } from './dispatch/tackle-maps.js';
import type { FileCheckoutMapping } from './dispatch/file-maps.js';
import { getDispatchPolicyStore, getFileMapStore, getTackleMapStore } from './state/db.js';
import { getStatus, type StatusDeps } from './status.js';
import type {
	ConsoleAccess,
	ConsoleProjectRow,
	ConsoleSnapshot,
	DispatchProjectAllow,
	Project,
	StatusSnapshot
} from '$lib/types.js';
import { getDoltClient } from './dolt/client.js';
import type { SchemaInfo } from './dolt/schema.js';

export interface ConsoleDeps {
	env?: ServerEnv;
	status?: StatusSnapshot;
	projects?: Project[];
	maps?: TackleRepositoryConfig;
	sqlite_maps?: Record<string, TackleRepositoryMapping>;
	file_maps?: Record<string, FileCheckoutMapping>;
	allows?: Record<string, DispatchProjectAllow>;
	map_env?: NodeJS.ProcessEnv;
	status_deps?: StatusDeps;
	/** Schema inspection; defaults to the live client only for live discovery. */
	schema?: (database: string) => Promise<SchemaInfo | undefined>;
}

async function loadSqliteMaps(deps: ConsoleDeps): Promise<Record<string, TackleRepositoryMapping>> {
	if (deps.sqlite_maps !== undefined) {
		return deps.sqlite_maps;
	}
	try {
		return await (await getTackleMapStore()).list();
	} catch {
		return {};
	}
}

async function loadFileMaps(deps: ConsoleDeps): Promise<Record<string, FileCheckoutMapping>> {
	if (deps.file_maps !== undefined) {
		return deps.file_maps;
	}
	try {
		return await (await getFileMapStore()).list();
	} catch {
		return {};
	}
}

async function loadAllows(deps: ConsoleDeps): Promise<Record<string, DispatchProjectAllow>> {
	if (deps.allows !== undefined) {
		return deps.allows;
	}
	try {
		return await (await getDispatchPolicyStore()).listAllows();
	} catch {
		return {};
	}
}

function projectAllow(
	project_id: string,
	allows: Record<string, DispatchProjectAllow>
): DispatchProjectAllow {
	return allows[project_id] ?? { ...DEFAULT_DISPATCH_ALLOW };
}

/**
 * Redact Access and origin config for the operator console.
 * Reads only `getEnv`/`readEnv` fields — no second parser, no mutation API.
 * @param env Server environment.
 */
export function redactedAccessFromEnv(env: ServerEnv): ConsoleAccess {
	return {
		...(env.cloudflare_access_issuer_host !== undefined
			? { issuer_host: env.cloudflare_access_issuer_host }
			: {}),
		audience_configured: env.cloudflare_access_audience_configured,
		service_token_ids: [...env.cloudflare_access_service_token_ids],
		allowed_hosts: [...env.allowed_hosts],
		...(env.public_origin !== undefined ? { public_origin: env.public_origin.origin } : {}),
		policy: configClass(env)
	};
}

/**
 * Build the redacted operator-console snapshot.
 *
 * Effective maps are SQLite rows overlaid by env/file. Health reuses the
 * public status classes — no host, port, user, password, key, or path.
 * @param deps Injectable discovery, maps, policy, and status for tests.
 */
export async function getConsoleSnapshot(deps: ConsoleDeps = {}): Promise<ConsoleSnapshot> {
	const env = deps.env ?? getEnv();
	const [status, projects, sqlite_maps, file_maps, allows] = await Promise.all([
		deps.status === undefined
			? getStatus({ env, ...deps.status_deps })
			: Promise.resolve(deps.status),
		deps.projects === undefined ? discoverProjects() : Promise.resolve(deps.projects),
		loadSqliteMaps(deps),
		loadFileMaps(deps),
		loadAllows(deps)
	]);
	const env_maps = deps.maps ?? loadTackleRepositoriesFromEnv(deps.map_env);
	const effective = mergeTackleMaps(env_maps, sqlite_maps);

	const rows: ConsoleProjectRow[] = projects.map((project) => {
		const mapping = effective.invalid ? undefined : effective.mappings[project.id];
		const file_mapping = file_maps[project.id];
		const allow = projectAllow(project.id, allows);
		const file =
			file_mapping === undefined
				? { mapped: false as const }
				: { mapped: true as const, url: file_mapping.url, ref: file_mapping.ref };
		if (mapping === undefined) {
			return {
				id: project.id,
				name: project.name,
				last_activity: project.last_activity,
				counts: project.counts,
				tackle: { mapped: false },
				file,
				allow
			};
		}
		return {
			id: project.id,
			name: project.name,
			last_activity: project.last_activity,
			counts: project.counts,
			tackle: {
				mapped: true,
				url: mapping.url,
				ref: mapping.ref,
				auto_create_pr: mapping.auto_create_pr,
				source: effective.sources[project.id] ?? 'sqlite'
			},
			file,
			allow
		};
	});

	const schema_of =
		deps.schema ??
		(deps.projects === undefined
			? (database: string) => getDoltClient().schema?.(database) ?? Promise.resolve(undefined)
			: undefined);
	if (schema_of !== undefined) {
		await Promise.all(
			rows.map(async (row, i) => {
				const database = projects[i].dolt_database;
				if (database === undefined) return;
				try {
					const info = await schema_of(database);
					if (info !== undefined) row.schema = info;
				} catch {
					// Health already reports connection problems; leave schema unknown.
				}
			})
		);
	}

	const unmapped_ids = rows
		.filter((row) => {
			return !row.tackle.mapped;
		})
		.map((row) => {
			return row.id;
		});

	return {
		health: {
			dolt: status.dolt,
			state_db: status.state_db,
			dispatch: status.dispatch
		},
		coverage: {
			project_count: rows.length,
			mapped_count: rows.length - unmapped_ids.length,
			unmapped_ids,
			maps_invalid: effective.invalid
		},
		projects: rows,
		access: redactedAccessFromEnv(env)
	};
}
