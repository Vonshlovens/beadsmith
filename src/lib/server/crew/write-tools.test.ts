import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { createDispatchStore, type DispatchStore } from '../dispatch/store.js';
import type { AgentProvider } from '../dispatch/provider.js';
import type { DispatchDeps } from '../dispatch/service.js';
import {
	DISARMED_DISPATCH_MESSAGE,
	TACKLE_NOT_ALLOWED_MESSAGE,
	type DispatchPolicy
} from '../dispatch/policy.js';
import { UNMAPPED_TACKLE_MESSAGE } from '../dispatch/repositories.js';
import { createTodoStore, type TodoStore } from '../todos/store.js';
import type { DoltClient } from '../dolt/client.js';
import type { IssueDetail, IssueSummary, Project } from '#lib/types.js';
import { createCrewMcpHandler, type JsonRpcResponse } from './mcp.js';
import { createLaunchLimiter, type LaunchLimiter } from './launch-limit.js';
import type { CrewContext, CrewDeps } from './registry.js';
import { launchKey } from './write-tools.js';

const ADMIN: CrewContext = {
	account_id: 'u_admin',
	actor: 'admin@example.test',
	role: 'admin',
	chat_id: 'mc_one',
	scope: 'd_alpha'
};
const MEMBER: CrewContext = { ...ADMIN, role: 'member' };

const PROJECTS: Project[] = ['alpha', 'beta'].map((name) => ({
	id: `d_${name}`,
	name,
	state: 'remote',
	dolt_database: name,
	backend: 'server-sql',
	readonly: true
}));

const ALLOW_ALL: DispatchPolicy = { armed: true, allow: { file: true, tackle: true } };
const ALPHA_REPO = {
	d_alpha: { url: 'https://github.com/example-org/alpha', ref: 'main', auto_create_pr: true }
};

function summary(id: string): IssueSummary {
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
		comment_count: 0
	};
}

function fakeDolt(): DoltClient {
	return {
		listDatabases: async () => ['alpha', 'beta'],
		issueCounts: async () => ({ open: 0, in_progress: 0, blocked: 0, closed: 0, total: 0 }),
		lastActivity: async () => undefined,
		browseIssues: async () => [],
		listReadyIssues: async () => [],
		issueDetail: async (_database, id): Promise<IssueDetail | undefined> =>
			id === 'alpha-1'
				? { ...summary(id), description: 'Do it.', dependencies: [], dependents: [], comments: [] }
				: undefined,
		dependents: async () => [],
		recentEvents: async () => [],
		issueEvents: async () => [],
		ping: async () => 1
	};
}

let dispatch_store: DispatchStore;
let todo_store: TodoStore;
let launches: ReturnType<typeof vi.fn<AgentProvider['launch']>>;
let provider: AgentProvider;
let limiter: LaunchLimiter;
let clock: number;

function dispatchDeps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
	return {
		store: dispatch_store,
		providers: [provider],
		policy: ALLOW_ALL,
		repositories: ALPHA_REPO,
		sqlite_maps: {},
		file_maps: {},
		schedule_background: () => {},
		...overrides
	};
}

function crewDeps(dispatch: DispatchDeps = dispatchDeps()): CrewDeps {
	return {
		projects: async () => PROJECTS,
		read: { dolt: fakeDolt(), dolt_configured: true },
		dispatch,
		todos: async () => todo_store,
		launch_limiter: limiter
	};
}

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	dispatch_store = createDispatchStore(client);
	todo_store = createTodoStore(client);
	let n = 0;
	launches = vi.fn<AgentProvider['launch']>(async () => ({
		agent_id: `agent-${++n}`,
		run_id: `run-${n}`
	}));
	provider = {
		id: 'e2b',
		label: 'Sand',
		launch: launches,
		getLatestRunId: vi.fn(async () => undefined),
		getRun: vi.fn(async () => ({ status: 'succeeded' as const })),
		createRun: vi.fn(async () => ({ run_id: 'run-follow' })),
		cancelRun: vi.fn(async () => undefined)
	};
	clock = Date.UTC(2026, 10, 9);
	limiter = createLaunchLimiter({ count: 3, window_ms: 600_000, now: () => clock });
});

let next_id = 1;
async function rpc(
	name: string,
	args: Record<string, unknown>,
	options: { ctx?: CrewContext; deps?: CrewDeps; tool_use_id?: string } = {}
): Promise<{ text: string; isError?: boolean }> {
	const handler = createCrewMcpHandler({ deps: options.deps ?? crewDeps(), log: () => {} });
	const response = (await handler.handle(options.ctx ?? ADMIN, {
		jsonrpc: '2.0',
		id: next_id++,
		method: 'tools/call',
		params: {
			name,
			arguments: args,
			...(options.tool_use_id === undefined
				? {}
				: { _meta: { 'claudecode/toolUseId': options.tool_use_id } })
		}
	})) as JsonRpcResponse;
	if (!('result' in response)) throw new Error(JSON.stringify(response.error));
	const result = response.result as { content: { text: string }[]; isError?: boolean };
	return { text: result.content[0].text, isError: result.isError };
}

