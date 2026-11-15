import { createClient } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { createGrownStore, type GrownViewer } from './store.js';
import { GrownError } from './errors.js';
import {
	SURFACE_COMPONENTS,
	SURFACE_MAX_BINDINGS,
	SURFACE_MAX_DEPTH,
	SURFACE_MAX_NODES,
	SURFACE_SPEC_MAX_BYTES,
	surface_spec_schema,
	surfaceToolProblems
} from './surface-spec.js';
import { BRIDGE_ACTIONS, BRIDGE_READS, bridgeTool } from './bridge.js';

/** A dashboard: stats, a filtered list, a chart and a button. */
function dashboard(): Record<string, unknown> {
	return {
		root: 'main',
		components: [
			{ id: 'main', component: 'Stack', children: ['title', 'stats', 'list', 'chart', 'go'] },
			{ id: 'title', component: 'Heading', text: 'Review queue' },
			{ id: 'stats', component: 'Row', children: ['ready_count', 'blocked_count'] },
			{ id: 'ready_count', component: 'StatTile', label: 'Ready', count: 'ready' },
			{ id: 'blocked_count', component: 'StatTile', label: 'Blocked', count: 'blocked' },
			{ id: 'list', component: 'IssueList', data: 'blocked', limit: 10 },
			{ id: 'chart', component: 'Chart', data: 'blocked', by: 'priority' },
			{ id: 'go', component: 'Button', label: 'Tackle', action: 'tackle', tone: 'primary' }
		],
		data: {
			ready: { tool: 'ready_work', input: { limit: 20 } },
			blocked: { view: 'blocked-on-review' }
		},
		actions: {
			tackle: { tool: 'tackle_issue', input: { project: 'd_web', issue_id: 'web-1' } }
		}
	};
}

