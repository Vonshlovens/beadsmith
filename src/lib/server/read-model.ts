import { getEnv } from './env.js';
import { getDoltClient, type DoltClient } from './dolt/client.js';
import { UnsupportedSchemaError } from './dolt/schema.js';
import type {
	ActivityEvent,
	IssueDetailResponse,
	IssueListResponse,
	Project,
	ReadyIssue,
	ReadyListResponse
} from '$lib/types.js';

/**
 * Read paths shared by the issue, detail, dependency, and activity endpoints.
 *
 * The web service has exactly one source of truth for reads: the configured
 * remote Dolt database. Agents use `bd` in their own workspace for mutations;
 * there is deliberately no local fallback here.
 */

export interface ReadDeps {
	dolt?: DoltClient;
	dolt_configured?: boolean;
}

export interface IssueFilters {
	limit: number;
	include_closed: boolean;
	status?: string;
	type?: string;
	priority?: string;
	q?: string;
	label?: string;
}

/**
 * Refuse reads of a project whose Beads schema lacks a column the read plane
 * needs, with a clear error instead of a broken page.
 * Inspection failures fall through to the read itself, which reports them.
 */
async function assertReadableSchema(dolt: DoltClient, database: string): Promise<void> {
	if (dolt.schema === undefined) return;
	let info;
	try {
		info = await dolt.schema(database);
	} catch {
		return;
	}
	if (info.status === 'unsupported') throw new UnsupportedSchemaError(database, info);
}

/** True when a remote project can be queried through the configured client. */
export function canUseSql(project: Project, configured: boolean): boolean {
	return configured && project.state === 'remote' && project.dolt_database !== undefined;
}

/**
 * List issues from the remote Dolt read model.
 * @param project Remote project.
 * @param filters List filters.
 * @param deps Injectable read-only client.
 */
export async function listProjectIssues(
	project: Project,
	filters: IssueFilters,
	deps: ReadDeps = {}
): Promise<IssueListResponse> {
	const configured = deps.dolt_configured ?? getEnv().dolt_configured;
	if (!canUseSql(project, configured)) {
		throw new Error('remote Dolt is not configured for this project');
	}
	const dolt = deps.dolt ?? getDoltClient();
	await assertReadableSchema(dolt, project.dolt_database);
	const issues = await dolt.browseIssues(project.dolt_database, filters);
	return { issues, source: 'sql', readonly: true };
}

/**
 * Resolve dependency reverse edges from remote Dolt.
 * @param project Remote project.
 * @param issue_id Issue identifier.
 * @param deps Injectable read-only client.
 */
export async function resolveDependents(project: Project, issue_id: string, deps: ReadDeps = {}) {
	const configured = deps.dolt_configured ?? getEnv().dolt_configured;
	if (!canUseSql(project, configured)) {
		return [];
	}
	const dolt = deps.dolt ?? getDoltClient();
	return dolt.dependents(project.dolt_database, issue_id);
}

/**
 * Load one issue entirely from remote Dolt.
 * @param project Remote project.
 * @param issue_id Issue identifier.
 * @param deps Injectable read-only client.
 */
export async function getProjectIssue(
	project: Project,
	issue_id: string,
	deps: ReadDeps = {}
): Promise<IssueDetailResponse | undefined> {
	const configured = deps.dolt_configured ?? getEnv().dolt_configured;
	if (!canUseSql(project, configured)) {
		throw new Error('remote Dolt is not configured for this project');
	}
	const dolt = deps.dolt ?? getDoltClient();
	await assertReadableSchema(dolt, project.dolt_database);
	const issue = await dolt.issueDetail(project.dolt_database, issue_id);
	return issue === undefined ? undefined : { issue, readonly: true };
}

/**
 * Build an activity feed for one remote project.
 *
 * Activity is supplementary; an unreachable individual project contributes no
 * events rather than obscuring activity from every other project.
 */
export async function getProjectEvents(
	project: Project,
	limit: number,
	deps: ReadDeps = {}
): Promise<ActivityEvent[]> {
	const configured = deps.dolt_configured ?? getEnv().dolt_configured;
	if (!canUseSql(project, configured)) {
		return [];
	}
	try {
		const dolt = deps.dolt ?? getDoltClient();
		const events = await dolt.recentEvents(project.dolt_database, limit);
		return events.map((event) => {
			return { ...event, project_id: project.id, project_name: project.name };
		});
	} catch {
		return [];
	}
}

/** Merge activity across remote projects, newest first. */
export async function getMergedEvents(
	projects: Project[],
	limit: number,
	deps: ReadDeps = {}
): Promise<ActivityEvent[]> {
	const batches = await Promise.all(
		projects.map(async (project) => {
			return getProjectEvents(project, limit, deps);
		})
	);
	return batches
		.flat()
		.sort((a, b) => {
			return Date.parse(b.created_at) - Date.parse(a.created_at);
		})
		.slice(0, limit);
}

/**
 * Ready issues for one remote project: open, unblocked by `blocks` deps,
 * not in progress. Failures on one database do not hide other projects.
 */
export async function getProjectReadyIssues(
	project: Project,
	limit: number,
	deps: ReadDeps = {}
): Promise<ReadyIssue[]> {
	const configured = deps.dolt_configured ?? getEnv().dolt_configured;
	if (!canUseSql(project, configured)) {
		return [];
	}
	try {
		const dolt = deps.dolt ?? getDoltClient();
		// An unsupported project contributes nothing rather than failing Ready.
		await assertReadableSchema(dolt, project.dolt_database);
		const issues = await dolt.listReadyIssues(project.dolt_database, limit);
		return issues.map((issue) => {
			return { ...issue, project_id: project.id, project_name: project.name };
		});
	} catch {
		return [];
	}
}

/** Merge Ready issues across catalog projects, priority then recency. */
export async function getMergedReadyIssues(
	projects: Project[],
	limit: number,
	deps: ReadDeps = {}
): Promise<ReadyListResponse> {
	const batches = await Promise.all(
		projects.map(async (project) => {
			return getProjectReadyIssues(project, limit, deps);
		})
	);
	const issues = batches
		.flat()
		.sort((a, b) => {
			if (a.priority !== b.priority) {
				return a.priority - b.priority;
			}
			return Date.parse(b.updated_at) - Date.parse(a.updated_at);
		})
		.slice(0, limit);
	return { issues, source: 'sql', readonly: true };
}