async function ok(name: string, args: Record<string, unknown>, options = {}) {
	const result = await rpc(name, args, options);
	expect(result.isError, result.text).toBeUndefined();
	return JSON.parse(result.text);
}

async function refused(name: string, args: Record<string, unknown>, options = {}) {
	const result = await rpc(name, args, options);
	expect(result.isError, result.text).toBe(true);
	return result.text;
}

describe('todo tools', () => {
	it('create, update and complete a todo as the owner', async () => {
		const created = await ok('create_todo', {
			title: 'Ship the relay',
			priority: 1,
			tags: ['+beadsmith']
		});
		expect(created.todo).toMatchObject({ title: 'Ship the relay', priority: 1, status: 'open' });
		const stored = await todo_store.get(created.todo.id);
		expect(stored?.created_by).toBe('u_admin');

		const updated = await ok('update_todo', {
			todo_id: created.todo.id,
			title: 'Ship it',
			body: 'x'
		});
		expect(updated.todo).toMatchObject({ title: 'Ship it', body: 'x' });
		expect(await refused('update_todo', { todo_id: created.todo.id })).toMatch(/Nothing to change/);

		const done = await ok('complete_todo', { todo_id: created.todo.id });
		expect(done.todo.status).toBe('done');
		expect(await refused('complete_todo', { todo_id: 'td_' + '0'.repeat(24) })).toMatch(/No todo/);
	});

	it('are neither listed nor run for a member owner', async () => {
		expect(await refused('create_todo', { title: 'x' }, { ctx: MEMBER })).toMatch(/admin/);
		const handler = createCrewMcpHandler({ deps: crewDeps(), log: () => {} });
		const list = (await handler.handle(MEMBER, {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list'
		})) as { result: { tools: { name: string }[] } };
		const names = list.result.tools.map((tool) => tool.name);
		for (const name of [
			'create_todo',
			'route_todo',
			'file_issue',
			'tackle_issue',
			'cancel_mission'
		]) {
			expect(names).not.toContain(name);
		}
		expect(names).toContain('list_projects');
	});

	it('route_todo starts one File mission, linked to the todo and the chat', async () => {
		const todo = await todo_store.create({ title: 'Route me', created_by: 'u_admin' });
		const first = await ok(
			'route_todo',
			{ todo_id: todo.id, project: 'beta' },
			{ tool_use_id: 'toolu_a' }
		);
		expect(first).toMatchObject({
			launched: true,
			operation: 'file',
			project: { id: 'd_beta', name: 'beta' }
		});
		expect(first.todo.routed_mission_id).toBe(first.mission_id);
		const record = await dispatch_store.get(first.mission_id);
		expect(record).toMatchObject({ chat_id: 'mc_one', actor: 'admin@example.test' });

		// A second routing while the mission is alive replays it.
		const again = await ok(
			'route_todo',
			{ todo_id: todo.id, project: 'beta' },
			{ tool_use_id: 'toolu_b' }
		);
		expect(again).toMatchObject({ launched: false, mission_id: first.mission_id });
		expect(launches).toHaveBeenCalledTimes(1);
	});
});

