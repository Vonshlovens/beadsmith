import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '$lib/types.js';
import { createDispatchStore } from '../dispatch/store.js';
import type { AgentProvider } from '../dispatch/provider.js';
import { DISARMED_DISPATCH_MESSAGE, FILE_NOT_ALLOWED_MESSAGE } from '../dispatch/policy.js';
import { DispatchError } from '../dispatch/types.js';
import { initStateSchema, setTodoStore } from '../state/db.js';
import { createTodoStore, type TodoStore } from './store.js';
import { buildTodoFilePayload, routeIdempotencyKey, routeTodo, tagToLabel } from './route.js';

const PROJECT: Project = {
	id: 'd_beads_web',
	name: 'beads_web',
	state: 'remote',
	dolt_database: 'beads_web',
	backend: 'server-sql',
	readonly: true
};

const ALLOW = { armed: true, allow: { file: true, tackle: false } };

let todos: TodoStore;
let dispatches: ReturnType<typeof createDispatchStore>;

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	todos = createTodoStore(client);
	dispatches = createDispatchStore(client);
	setTodoStore(todos);
});

afterEach(() => setTodoStore(undefined));

function provider(overrides: Partial<AgentProvider> = {}): AgentProvider {
	return {
		id: 'webhook',
		label: 'Webhook agent runner',
		launch: vi.fn(async () => ({ agent_id: 'bc-1', agent_url: 'https://runner.example.com/a/1' })),
		getLatestRunId: vi.fn(async () => undefined),
		getRun: vi.fn(async () => ({ status: 'running' as const })),
		createRun: vi.fn(async () => ({ run_id: 'run-follow' })),
		cancelRun: vi.fn(async () => undefined),
		streamRun: vi.fn(async () => 'disconnected' as const),
		streamMissionEvents: vi.fn(async () => 'disconnected' as const),
		...overrides
	};
}

function deps(p: AgentProvider, policy = ALLOW) {
	return {
		store: dispatches,
		provider: p,
		configured: true,
		policy,
		schedule_background: () => {}
	};
}

describe('buildTodoFilePayload', () => {
	const todo = {
		id: 'td_aaaaaaaaaaaaaaaaaaaaaaaa',
		title: 'Ship backups doc',
		body: 'Cover restore too.',
		priority: 1,
		tags: ['+beadsmith', '@home', '+beadsmith', '+bad tag'],
		due_at: '2026-11-01'
	};

	it('carries title and priority 1:1 and turns tags into labels', () => {
		const payload = buildTodoFilePayload(todo, []);
		expect(payload).toMatchObject({
			operation: 'file',
			title: 'Ship backups doc',
			priority: 1,
			labels: ['beadsmith', 'home']
		});
	});

	it('keeps priority 0 and omits labels when there are none', () => {
		const payload = buildTodoFilePayload({ ...todo, priority: 0, tags: [] }, []);
		expect(payload.priority).toBe(0);
		expect(payload).not.toHaveProperty('labels');
	});

	it('puts body, comments, the operator note and the todo id in the notes', () => {
		const { notes } = buildTodoFilePayload(
			todo,
			[{ author: 'a@b.c', text: 'Check the S3 path', created_at: '2026-10-28T10:00:00.000Z' }],
			' Use the backup project '
		);
		expect(notes).toContain('Use the backup project');
		expect(notes).toContain('Cover restore too.');
		expect(notes).toContain('Due: 2026-11-01');
		expect(notes).toContain('- a@b.c (2026-10-28): Check the S3 path');
		expect(notes).toContain('Routed from admin todo td_aaaaaaaaaaaaaaaaaaaaaaaa');
	});

	it('stays within the dispatch notes limit and caps labels at eight', () => {
		const long = 'x'.repeat(20_000);
		const payload = buildTodoFilePayload(
			{ ...todo, body: long, tags: Array.from({ length: 12 }, (_, i) => `+t${i}`) },
			[]
		);
		expect(payload.notes.length).toBeLessThanOrEqual(8000);
		expect(payload.notes).toContain('Routed from admin todo');
		expect(payload.labels).toHaveLength(8);
	});

	it('maps tag prefixes only to valid labels', () => {
		expect(tagToLabel('+web')).toBe('web');
		expect(tagToLabel('@ctx')).toBe('ctx');
		expect(tagToLabel('+bad tag')).toBeUndefined();
	});
});

