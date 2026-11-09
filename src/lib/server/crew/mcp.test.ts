import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { createDispatchStore, type DispatchStore } from '../dispatch/store.js';
import { createTodoStore, type TodoStore } from '../todos/store.js';
import type { DoltClient } from '../dolt/client.js';
import type { IssueDetail, IssueSummary, Project } from '#lib/types.js';
import { CREW_TOOLS, createCrewMcpHandler, JSONRPC_ERRORS, type JsonRpcResponse } from './mcp.js';
import { RESULT_MAX_CHARS, type CrewContext, type CrewDeps } from './registry.js';

const ADMIN: CrewContext = {
	account_id: 'u_admin',
	actor: 'admin@example.test',
	role: 'admin',
	chat_id: 'c1',
	scope: null
};
const MEMBER: CrewContext = { ...ADMIN, role: 'member' };

const PROJECTS: Project[] = ['alpha', 'beta'].map((name) => ({
	id: `d_${name}`,
	name,
	state: 'remote',
	dolt_database: name,
	backend: 'server-sql',
	readonly: true,
	counts: { open: 1, in_progress: 0, blocked: 0, closed: 0, total: 1 }
}));

function summary(id: string, overrides: Partial<IssueSummary> = {}): IssueSummary {
	return {
		id,
		title: `Issue ${id}`,
		status: 'open',
		priority: 2,
		issue_type: 'task',
		labels: [],
		created_at: '2026-11-01T00:00:00Z',
		updated_at: '2026-11-01T00:00:00Z',
		dependency_count: 0,
		dependent_count: 0,
		comment_count: 0,
		...overrides
	};
}

const browseIssues = vi.fn<DoltClient['browseIssues']>();

function fakeDolt(): DoltClient {
	return {
		listDatabases: async () => ['alpha', 'beta'],
		issueCounts: async () => ({ open: 0, in_progress: 0, blocked: 0, closed: 0, total: 0 }),
		lastActivity: async () => undefined,
		browseIssues,
		listReadyIssues: async (database) => [
			summary(`${database}-1`, { priority: database === 'beta' ? 0 : 3 })
		],
		issueDetail: async (_database, id): Promise<IssueDetail | undefined> =>
			id === 'alpha-1'
				? {
						...summary('alpha-1'),
						description: 'x'.repeat(10_000),
						dependencies: [{ id: 'alpha-0', dep_type: 'blocks' }],
						dependents: [{ id: 'alpha-2', dep_type: 'blocks' }],
						comments: Array.from({ length: 15 }, (_, i) => ({
							id: `${i}`,
							author: 'a',
							text: `c${i}`
						}))
					}
				: undefined,
		dependents: async () => [],
		recentEvents: async () => [],
		issueEvents: async (_database, issue_id) => [
			{ issue_id, event_type: 'status_changed', actor: 'bot', created_at: '2026-11-02T00:00:00Z' }
		],
		ping: async () => 1
	};
}

let dispatch_store: DispatchStore;
let todo_store: TodoStore;
let deps: CrewDeps;

beforeEach(async () => {
	browseIssues.mockReset();
	browseIssues.mockResolvedValue([summary('alpha-1', { assignee: 'eve' })]);
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	dispatch_store = createDispatchStore(client);
	todo_store = createTodoStore(client);
	deps = {
		projects: async () => PROJECTS,
		read: { dolt: fakeDolt(), dolt_configured: true },
		dispatch: { store: dispatch_store, providers: [] },
		todos: async () => todo_store
	};
});

let next_id = 1;
async function rpc(
	method: string,
	params?: Record<string, unknown>,
	ctx: CrewContext = ADMIN
): Promise<JsonRpcResponse> {
	const handler = createCrewMcpHandler({ deps, log: () => {} });
	const response = await handler.handle(ctx, { jsonrpc: '2.0', id: next_id++, method, params });
	if (response === undefined) throw new Error('expected a response');
	return response;
}