describe('mission tools', () => {
	it('file_issue launches as the owner on the default provider, carrying the chat id', async () => {
		const result = await ok(
			'file_issue',
			{ notes: 'The relay drops frames.', title: 'Relay drops frames', labels: ['crew'] },
			{ tool_use_id: 'toolu_1' }
		);
		expect(result).toMatchObject({
			launched: true,
			operation: 'file',
			project: { id: 'd_alpha', name: 'alpha' },
			mission: { status: 'launched' }
		});
		expect(result.mission_id).toMatch(/^dq_/);
		const record = await dispatch_store.get(result.mission_id);
		expect(record).toMatchObject({
			chat_id: 'mc_one',
			actor: 'admin@example.test',
			provider: 'e2b',
			idempotency_key: launchKey(ADMIN, 'file_issue', { id: 'use:toolu_1' }),
			payload: { operation: 'file', notes: 'The relay drops frames.', labels: ['crew'] }
		});
	});

	it('a retried call with the same tool use id launches once', async () => {
		const args = { issue_id: 'alpha-1' };
		const first = await ok('tackle_issue', args, { tool_use_id: 'toolu_same' });
		const retry = await ok('tackle_issue', args, { tool_use_id: 'toolu_same' });
		expect(first.launched).toBe(true);
		expect(retry).toMatchObject({ launched: false, mission_id: first.mission_id });
		expect(retry.note).toMatch(/already handled/);
		expect(launches).toHaveBeenCalledTimes(1);
		// The replay gave its slot back: two more launches still fit a limit of three.
		await ok('tackle_issue', args, { tool_use_id: 'toolu_other' });
		await ok('file_issue', { notes: 'n' }, { tool_use_id: 'toolu_third' });
		expect(launches).toHaveBeenCalledTimes(3);
	});

	it('without a tool use id, identical arguments replay and different ones launch', async () => {
		const first = await ok('comment_issue', { issue_id: 'alpha-1', text: 'Looks good' });
		const again = await ok('comment_issue', { issue_id: 'alpha-1', text: 'Looks good' });
		const other = await ok('comment_issue', { issue_id: 'alpha-1', text: 'One more thing' });
		expect(again.mission_id).toBe(first.mission_id);
		expect(other.mission_id).not.toBe(first.mission_id);
		const record = await dispatch_store.get(first.mission_id);
		expect(record?.payload).toMatchObject({ author: 'admin@example.test', issue_id: 'alpha-1' });
	});

	it('keys missions per chat, so two chats never share one', async () => {
		const call = { id: 'use:toolu_1' };
		expect(launchKey(ADMIN, 'file_issue', call)).not.toBe(
			launchKey({ ...ADMIN, chat_id: 'mc_two' }, 'file_issue', call)
		);
	});

	it('refuses what the owner would be refused in the UI', async () => {
		// A member has no dispatch:launch.
		expect(await refused('file_issue', { notes: 'x' }, { ctx: MEMBER })).toMatch(/admin/);
		// Disarmed dispatch.
		const disarmed = crewDeps(dispatchDeps({ policy: { ...ALLOW_ALL, armed: false } }));
		expect(await refused('file_issue', { notes: 'x' }, { deps: disarmed })).toBe(
			DISARMED_DISPATCH_MESSAGE
		);
		// Tackle not allowed for the project.
		const no_tackle = crewDeps(
			dispatchDeps({ policy: { armed: true, allow: { file: true, tackle: false } } })
		);
		expect(await refused('tackle_issue', { issue_id: 'alpha-1' }, { deps: no_tackle })).toBe(
			TACKLE_NOT_ALLOWED_MESSAGE
		);
		// No repository mapping: the mission is recorded as failed and no agent starts.
		const unmapped = await ok(
			'tackle_issue',
			{ issue_id: 'alpha-1' },
			{ deps: crewDeps(dispatchDeps({ repositories: {} })) }
		);
		expect(unmapped.mission).toMatchObject({ status: 'failed', error: UNMAPPED_TACKLE_MESSAGE });
		// Unknown issue and project.
		expect(await refused('discuss_issue', { issue_id: 'alpha-9' })).toMatch(/No issue alpha-9/);
		expect(await refused('file_issue', { project: 'gamma', notes: 'x' })).toMatch(/No project/);
		expect(launches).not.toHaveBeenCalled();
	});

	it('caps launches per chat and says when to try again', async () => {
		for (const n of [1, 2, 3]) {
			await ok('file_issue', { notes: `note ${n}` });
		}
		const message = await refused('file_issue', { notes: 'note 4' });
		expect(message).toMatch(/Launch limit reached: this chat may start 3 missions per 10 minutes/);
		expect(launches).toHaveBeenCalledTimes(3);
		// Another chat has its own budget.
		await ok('file_issue', { notes: 'note 4' }, { ctx: { ...ADMIN, chat_id: 'mc_two' } });
		// The window slides.
		clock += 600_000;
		await ok('file_issue', { notes: 'note 5' });
	});

	it('a refused launch does not use up the limit', async () => {
		const disarmed = crewDeps(dispatchDeps({ policy: { ...ALLOW_ALL, armed: false } }));
		for (const n of [1, 2, 3, 4]) {
			await refused('file_issue', { notes: `n${n}` }, { deps: disarmed });
		}
		await ok('file_issue', { notes: 'now armed' });
	});

	it('discuss_issue, follow_up_mission and cancel_mission go through the service', async () => {
		const discuss = await ok('discuss_issue', {
			issue_id: 'alpha-1',
			intent: 'elaborate',
			message: 'Add acceptance criteria'
		});
		expect(discuss).toMatchObject({ operation: 'discuss', issue_id: 'alpha-1' });
		expect((await dispatch_store.get(discuss.mission_id))?.payload).toMatchObject({
			intent: 'elaborate',
			message: 'Add acceptance criteria'
		});

		// The provider reports the run finished, so a follow-up may start.
		const follow = await ok('follow_up_mission', {
			mission_id: discuss.mission_id,
			text: 'Also link the ADR'
		});
		expect(follow).toMatchObject({ launched: true, mission_id: discuss.mission_id });
		expect(provider.createRun).toHaveBeenCalledWith('agent-1', 'Also link the ADR');

		vi.mocked(provider.getRun).mockResolvedValue({ status: 'running' });
		const cancel = await ok('cancel_mission', { mission_id: discuss.mission_id });
		expect(cancel).toMatchObject({ operation: 'discuss', mission_id: discuss.mission_id });
		expect(provider.cancelRun).toHaveBeenCalled();

		expect(
			await refused('cancel_mission', { project: 'beta', mission_id: discuss.mission_id })
		).toMatch(/No mission/);
	});
});