describe('routeTodo', () => {
	async function makeTodo() {
		return todos.create({ title: 'Ship it', priority: 3, tags: ['+web'], created_by: 'u1' });
	}

	it('launches one File dispatch and stores the routing columns', async () => {
		const todo = await makeTodo();
		await todos.addComment(todo.id, { author: 'u1', text: 'context' });
		const p = provider();
		const result = await routeTodo(
			todos,
			{ todo_id: todo.id, project: PROJECT, actor: 'u1' },
			deps(p)
		);

		expect(result.kind === 'routed' && result.created).toBe(true);
		expect(p.launch).toHaveBeenCalledOnce();
		const stored = await todos.get(todo.id);
		expect(stored).toMatchObject({ routed_project_id: PROJECT.id, routed_issue_id: null });
		expect(stored?.routed_dispatch_id).toMatch(/^dq_/);
		const record = await dispatches.get(stored!.routed_dispatch_id!);
		expect(record?.payload).toMatchObject({ operation: 'file', priority: 3, labels: ['web'] });
		expect(record?.idempotency_key).toBe(routeIdempotencyKey(todo.id, null));
	});

	it('routes once on a retry or double click', async () => {
		const todo = await makeTodo();
		const p = provider();
		const input = { todo_id: todo.id, project: PROJECT, actor: 'u1' };
		const [a, b] = await Promise.all([
			routeTodo(todos, input, deps(p)),
			routeTodo(todos, input, deps(p))
		]);
		const c = await routeTodo(todos, input, deps(p));

		expect(p.launch).toHaveBeenCalledOnce();
		expect(c.kind === 'routed' && c.created).toBe(false);
		const ids = [a, b, c].map((r) => (r.kind === 'routed' ? r.request?.id : undefined));
		expect(new Set(ids).size).toBe(1);
	});

	it('refuses a disarmed dispatch and leaves the todo unrouted', async () => {
		const todo = await makeTodo();
		const p = provider();
		await expect(
			routeTodo(
				todos,
				{ todo_id: todo.id, project: PROJECT, actor: 'u1' },
				deps(p, { armed: false, allow: { file: true, tackle: true } })
			)
		).rejects.toMatchObject({ code: 'forbidden', message: DISARMED_DISPATCH_MESSAGE });
		expect(p.launch).not.toHaveBeenCalled();
		expect((await todos.get(todo.id))?.routed_dispatch_id).toBeNull();
	});

	it('refuses a project that does not allow File and leaves the todo unrouted', async () => {
		const todo = await makeTodo();
		const rejection = routeTodo(
			todos,
			{ todo_id: todo.id, project: PROJECT, actor: 'u1' },
			deps(provider(), { armed: true, allow: { file: false, tackle: false } })
		);
		await expect(rejection).rejects.toBeInstanceOf(DispatchError);
		await expect(rejection).rejects.toMatchObject({ message: FILE_NOT_ALLOWED_MESSAGE });
		expect((await todos.get(todo.id))?.routed_project_id).toBeNull();
	});

	it('reports a missing todo', async () => {
		const result = await routeTodo(
			todos,
			{ todo_id: 'td_000000000000000000000000', project: PROJECT, actor: 'u1' },
			deps(provider())
		);
		expect(result.kind).toBe('missing');
	});

	it('routes again after a failed launch, as a new attempt', async () => {
		const todo = await makeTodo();
		const failing = provider({
			launch: vi.fn(async () => {
				throw new DispatchError('unavailable', 'runner down');
			})
		});
		const first = await routeTodo(
			todos,
			{ todo_id: todo.id, project: PROJECT, actor: 'u1' },
			deps(failing)
		);
		expect(first.kind === 'routed' && first.request?.status).toBe('failed');

		const ok = provider();
		const second = await routeTodo(
			todos,
			{ todo_id: todo.id, project: PROJECT, actor: 'u1' },
			deps(ok)
		);
		expect(ok.launch).toHaveBeenCalledOnce();
		expect(second.kind === 'routed' && second.created).toBe(true);
		expect(second.kind === 'routed' && second.request?.status).toBe('launched');
	});

	it('links the bead once the runner reports its issue id', async () => {
		const todo = await makeTodo();
		const p = provider({
			launch: vi.fn(async () => ({ agent_id: 'bc-1', run_id: 'run-1' })),
			getRun: vi.fn(async () => ({ status: 'succeeded' as const, issue_id: 'beads-web-42' }))
		});
		const { getDispatch } = await import('../dispatch/service.js');
		const routed = await routeTodo(
			todos,
			{ todo_id: todo.id, project: PROJECT, actor: 'u1' },
			deps(p)
		);
		const dispatch_id = routed.kind === 'routed' ? routed.request!.id : '';

		await getDispatch(PROJECT.id, dispatch_id, deps(p));

		expect((await todos.get(todo.id))?.routed_issue_id).toBe('beads-web-42');
		// A later report never overwrites the first link.
		expect(await todos.linkRoutedIssue(dispatch_id, 'beads-web-43')).toBe(false);
	});

	it('keeps a bead reported before the todo is stamped with its dispatch', async () => {
		const todo = await makeTodo();
		// The runner reports between the launch and the routing stamp.
		const racing: TodoStore = {
			...todos,
			stampRoute: async (id, project_id, dispatch_id) => {
				expect(await todos.linkRoutedIssue(dispatch_id, 'beads-web-77')).toBe(false);
				return todos.stampRoute(id, project_id, dispatch_id);
			}
		};
		await routeTodo(racing, { todo_id: todo.id, project: PROJECT, actor: 'u1' }, deps(provider()));

		expect((await todos.get(todo.id))?.routed_issue_id).toBe('beads-web-77');
		// A replay stamps the same dispatch and keeps the link.
		await routeTodo(todos, { todo_id: todo.id, project: PROJECT, actor: 'u1' }, deps(provider()));
		expect((await todos.get(todo.id))?.routed_issue_id).toBe('beads-web-77');
	});
});
