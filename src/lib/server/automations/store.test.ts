import { createClient, type Client } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { AUTOMATION_RUNS_KEPT, createAutomationStore, type AutomationStore } from './store.js';

let client: Client;
let clock: Date;
let store: AutomationStore;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	clock = new Date('2026-11-11T12:00:00Z');
	store = createAutomationStore(client, () => clock);
});

async function create(name = 'Nightly') {
	return store.create({
		project_id: 'd_beads_web',
		name,
		cron: '0 2 * * *',
		time_zone: 'Europe/London',
		provider: 'e2b',
		payload: { operation: 'loop', mode: 'plan', max_iterations: 3 },
		overlap: 'queue',
		created_by: 'acct_admin'
	});
}

describe('automation store', () => {
	it('creates an enabled automation whose cursor starts at creation', async () => {
		const automation = await create();
		expect(automation).toMatchObject({
			id: expect.stringMatching(/^au_[a-f0-9]{32}$/),
			provider: 'e2b',
			payload: { operation: 'loop', mode: 'plan', max_iterations: 3 },
			overlap: 'queue',
			enabled: true,
			last_slot: '2026-11-11T12:00:00.000Z'
		});
		expect(await store.list({ project_id: 'd_other' })).toEqual([]);
		expect(await store.listEnabled()).toHaveLength(1);
	});

	it('pauses with a reason and re-enables from now', async () => {
		const automation = await create();
		const paused = await store.setEnabled(automation.id, false, 'Paused by hand.');
		expect(paused).toMatchObject({ enabled: false, paused_reason: 'Paused by hand.' });
		expect(await store.listEnabled()).toEqual([]);

		clock = new Date('2026-11-20T08:00:00Z');
		const resumed = await store.setEnabled(automation.id, true);
		expect(resumed?.enabled).toBe(true);
		expect(resumed?.paused_reason).toBeUndefined();
		expect(resumed?.last_slot).toBe('2026-11-20T08:00:00.000Z');
	});

	it('claims a slot once and keeps the cursor moving forward only', async () => {
		const automation = await create();
		expect(await store.claimSlot(automation.id, '2026-11-12T02:00:00.000Z', 'schedule')).toBe(true);
		expect(await store.claimSlot(automation.id, '2026-11-12T02:00:00.000Z', 'schedule')).toBe(
			false
		);
		await store.claimSlot(automation.id, '2026-11-11T13:00:00.000Z', 'schedule');
		expect((await store.get(automation.id))?.last_slot).toBe('2026-11-12T02:00:00.000Z');
		expect((await store.listPending()).map((run) => run.slot)).toEqual([
			'2026-11-11T13:00:00.000Z',
			'2026-11-12T02:00:00.000Z'
		]);

		await store.resolveRun(automation.id, '2026-11-12T02:00:00.000Z', {
			outcome: 'fired',
			mission_id: 'dq_1'
		});
		expect(await store.latestMissionRun(automation.id)).toMatchObject({ mission_id: 'dq_1' });
		expect(await store.latestMissionRun(automation.id, '2026-11-12T02:00:00.000Z')).toBeUndefined();
	});

	it(`keeps the newest ${AUTOMATION_RUNS_KEPT} runs`, async () => {
		const automation = await create();
		const base = Date.parse('2026-11-11T12:00:00Z');
		for (let i = 0; i <= AUTOMATION_RUNS_KEPT; i += 1) {
			await store.claimSlot(automation.id, new Date(base + i * 60_000).toISOString(), 'schedule');
		}
		const runs = await store.listRuns(automation.id, AUTOMATION_RUNS_KEPT + 10);
		expect(runs).toHaveLength(AUTOMATION_RUNS_KEPT);
		expect(runs.at(-1)?.slot).toBe(new Date(base + 60_000).toISOString());
	});

	it('edits in place, keeping its history and moving the cursor to now', async () => {
		const automation = await create();
		await store.claimSlot(automation.id, '2026-11-12T02:00:00.000Z', 'schedule');
		clock = new Date('2026-11-12T09:00:00Z');
		const edited = await store.update(automation.id, {
			name: 'Morning',
			cron: '0 6 * * *',
			time_zone: 'UTC',
			overlap: 'skip',
			payload: { operation: 'loop', mode: 'plan', max_iterations: 7 }
		});
		expect(edited).toMatchObject({
			name: 'Morning',
			cron: '0 6 * * *',
			time_zone: 'UTC',
			overlap: 'skip',
			provider: 'e2b',
			created_by: 'acct_admin',
			payload: { operation: 'loop', mode: 'plan', max_iterations: 7 },
			last_slot: '2026-11-12T09:00:00.000Z',
			updated_at: '2026-11-12T09:00:00.000Z'
		});
		expect(await store.listRuns(automation.id, 10)).toHaveLength(1);
		expect(
			await store.update('au_missing', {
				name: 'x',
				cron: '* * * * *',
				time_zone: 'UTC',
				overlap: 'skip',
				payload: { operation: 'loop', mode: 'plan', max_iterations: 1 }
			})
		).toBeUndefined();
	});

	it('removes an automation with its history', async () => {
		const automation = await create();
		await store.claimSlot(automation.id, '2026-11-12T02:00:00.000Z', 'schedule');
		expect(await store.remove(automation.id)).toBe(true);
		expect(await store.get(automation.id)).toBeUndefined();
		expect(await store.listRuns(automation.id, 10)).toEqual([]);
		expect(await store.remove(automation.id)).toBe(false);
	});
});
