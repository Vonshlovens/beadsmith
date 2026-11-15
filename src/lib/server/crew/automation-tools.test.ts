import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoltClient } from '../dolt/client.js';
import { automationView } from '../automations/service.js';
import { automationTick, type AutomationTickDeps } from '../automations/scheduler.js';
import {
	createAutomationStore,
	PROPOSED_PAUSED_REASON,
	type AutomationStore
} from '../automations/store.js';
import { initStateSchema } from '../state/db.js';
import type { IssueDetail, Project } from '#lib/types.js';
import { createCrewMcpHandler, type JsonRpcResponse } from './mcp.js';
import type { CrewContext, CrewDeps } from './registry.js';

const ADMIN: CrewContext = {
	account_id: 'u_admin',
	actor: 'admin@example.test',
	role: 'admin',
	chat_id: 'mc_one',
	scope: 'd_alpha'
};
const MEMBER: CrewContext = { ...ADMIN, account_id: 'u_member', role: 'member' };

const PROJECTS: Project[] = ['alpha', 'beta'].map((name) => ({
	id: `d_${name}`,
	name,
	state: 'remote',
	dolt_database: name,
	backend: 'server-sql',
	readonly: true
}));

/** Only what an issue lookup touches; `alpha-1` is the one issue there is. */
function fakeDolt(): DoltClient {
	return {
		listDatabases: async () => ['alpha', 'beta'],
		issueDetail: async (_database: string, id: string) =>
			id === 'alpha-1' ? ({ id } as IssueDetail) : undefined
	} as unknown as DoltClient;
}

let store: AutomationStore;
let deps: CrewDeps;

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createAutomationStore(client);
	deps = {
		projects: async () => PROJECTS,
		read: { dolt: fakeDolt(), dolt_configured: true },
		automations: async () => store
	};
});

let next_id = 1;
async function rpc(name: string, args: Record<string, unknown>, ctx: CrewContext = ADMIN) {
	const handler = createCrewMcpHandler({ deps, log: () => {} });
	return (await handler.handle(ctx, {
		jsonrpc: '2.0',
		id: next_id++,
		method: 'tools/call',
		params: { name, arguments: args }
	})) as JsonRpcResponse;
}

async function call(name: string, args: Record<string, unknown>, ctx: CrewContext = ADMIN) {
	const response = await rpc(name, args, ctx);
	if (!('result' in response)) throw new Error(JSON.stringify(response.error));
	return response.result as { content: { text: string }[]; isError?: boolean };
}

async function ok(name: string, args: Record<string, unknown>, ctx?: CrewContext) {
	const result = await call(name, args, ctx);
	expect(result.isError, result.content[0].text).toBeUndefined();
	return JSON.parse(result.content[0].text);
}

async function refused(name: string, args: Record<string, unknown>, ctx?: CrewContext) {
	const result = await call(name, args, ctx);
	expect(result.isError, result.content[0].text).toBe(true);
	return result.content[0].text;
}

const nightly = {
	name: 'Nightly triage',
	cron: '0 2 * * *',
	time_zone: 'Europe/London',
	launch: { operation: 'file', notes: 'Summarise what changed overnight.' }
};

