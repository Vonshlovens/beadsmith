import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IssueDetail, Project } from '#lib/types.js';
import { initStateSchema } from '../state/db.js';
import {
	automationUpcoming,
	automationView,
	checkSchedule,
	createAutomation,
	NEVER_FIRES_MESSAGE,
	UNKNOWN_TIME_ZONE_MESSAGE,
	type CreateAutomationDeps,
	type CreateAutomationRequest
} from './service.js';
import { createAutomationStore, type AutomationStore } from './store.js';

const NOW = new Date('2026-11-11T12:00:00Z');
const PROJECT = { id: 'd_beads_web', name: 'beads_web', dolt_database: 'beads_web' } as Project;
const CREATOR = { id: 'acct_admin', email: 'admin@example.test' };

let store: AutomationStore;
let deps: CreateAutomationDeps;

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createAutomationStore(client, () => NOW);
	deps = {
		store,
		resolveProject: async (id) => (id === PROJECT.id ? PROJECT : undefined),
		getIssue: async (_project, issue_id) =>
			issue_id === 'bw-1' ? ({ id: 'bw-1' } as IssueDetail) : undefined,
		now: () => NOW
	};
});

function request(overrides: Partial<CreateAutomationRequest> = {}): CreateAutomationRequest {
	return {
		project_id: PROJECT.id,
		name: 'Nightly build',
		cron: '0 2 * * *',
		time_zone: 'Europe/London',
		overlap: 'skip',
		launch: { operation: 'loop', mode: 'build', issue_id: 'bw-1', max_iterations: 10 },
		...overrides
	};
}

describe('checkSchedule', () => {
	it('lists the next five fire times', () => {
		const check = checkSchedule('0 2 * * *', 'UTC', NOW);
		expect(check.ok && check.upcoming.map((slot) => slot.toISOString())).toEqual([
			'2026-11-12T02:00:00.000Z',
			'2026-11-13T02:00:00.000Z',
			'2026-11-14T02:00:00.000Z',
			'2026-11-15T02:00:00.000Z',
			'2026-11-16T02:00:00.000Z'
		]);
	});

	it('refuses a bad expression, an unknown zone and a schedule that never fires', () => {
		expect(checkSchedule('61 * * * *', 'UTC', NOW).ok).toBe(false);
		expect(checkSchedule('0 2 * * *', 'Mars/Olympus', NOW)).toEqual({
			ok: false,
			message: UNKNOWN_TIME_ZONE_MESSAGE
		});
		expect(checkSchedule('0 0 30 2 *', 'UTC', NOW)).toEqual({
			ok: false,
			message: NEVER_FIRES_MESSAGE
		});
	});
});

describe('createAutomation', () => {
	it('stores the launch as its mission payload, on behalf of the creator', async () => {
		const result = await createAutomation(request({ provider: 'e2b' }), CREATOR, deps);
		expect(result.ok).toBe(true);
		const saved = await store.get(result.ok ? result.automation.id : '');
		expect(saved).toMatchObject({
			project_id: PROJECT.id,
			name: 'Nightly build',
			provider: 'e2b',
			created_by: 'acct_admin',
			enabled: true,
			payload: { operation: 'loop', mode: 'build', issue_id: 'bw-1', max_iterations: 10 }
		});
	});

	it('writes a comment as the creator until the fire replaces the author', async () => {
		const result = await createAutomation(
			request({ launch: { operation: 'comment', issue_id: 'bw-1', text: 'Weekly check-in' } }),
			CREATOR,
			deps
		);
		expect(result.ok && result.automation.payload).toEqual({
			operation: 'comment',
			issue_id: 'bw-1',
			text: 'Weekly check-in',
			author: CREATOR.email
		});
	});

	it('refuses a schedule, project or bead that would only ever fail', async () => {
		expect(await createAutomation(request({ cron: '0 0 30 2 *' }), CREATOR, deps)).toEqual({
			ok: false,
			code: 'bad_request',
			message: NEVER_FIRES_MESSAGE
		});
		expect(await createAutomation(request({ project_id: 'd_gone' }), CREATOR, deps)).toMatchObject({
			ok: false,
			code: 'not_found',
			message: 'project not found'
		});
		expect(
			await createAutomation(
				request({ launch: { operation: 'tackle', issue_id: 'bw-404' } }),
				CREATOR,
				deps
			)
		).toMatchObject({ ok: false, code: 'not_found', message: 'issue not found' });
		expect(await store.list()).toEqual([]);
	});

	it('needs no bead for a plan loop or a File', async () => {
		const plan = await createAutomation(
			request({ launch: { operation: 'loop', mode: 'plan', max_iterations: 3 } }),
			CREATOR,
			deps
		);
		expect(plan.ok).toBe(true);
	});
});

describe('automationView', () => {
	it('shows the launch shape and next run, never the launch text or creator id', async () => {
		const result = await createAutomation(
			request({
				launch: { operation: 'loop', mode: 'run', prompt: 'Secret task', max_iterations: 2 }
			}),
			CREATOR,
			deps
		);
		if (!result.ok) throw new Error('not created');
		const view = automationView(result.automation, { project_name: 'Beads web', now: NOW });
		expect(view).toMatchObject({
			project_name: 'Beads web',
			launch: { operation: 'loop', loop: { mode: 'run', max_iterations: 2 } },
			next_run: '2026-11-12T02:00:00.000Z',
			enabled: true,
			overlap: 'skip'
		});
		expect(JSON.stringify(view)).not.toContain('Secret task');
		expect(JSON.stringify(view)).not.toContain('acct_admin');
	});

	it('has no next run while paused, and falls back to the project id', async () => {
		const result = await createAutomation(request(), CREATOR, deps);
		if (!result.ok) throw new Error('not created');
		const paused = await store.setEnabled(result.automation.id, false);
		const view = automationView(paused!, { now: NOW });
		expect(view.next_run).toBeUndefined();
		expect(view.project_name).toBe(PROJECT.id);
		expect(automationUpcoming(paused!, NOW, 5)).toEqual([]);
	});
});