function problems(spec: unknown): string[] {
	const parsed = surface_spec_schema.safeParse(spec);
	if (parsed.success) return [];
	return parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

/** Schema problems first; for a spec the schema accepts, its tool input problems. */
async function allProblems(spec: unknown): Promise<string[]> {
	const parsed = surface_spec_schema.safeParse(spec);
	if (!parsed.success) return problems(spec);
	return surfaceToolProblems(parsed.data);
}

function withComponents(...components: Record<string, unknown>[]) {
	return { root: 'main', components };
}

describe('surface spec', () => {
	it('accepts a dashboard and fills defaults', () => {
		const spec = surface_spec_schema.parse(dashboard());
		expect(spec.components[0]).toMatchObject({ component: 'Stack', gap: 'md' });
		expect(spec.components.find((c) => c.id === 'chart')).toMatchObject({ chart: 'bar' });
		expect(
			surface_spec_schema.parse(withComponents({ id: 'main', component: 'Text', text: 'hi' }))
		).toEqual({
			root: 'main',
			components: [{ id: 'main', component: 'Text', text: 'hi' }],
			data: {},
			actions: {}
		});
	});

	it('names the starting catalog', () => {
		expect(SURFACE_COMPONENTS).toEqual([
			'Stack',
			'Row',
			'Heading',
			'Text',
			'Markdown',
			'StatTile',
			'IssueList',
			'IssueBoard',
			'Chart',
			'Button'
		]);
	});

	it('refuses unknown components, unknown props and unknown top-level keys', () => {
		expect(problems(withComponents({ id: 'main', component: 'Script', src: 'x' }))).not.toEqual([]);
		expect(
			problems(withComponents({ id: 'main', component: 'Text', text: 'hi', html: '<b>' }))
		).not.toEqual([]);
		expect(
			problems(withComponents({ id: 'main', component: 'Text', text: 'hi', onClick: 'x()' }))
		).not.toEqual([]);
		expect(problems({ ...dashboard(), script: 'alert(1)' })).not.toEqual([]);
	});

	it('refuses control characters in plain text', () => {
		expect(
			problems(withComponents({ id: 'main', component: 'Heading', text: 'a\u0000b' }))
		).not.toEqual([]);
	});

	it('refuses a missing root, duplicate ids and missing children', () => {
		expect(
			problems({ root: 'nope', components: [{ id: 'main', component: 'Text', text: 'x' }] })
		).toEqual(['root: no component has the root id "nope"']);
		expect(
			problems(
				withComponents(
					{ id: 'main', component: 'Stack', children: ['a'] },
					{ id: 'a', component: 'Text', text: 'x' },
					{ id: 'a', component: 'Text', text: 'y' }
				)
			)
		).toContain('components.2.id: the id "a" is used twice');
		expect(
			problems(withComponents({ id: 'main', component: 'Stack', children: ['ghost'] }))
		).toEqual(['components.0.children.0: no component has the id "ghost"']);
	});

	it('refuses two parents, cycles and orphans', () => {
		expect(
			problems(
				withComponents(
					{ id: 'main', component: 'Stack', children: ['a', 'b'] },
					{ id: 'a', component: 'Row', children: ['c'] },
					{ id: 'b', component: 'Row', children: ['c'] },
					{ id: 'c', component: 'Text', text: 'x' }
				)
			)
		).toEqual(['components.2.children.0: "c" is already a child of "a"']);
		expect(
			problems(
				withComponents(
					{ id: 'main', component: 'Stack', children: [] },
					{ id: 'a', component: 'Row', children: ['b'] },
					{ id: 'b', component: 'Row', children: ['a'] }
				)
			)
		).toEqual([
			'components.1: "a" is not reachable from the root',
			'components.2: "b" is not reachable from the root'
		]);
		expect(
			problems(withComponents({ id: 'main', component: 'Stack', children: ['main'] }))
		).toEqual(['components.0.children.0: the root cannot be a child']);
	});

	it('enforces depth, node and binding limits', () => {
		const deep = Array.from({ length: SURFACE_MAX_DEPTH + 1 }, (_, i) => ({
			id: i === 0 ? 'main' : `n${i}`,
			component: 'Stack',
			children: i === SURFACE_MAX_DEPTH ? [] : [`n${i + 1}`]
		}));
		expect(problems(withComponents(...deep))).toEqual([
			`components: the tree is ${SURFACE_MAX_DEPTH + 1} deep; at most ${SURFACE_MAX_DEPTH}`
		]);
		expect(problems(withComponents(...deep.slice(0, SURFACE_MAX_DEPTH)))).toEqual([
			`components.${SURFACE_MAX_DEPTH - 1}.children.0: no component has the id "n${SURFACE_MAX_DEPTH}"`
		]);

		const many = Array.from({ length: SURFACE_MAX_NODES }, (_, i) => `t${i}`);
		const wide = withComponents(
			{ id: 'main', component: 'Stack', children: many },
			...many.map((id) => ({ id, component: 'Text', text: id }))
		);
		expect(problems(wide)).not.toEqual([]);

		const names = Array.from({ length: SURFACE_MAX_BINDINGS + 1 }, (_, i) => `d${i}`);
		expect(
			problems({
				root: 'main',
				components: [
					{ id: 'main', component: 'Stack', children: names },
					...names.map((name) => ({
						id: name,
						component: 'IssueList',
						data: name
					}))
				],
				data: Object.fromEntries(names.map((name) => [name, { view: 'v' }]))
			})
		).toContain(`data: at most ${SURFACE_MAX_BINDINGS} data bindings`);
	});

	it('requires every binding and action reference to resolve, and every one to be used', () => {
		const spec = dashboard();
		expect(problems({ ...spec, data: { ready: (spec.data as never)['ready'] } })).toContain(
			'components.5.data: there is no data binding "blocked"'
		);
		expect(problems({ ...spec, actions: {} })).toContain(
			'components.7.action: there is no action "tackle"'
		);
		expect(
			problems({
				...spec,
				data: { ...(spec.data as object), spare: { view: 'x' } },
				actions: {
					...(spec.actions as object),
					spare: { tool: 'create_todo', input: { title: 't' } }
				}
			})
		).toEqual(['data.spare: no component reads "spare"', 'actions.spare: no button uses "spare"']);
	});

	it('checks a component can show its binding', () => {
		const spec = {
			root: 'main',
			components: [{ id: 'main', component: 'IssueList', data: 'projects' }],
			data: { projects: { tool: 'list_projects', input: {} } }
		};
		expect(problems(spec)).toEqual([
			'components.0.data: IssueList shows issues, but "projects" reads projects'
		]);
		expect(
			problems({
				...spec,
				components: [{ id: 'main', component: 'StatTile', label: 'Projects', count: 'projects' }]
			})
		).toEqual([]);
	});

	it('allows only bridge tools, with inputs their own schema accepts', async () => {
		const read = (binding: unknown) => ({
			root: 'main',
			components: [{ id: 'main', component: 'IssueList', data: 'rows' }],
			data: { rows: binding }
		});
		expect(await allProblems(read({ tool: 'remember', input: {} }))).not.toEqual([]);
		expect(await allProblems(read({ tool: 'define_view', input: {} }))).not.toEqual([]);
		expect(await allProblems(read({ tool: 'ready_work', input: { limit: 500 } }))).toEqual([
			'data.rows.input: limit: Too big: expected number to be <=50'
		]);
		expect(await allProblems(read({ tool: 'ready_work', input: { sql: 'x' } }))).not.toEqual([]);
		expect(await allProblems(read({ tool: 'list_issues', input: { status: 'open' } }))).toEqual([
			'data.rows.input: project: name the project; a grown thing has no chat project to default to'
		]);
		expect(await allProblems(read({ view: 'Not A Slug' }))).not.toEqual([]);

		const act = (action: unknown) => ({
			root: 'main',
			components: [{ id: 'main', component: 'Button', label: 'Go', action: 'go' }],
			actions: { go: action }
		});
		expect(await allProblems(act({ tool: 'cancel_mission', input: {} }))).not.toEqual([]);
		expect(await allProblems(act({ tool: 'follow_up_mission', input: {} }))).not.toEqual([]);
		expect(await allProblems(act({ tool: 'tackle_issue', input: { issue_id: 'web-1' } }))).toEqual([
			'actions.go.input: project: name the project; a grown thing has no chat project to default to'
		]);
		expect(await allProblems(act({ tool: 'create_todo', input: { title: 'Review' } }))).toEqual([]);
	});

	it('allowlists no chat-bound or grown-thing tools', async () => {
		const names = [...Object.keys(BRIDGE_READS), ...Object.keys(BRIDGE_ACTIONS)];
		for (const forbidden of [
			'remember',
			'recall',
			'forget',
			'meta_write',
			'follow_up_mission',
			'cancel_mission',
			'define_view',
			'revert_view',
			'define_automation'
		]) {
			expect(names).not.toContain(forbidden);
		}
		for (const name of names) {
			expect((await bridgeTool(name as never)).name).toBe(name);
		}
	});
});

describe('surfaces in the grown store', () => {
	const owner: GrownViewer = { account_id: 'u_owner', role: 'admin' };
	const author = { kind: 'first_mate', account_id: 'u_owner', chat_id: 'mc_one' } as const;

	async function store() {
		const client = createClient({ url: ':memory:' });
		await initStateSchema(client);
		return createGrownStore(client);
	}

	it('saves a valid surface and refuses an invalid one before saving', async () => {
		const grown = await store();
		const thing = await grown.create(owner, {
			kind: 'surface',
			slug: 'review-queue',
			name: 'Review queue',
			spec: dashboard(),
			author
		});
		expect(thing.kind).toBe('surface');
		expect(thing.revision.spec).toMatchObject({ root: 'main' });

		const bad = await grown
			.create(owner, {
				kind: 'surface',
				slug: 'bad',
				name: 'Bad',
				spec: withComponents({ id: 'main', component: 'Iframe', src: 'https://x' }),
				author
			})
			.catch((error: unknown) => error);
		expect(bad).toBeInstanceOf(GrownError);
		expect((bad as GrownError).message).toContain('The surface spec is invalid');
		expect(await grown.read(owner, 'bad')).toBeUndefined();
	});

	it('refuses a surface over the byte limit', async () => {
		const grown = await store();
		const text = 'x'.repeat(8_000);
		const ids = ['a', 'b', 'c', 'd', 'e'];
		const spec = withComponents(
			{ id: 'main', component: 'Stack', children: ids },
			...ids.map((id) => ({ id, component: 'Markdown', text }))
		);
		expect(JSON.stringify(spec).length).toBeGreaterThan(SURFACE_SPEC_MAX_BYTES);
		const error = await grown
			.create(owner, { kind: 'surface', slug: 'big', name: 'Big', spec, author })
			.catch((e: unknown) => e);
		expect((error as GrownError).message).toContain(`at most ${SURFACE_SPEC_MAX_BYTES} bytes`);
	});

	it('keeps views and surfaces under separate per-owner counts', async () => {
		const grown = await store();
		await grown.create(owner, {
			kind: 'view',
			slug: 'blocked-on-review',
			name: 'Blocked',
			spec: { scope: 'all' },
			author
		});
		const surfaces = await grown.list(owner, 'surface');
		expect(surfaces).toEqual([]);
	});
});