/** Call a tool and parse its JSON text, failing on an error result. */
async function call(name: string, args: Record<string, unknown> = {}, ctx: CrewContext = ADMIN) {
	const response = await rpc('tools/call', { name, arguments: args }, ctx);
	if (!('result' in response)) throw new Error(JSON.stringify(response.error));
	const result = response.result as { content: { text: string }[]; isError?: boolean };
	expect(result.isError, result.content[0].text).toBeUndefined();
	expect(result.content[0].text.length).toBeLessThanOrEqual(RESULT_MAX_CHARS + 200);
	return JSON.parse(result.content[0].text);
}

describe('crew MCP handler', () => {
	it('initializes with tools capability and negotiates the protocol version', async () => {
		const response = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
		expect(response).toMatchObject({
			result: {
				protocolVersion: '2025-03-26',
				capabilities: { tools: {} },
				serverInfo: { name: 'beadsmith-crew' }
			}
		});
		const unknown = await rpc('initialize', { protocolVersion: '1999-01-01' });
		expect(unknown).toMatchObject({ result: { protocolVersion: '2025-06-18' } });
	});

	it('answers ping and ignores notifications', async () => {
		expect(await rpc('ping')).toMatchObject({ result: {} });
		const handler = createCrewMcpHandler({ deps });
		expect(
			await handler.handle(ADMIN, { jsonrpc: '2.0', method: 'notifications/initialized' })
		).toBeUndefined();
	});

	it('lists every tool with an object input schema', async () => {
		const response = await rpc('tools/list');
		const tools = (response as { result: { tools: { name: string; inputSchema: unknown }[] } })
			.result.tools;
		expect(tools.map((tool) => tool.name)).toEqual(CREW_TOOLS.map((tool) => tool.name));
		for (const tool of tools) {
			expect(tool.inputSchema).toMatchObject({ type: 'object' });
			expect(tool.inputSchema).not.toHaveProperty('$schema');
		}
		const list_issues = tools.find((tool) => tool.name === 'list_issues')?.inputSchema as {
			required?: string[];
		};
		// Defaults are optional to the caller.
		expect(list_issues.required ?? []).not.toContain('limit');
	});

	it('hides and refuses admin-only tools for a member, as the HTTP gate does', async () => {
		const response = await rpc('tools/list', undefined, MEMBER);
		const names = (response as { result: { tools: { name: string }[] } }).result.tools.map(
			(tool) => tool.name
		);
		expect(names).not.toContain('list_todos');
		expect(names).toContain('list_projects');
		const refused = await rpc('tools/call', { name: 'list_todos', arguments: {} }, MEMBER);
		expect(refused).toMatchObject({ result: { isError: true } });
	});

	it('returns JSON-RPC errors for unknown tools, bad input and bad frames, never throwing', async () => {
		expect(await rpc('tools/call', { name: 'drop_tables' })).toMatchObject({
			error: { code: JSONRPC_ERRORS.invalid_params }
		});
		expect(
			await rpc('tools/call', { name: 'list_issues', arguments: { limit: 'lots' } })
		).toMatchObject({ error: { code: JSONRPC_ERRORS.invalid_params, message: /limit/ } });
		expect(
			await rpc('tools/call', { name: 'list_projects', arguments: { extra: 1 } })
		).toMatchObject({ error: { code: JSONRPC_ERRORS.invalid_params } });
		expect(await rpc('tools/call', { name: 7 })).toMatchObject({
			error: { code: JSONRPC_ERRORS.invalid_params }
		});
		expect(await rpc('resources/list')).toMatchObject({
			error: { code: JSONRPC_ERRORS.method_not_found }
		});
		const handler = createCrewMcpHandler({ deps });
		expect(await handler.handleText(ADMIN, '{not json')).toMatchObject({
			error: { code: JSONRPC_ERRORS.parse }
		});
		expect(await handler.handle(ADMIN, [1, 2])).toMatchObject({
			error: { code: JSONRPC_ERRORS.invalid_request }
		});
		expect(await handler.handle(ADMIN, { id: 3, method: 'ping' })).toMatchObject({
			id: 3,
			error: { code: JSONRPC_ERRORS.invalid_request }
		});
		expect(await handler.handle(ADMIN, null)).toMatchObject({
			error: { code: JSONRPC_ERRORS.invalid_request }
		});
	});

	it('turns a failing read into a safe tool error, not driver detail', async () => {
		browseIssues.mockRejectedValue(new Error('connect ECONNREFUSED password=hunter2'));
		const response = await rpc('tools/call', {
			name: 'list_issues',
			arguments: { project: 'alpha' }
		});
		expect(response).toMatchObject({ result: { isError: true } });
		expect(JSON.stringify(response)).not.toContain('hunter2');
	});
});