describe('crew automation tools', () => {
	it('define_automation creates a paused automation for the chat owner, marked as proposed', async () => {
		const created = await ok('define_automation', nightly);
		expect(created).toMatchObject({
			proposed: true,
			automation: {
				name: 'Nightly triage',
				project: { id: 'd_alpha', name: 'alpha' },
				enabled: false,
				proposed_by_first_mate: true,
				paused_reason: PROPOSED_PAUSED_REASON,
				launch: { operation: 'file' }
			}
		});
		expect(created.automation.url).toBe(`/automations/${created.automation.id}`);
		// Paused: no next run.
		expect(created.automation.next_run).toBeUndefined();

		const saved = await store.get(created.automation.id);
		expect(saved).toMatchObject({
			enabled: false,
			created_by: 'u_admin',
			proposed_chat_id: 'mc_one',
			payload: { operation: 'file', notes: 'Summarise what changed overnight.' }
		});
		// The browser sees the marker but never the chat id.
		const view = automationView(saved!, { now: new Date() });
		expect(view.proposed_by_first_mate).toBe(true);
		expect(JSON.stringify(view)).not.toContain('mc_one');
	});

	it('never fires a proposed automation until a person resumes it', async () => {
		const created = await ok('define_automation', { ...nightly, cron: '* * * * *' });
		const id = created.automation.id as string;
		const enqueue = vi.fn<AutomationTickDeps['enqueue']>(async () => ({
			request: { id: 'dq_1' },
			created: true
		}));
		const tick = (now: Date) =>
			automationTick({
				store,
				dispatch: { get: async () => undefined, getByIdempotencyKey: async () => undefined },
				enqueue,
				resolveProject: async (project_id) => PROJECTS.find((p) => p.id === project_id),
				getIssue: async () => undefined,
				creator: async () => ({ email: 'admin@example.test', role: 'admin', banned: false }),
				now: () => now
			});

		// An every-minute schedule, an hour on: still nothing.
		await tick(new Date(Date.now() + 60 * 60_000));
		expect(enqueue).not.toHaveBeenCalled();
		expect(await store.listRuns(id, 10)).toEqual([]);
		expect(await store.listEnabled()).toEqual([]);

		// The owner resumes it in the browser: the reason clears, the marker stays.
		const resumed = await store.setEnabled(id, true);
		expect(resumed).toMatchObject({ enabled: true, proposed_chat_id: 'mc_one' });
		expect(resumed?.paused_reason).toBeUndefined();
		await tick(new Date(Date.now() + 2 * 60 * 60_000));
		expect(enqueue).toHaveBeenCalledTimes(1);
	});

	it('an automation a person creates is not marked and starts enabled', async () => {
		const automation = await store.create({
			project_id: 'd_alpha',
			name: 'By hand',
			cron: '0 2 * * *',
			time_zone: 'UTC',
			payload: { operation: 'file', notes: 'x' },
			overlap: 'skip',
			created_by: 'u_admin'
		});
		expect(automation.enabled).toBe(true);
		expect(automation.proposed_chat_id).toBeUndefined();
		expect(automationView(automation, { now: new Date() })).not.toHaveProperty(
			'proposed_by_first_mate'
		);
	});

	it('validates as the browser does: schedule, zone, project, issue and launch shape', async () => {
		expect(await refused('define_automation', { ...nightly, cron: '61 * * * *' })).toMatch(
			/minute/i
		);
		expect(await refused('define_automation', { ...nightly, time_zone: 'Mars/Olympus' })).toMatch(
			/time zone/i
		);
		expect(await refused('define_automation', { ...nightly, project: 'gamma' })).toMatch(
			/No project "gamma"/
		);
		expect(
			await refused('define_automation', {
				...nightly,
				launch: { operation: 'tackle', issue_id: 'alpha-9' }
			})
		).toMatch(/issue not found/);
		// The input schema refuses an attempt to create it enabled, and a bad launch.
		expect(await rpc('define_automation', { ...nightly, enabled: true })).toMatchObject({
			error: { message: expect.stringContaining('enabled') }
		});
		expect(
			await rpc('define_automation', {
				...nightly,
				launch: { operation: 'loop', mode: 'plan', prompt: 'no', max_iterations: 3 }
			})
		).toHaveProperty('error');
		expect(await store.list()).toEqual([]);

		const tackle = await ok('define_automation', {
			...nightly,
			project: 'beta',
			launch: { operation: 'loop', mode: 'build', max_iterations: 5 }
		});
		expect(tackle.automation.project).toEqual({ id: 'd_beta', name: 'beta' });
	});

	it('list_automations shows every automation, filtered by project, with the marker', async () => {
		await ok('define_automation', nightly);
		await store.create({
			project_id: 'd_beta',
			name: 'By hand',
			cron: '0 3 * * *',
			time_zone: 'UTC',
			payload: { operation: 'file', notes: 'x' },
			overlap: 'skip',
			created_by: 'u_admin'
		});
		const all = await ok('list_automations', {});
		expect(
			all.automations.map((a: { name: string; proposed_by_first_mate?: true }) => [
				a.name,
				a.proposed_by_first_mate ?? false
			])
		).toEqual([
			['By hand', false],
			['Nightly triage', true]
		]);
		// Launch text (File notes) never reaches the model through the list.
		expect(JSON.stringify(all)).not.toContain('overnight');
		const beta = await ok('list_automations', { project: 'beta' });
		expect(beta.automations.map((a: { name: string }) => a.name)).toEqual(['By hand']);
	});

	it('a member may list automations, as GET /api/automations allows, but not propose one', async () => {
		await ok('define_automation', nightly);
		expect((await ok('list_automations', {}, MEMBER)).automations).toHaveLength(1);
		expect(await refused('define_automation', nightly, MEMBER)).toBeTruthy();
		expect(await store.list()).toHaveLength(1);
	});
});
