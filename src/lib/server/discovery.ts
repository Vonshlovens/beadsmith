import { getEnv } from './env.js';
import {
	DB_NAME_PATTERN,
	getDoltClient,
	toDoltConnectionError,
	type DoltClient
} from './dolt/client.js';
import type { DoltFailureKind, Project } from '$lib/types.js';
import { clearSchemaCache } from './dolt/schema.js';

/** Opaque URL id for a remote Dolt project. */
export const PROJECT_ID_PATTERN = /^d_[a-z0-9_]{1,64}$/;
export const DISCOVERY_TTL_MS = 30_000;

const DISCOVERY_FAILURE_MESSAGES: Record<DoltFailureKind, string> = {
	credential_unavailable:
		'Remote project discovery is unavailable because protected Dolt authentication is unavailable.',
	authentication_rejected:
		'Remote project discovery is unavailable because Dolt authentication was rejected.',
	unreachable: 'Remote project discovery is unavailable because the Dolt server cannot be reached.',
	unknown: 'Remote project discovery is unavailable because the Dolt connection failed.'
};
const UNCONFIGURED_DISCOVERY_MESSAGE =
	'Remote Dolt is not configured. Check the service connection configuration.';

/**
 * A safe, operator-actionable remote-project discovery failure.
 *
 * Do not attach driver errors: they can include connection strings or other
 * credential material that must never reach the browser.
 */
export class ProjectDiscoveryError extends Error {
	readonly failure_kind?: DoltFailureKind;

	constructor(failure_kind?: DoltFailureKind) {
		super(
			failure_kind === undefined
				? UNCONFIGURED_DISCOVERY_MESSAGE
				: DISCOVERY_FAILURE_MESSAGES[failure_kind]
		);
		this.name = 'ProjectDiscoveryError';
		this.failure_kind = failure_kind;
	}
}

/**
 * Stable id for a remote Dolt database.
 * @param database Dolt database name.
 */
export function serverProjectId(database: string): string {
	return `d_${database}`;
}

/**
 * True when a name is valid for a user Dolt database.
 *
 * Kept as a narrow public helper while callers migrate away from the retired
 * workspace-link API.
 */
export function isValidDatabaseName(database: string): boolean {
	return DB_NAME_PATTERN.test(database);
}

/**
 * Turn server database names into the application's sole project model.
 * Every project is remote and read-only: an agent operating in the real
 * workspace owns all `bd` lifecycle operations.
 * @param databases User database names returned by Dolt.
 */
export function remoteProjects(databases: string[]): Project[] {
	return databases
		.filter((database) => {
			return DB_NAME_PATTERN.test(database);
		})
		.sort((a, b) => {
			return a.localeCompare(b);
		})
		.map((database) => {
			return {
				id: serverProjectId(database),
				name: database,
				state: 'remote',
				dolt_database: database,
				backend: 'server-sql',
				readonly: true
			};
		});
}

interface DiscoveryCache {
	projects: Project[];
	fetched_at: number;
}

let cache: DiscoveryCache | undefined;

export interface DiscoveryDeps {
	/** Injectable for tests; production reads the process environment. */
	configured?: boolean;
	/** Injectable read-only Dolt client. */
	dolt?: DoltClient;
	/** Injectable clock for cache tests. */
	now?: () => number;
}

/**
 * Enrich remote projects with best-effort counts and activity.
 *
 * Listing a project needs a working authenticated connection, but a query for
 * one individual project's optional summary should not hide every other
 * project from the operator.
 */
async function enrichWithSql(projects: Project[], client: DoltClient): Promise<void> {
	await Promise.all(
		projects.map(async (project) => {
			try {
				const [counts, last_activity] = await Promise.all([
					client.issueCounts(project.dolt_database),
					client.lastActivity(project.dolt_database)
				]);
				project.counts = counts;
				project.last_activity = last_activity;
			} catch {
				/* A partially readable project remains useful in the browse list. */
			}
		})
	);
}

/**
 * Discover remote Dolt projects. There is intentionally no local workspace
 * registry, filesystem scan, or `bd` fallback in this process.
 * @param options `force` bypasses the freshness window.
 * @param deps Injectable dependencies for tests.
 */
export async function discoverProjects(
	options: { force?: boolean } = {},
	deps: DiscoveryDeps = {}
): Promise<Project[]> {
	const now = deps.now ?? Date.now;
	const current = now();
	if (
		options.force !== true &&
		cache !== undefined &&
		current - cache.fetched_at < DISCOVERY_TTL_MS
	) {
		return cache.projects;
	}

	const configured = deps.configured ?? getEnv().dolt_configured;
	if (!configured) {
		throw new ProjectDiscoveryError();
	}

	const client = deps.dolt ?? getDoltClient();
	let databases: string[];
	try {
		databases = await client.listDatabases();
	} catch (error) {
		const connection_error = toDoltConnectionError(error);
		throw new ProjectDiscoveryError(connection_error.kind);
	}

	const projects = remoteProjects(databases);
	await enrichWithSql(projects, client);
	cache = { projects, fetched_at: now() };
	return projects;
}

/** Drop the in-memory discovery cache. */
export function invalidateDiscovery(): void {
	cache = undefined;
	clearSchemaCache();
}

/**
 * Look up one remote project by its opaque id.
 * @param id Project id.
 */
export async function resolveProject(id: string): Promise<Project | undefined> {
	if (!PROJECT_ID_PATTERN.test(id)) {
		return undefined;
	}
	const projects = await discoverProjects();
	const found = projects.find((project) => {
		return project.id === id;
	});
	if (found !== undefined) {
		return found;
	}
	return discoverProjects({ force: true }).then((fresh) => {
		return fresh.find((project) => {
			return project.id === id;
		});
	});
}