describe('crew read tools', () => {
	it('list_projects returns compact projects', async () => {
		const result = await call('list_projects');
		expect(result.projects).toEqual([
			expect.objectContaining({ id: 'd_alpha', name: 'alpha', counts: expect.any(Object) }),
			expect.objectContaining({ id: 'd_beta', name: 'beta' })
		]);
	});

	it('ready_work merges every project by priority, or reads one', async () => {
		const all = await call('ready_work');
		expect(all.issues.map((issue: { id: string }) => issue.id)).toEqual(['beta-1', 'alpha-1']);
		expect(all.issues[0]).toMatchObject({ project_id: 'd_beta', priority: 0 });
		const one = await call('ready_work', { project: 'd_alpha' });
		expect(one).toMatchObject({ project: { id: 'd_alpha' }, issues: [{ id: 'alpha-1' }] });
	});

	it('list_issues passes filters through and defaults to the chat scope', async () => {
		const result = await call(
			'list_issues',
			{ status: 'open', assignee: 'eve', label: 'ui', text: 'login', limit: 1 },
			{ ...ADMIN, scope: 'd_alpha' }
		);
		expect(browseIssues).toHaveBeenCalledWith('alpha', {
			limit: 1,
			include_closed: false,
			status: 'open',
			assignee: 'eve',
			label: 'ui',
			q: 'login'
		});
		expect(result.issues).toEqual([expect.objectContaining({ id: 'alpha-1', assignee: 'eve' })]);
		expect(result.note).toMatch(/Limit reached/);
	});

	it('list_issues without a project or scope asks for one; unknown projects say so', async () => {
		const missing = await rpc('tools/call', { name: 'list_issues', arguments: {} });
		expect(missing).toMatchObject({ result: { isError: true } });
		const unknown = await rpc('tools/call', {
			name: 'list_issues',
			arguments: { project: 'gamma' }
		});
		expect(JSON.stringify(unknown)).toContain('No project');
	});

	it('show_issue bounds long text and includes deps, dependents and recent events', async () => {
		const result = await call('show_issue', { project: 'alpha', issue_id: 'alpha-1' });
		expect(result.issue.description).toMatch(/truncated 8000 chars/);
		expect(result.dependencies).toEqual([{ id: 'alpha-0', dep_type: 'blocks' }]);
		expect(result.dependents).toEqual([{ id: 'alpha-2', dep_type: 'blocks' }]);
		expect(result.comment_count).toBe(15);
		expect(result.recent_comments).toHaveLength(10);
		expect(result.recent_events).toEqual([
			{ event_type: 'status_changed', actor: 'bot', created_at: '2026-11-02T00:00:00Z' }
		]);
		const missing = await rpc('tools/call', {
			name: 'show_issue',
			arguments: { project: 'alpha', issue_id: 'alpha-9' }
		});
		expect(missing).toMatchObject({ result: { isError: true } });
	});

	it('list_missions and show_mission read missions with their turns', async () => {
		const { record } = await dispatch_store.create({
			idempotency_key: 'crew-test-key-1',
			project_id: 'd_alpha',
			dolt_database: 'alpha',
			operation: 'file',
			actor: 'u_admin',
			payload: { operation: 'file', title: 'Add a login page', notes: 'n'.repeat(5000) }
		} as Parameters<DispatchStore['create']>[0]);
		await dispatch_store.updateStatus(record.id, {
			status: 'succeeded',
			git_pr_url: 'https://github.com/example/repo/pull/1'
		});
		await dispatch_store.appendTurn(record.id, { role: 'operator', text: 'File it' });

		const list = await call('list_missions', { project: 'alpha' });
		expect(list.missions).toEqual([
			expect.objectContaining({
				id: record.id,
				project_name: 'alpha',
				status: 'succeeded',
				title: 'Add a login page',
				pr_url: 'https://github.com/example/repo/pull/1'
			})
		]);
		expect(JSON.stringify(list)).not.toContain('nnnn');

		const shown = await call('show_mission', { project: 'd_alpha', mission_id: record.id });
		expect(shown.mission).toMatchObject({ id: record.id, status: 'succeeded' });
		expect(shown.recent_turns).toEqual([
			expect.objectContaining({ role: 'operator', text: 'File it' })
		]);

		const wrong_project = await rpc('tools/call', {
			name: 'show_mission',
			arguments: { project: 'beta', mission_id: record.id }
		});
		expect(wrong_project).toMatchObject({ result: { isError: true } });
	});

	it('list_todos filters by status for an admin', async () => {
		await todo_store.create({ title: 'Ship crew tools', tags: ['+alpha'], created_by: 'u_admin' });
		const done = await todo_store.create({ title: 'Old', created_by: 'u_admin' });
		await todo_store.update(done.id, { status: 'done' });
		const open = await call('list_todos');
		expect(open.todos).toEqual([
			expect.objectContaining({ title: 'Ship crew tools', tags: ['+alpha'], status: 'open' })
		]);
		const all = await call('list_todos', { status: 'all' });
		expect(all.todos).toHaveLength(2);
	});

	it('list_todos describes routing: filed with the next step, and failed with a retry', async () => {
		const mission = async (key: string, status: 'succeeded' | 'failed') => {
			const { record } = await dispatch_store.create({
				idempotency_key: key,
				project_id: 'd_alpha',
				dolt_database: 'alpha',
				operation: 'file',
				actor: 'u_admin',
				payload: { operation: 'file', title: key }
			} as Parameters<DispatchStore['create']>[0]);
			await dispatch_store.updateStatus(record.id, {
				status,
				...(status === 'failed' ? { error_message: 'no checkout' } : {})
			});
			return record.id;
		};
		const filed = await todo_store.create({ title: 'Filed', created_by: 'u_admin' });
		await todo_store.update(filed.id, {
			routed_project_id: 'd_alpha',
			routed_dispatch_id: await mission('crew-route-filed', 'succeeded'),
			routed_issue_id: 'alpha-1'
		});
		const failed = await todo_store.create({ title: 'Failed', created_by: 'u_admin' });
		await todo_store.update(failed.id, {
			routed_project_id: 'd_alpha',
			routed_dispatch_id: await mission('crew-route-failed', 'failed')
		});
		await todo_store.create({ title: 'Plain', created_by: 'u_admin' });

		const { todos } = await call('list_todos');
		const by_title = Object.fromEntries(
			(todos as { title: string; routing?: unknown }[]).map((todo) => [todo.title, todo.routing])
		);
		expect(by_title.Filed).toEqual({
			state: 'filed',
			issue_status: 'open',
			issue_title: 'Issue alpha-1',
			next: 'tackle_issue to work the bead'
		});
		expect(by_title.Failed).toEqual({
			state: 'failed',
			mission_status: 'failed',
			error: 'no checkout',
			next: 'route_todo again to retry'
		});
		expect(by_title.Plain).toBeUndefined();
	});
});

describe('crew module boundaries', () => {
	it('imports no transport or E2B code', () => {
		const dir = join(import.meta.dirname);
		for (const file of readdirSync(dir).filter((name) => !name.endsWith('.test.ts'))) {
			const source = readFileSync(join(dir, file), 'utf8');
			expect(source, file).not.toMatch(
				/from '[^']*(e2b|@sveltejs|node:(net|http|https|child_process))[^']*'/
			);
		}
	});
});
