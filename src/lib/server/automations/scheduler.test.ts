import { createClient, type Client } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IssueDetail, Project } from '#lib/types.js';
import type { EnqueueDispatchInput } from '../dispatch/service.js';
import { DispatchError, type DispatchRecord } from '../dispatch/types.js';
import { initStateSchema } from '../state/db.js';
import {
	ALREADY_QUEUED_MESSAGE,
	automationIdempotencyKey,
	automationTick,
	CREATOR_NOT_ADMIN_MESSAGE,
	dueSlot,
	fireAutomationSlot,
	PREVIOUS_RUNNING_MESSAGE,
	type AutomationTickDeps
} from './scheduler.js';
import {
	createAutomationStore,
	type AutomationStore,
	type CreateAutomationInput
} from './store.js';

const PROJECT: Project = {
	id: 'd_beads_web',
	name: 'beads_web',
	dolt_database: 'beads_web'
} as Project;

/** A dispatch service stand-in: idempotent by key, refuses when disarmed. */
class FakeDispatch {
	records = new Map<string, DispatchRecord>();
	enqueued: EnqueueDispatchInput[] = [];
	armed = true;

	async get(id: string) {
		return this.records.get(id);
	}

	async getByIdempotencyKey(key: string) {
		return [...this.records.values()].find((record) => record.idempotency_key === key);
	}

	async enqueue(input: EnqueueDispatchInput) {
		if (!this.armed) throw new DispatchError('forbidden', 'Agent dispatch is disarmed.');
		const existing = await this.getByIdempotencyKey(input.idempotency_key);
		if (existing !== undefined) return { request: { id: existing.id }, created: false };
		this.enqueued.push(input);
		const id = `dq_${this.records.size + 1}`;
		this.records.set(id, {
			id,
			idempotency_key: input.idempotency_key,
			project_id: input.project.id,
			dolt_database: input.project.dolt_database,
			operation: input.payload.operation,
			actor: input.actor,
			payload: input.payload,
			status: 'running',
			generation: 0,
			created_at: '',
			updated_at: ''
		});
		return { request: { id }, created: true };
	}

	finishAll() {
		for (const record of this.records.values()) record.status = 'succeeded';
	}
}

let client: Client;
let clock: Date;
let dispatch: FakeDispatch;
let role: 'admin' | 'member';

function deps(
	store: AutomationStore = createAutomationStore(client, () => clock)
): AutomationTickDeps {
	return {
		store,
		dispatch,
		enqueue: (input) => dispatch.enqueue(input),
		resolveProject: async (id) => (id === PROJECT.id ? PROJECT : undefined),
		getIssue: async (_project, issue_id) =>
			issue_id === 'beads-1' ? ({ id: issue_id, title: 'One' } as IssueDetail) : undefined,
		creator: async (id) =>
			id === 'acct_admin' ? { email: 'admin@example.com', role, banned: false } : undefined,
		now: () => clock
	};
}

const LOOP: CreateAutomationInput = {
	project_id: PROJECT.id,
	name: 'Nightly build',
	cron: '* * * * *',
	time_zone: 'UTC',
	payload: { operation: 'loop', mode: 'build', max_iterations: 5 },
	overlap: 'skip',
	created_by: 'acct_admin'
};

async function create(input: Partial<CreateAutomationInput> = {}) {
	return createAutomationStore(client, () => clock).create({ ...LOOP, ...input });
}

async function runs(store_deps: AutomationTickDeps, id: string) {
	return (await store_deps.store.listRuns(id, 100)).map((run) => [run.slot, run.outcome]);
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	clock = new Date('2026-11-11T01:59:30Z');
	dispatch = new FakeDispatch();
	role = 'admin';
});

describe('dueSlot', () => {
	it('is the latest slot after the cursor, and nothing before creation', async () => {
		const automation = await create({ cron: '0 2 * * *' });
		expect(dueSlot(automation, new Date('2026-11-11T01:59:59Z'))).toBeUndefined();
		expect(dueSlot(automation, new Date('2026-11-11T02:00:00Z'))).toBe('2026-11-11T02:00:00.000Z');
		// Days later, still only the latest slot: no catch-up storm.
		expect(dueSlot(automation, new Date('2026-11-14T09:00:00Z'))).toBe('2026-11-14T02:00:00.000Z');
		expect(
			dueSlot(
				{ ...automation, last_slot: '2026-11-14T02:00:00.000Z' },
				new Date('2026-11-14T09:00Z')
			)
		).toBeUndefined();
	});
});

describe('automationTick', () => {
	it('fires an every-minute automation once per slot across a restart', async () => {
		const automation = await create();
		const first = deps();

		clock = new Date('2026-11-11T02:00:10Z');
		await automationTick(first);
		await automationTick(first);
		dispatch.finishAll();
		// A restart: a fresh store over the same database.
		const restarted = deps();
		clock = new Date('2026-11-11T02:00:50Z');
		await automationTick(restarted);
		expect(dispatch.enqueued).toHaveLength(1);

		clock = new Date('2026-11-11T02:01:05Z');
		await automationTick(restarted);
		expect(dispatch.enqueued.map((input) => input.idempotency_key)).toEqual([
			automationIdempotencyKey(automation.id, '2026-11-11T02:00:00.000Z'),
			automationIdempotencyKey(automation.id, '2026-11-11T02:01:00.000Z')
		]);
		expect(dispatch.enqueued[0]?.actor).toBe(`automation:${automation.id} for admin@example.com`);
		expect(dispatch.enqueued[0]?.payload).toEqual(LOOP.payload);
		expect(await runs(restarted, automation.id)).toEqual([
			['2026-11-11T02:01:00.000Z', 'fired'],
			['2026-11-11T02:00:00.000Z', 'fired']
		]);
	});

	it('fires the latest missed slot once after downtime', async () => {
		const automation = await create();
		clock = new Date('2026-11-11T02:30:10Z');
		await automationTick(deps());
		expect(await runs(deps(), automation.id)).toEqual([['2026-11-11T02:30:00.000Z', 'fired']]);
	});

	it('skips a slot while the previous mission is still running', async () => {
		const automation = await create();
		clock = new Date('2026-11-11T02:00:10Z');
		await automationTick(deps());
		clock = new Date('2026-11-11T02:01:10Z');
		await automationTick(deps());
		expect(dispatch.enqueued).toHaveLength(1);
		const [latest] = await deps().store.listRuns(automation.id, 1);
		expect(latest).toMatchObject({ outcome: 'skipped', message: PREVIOUS_RUNNING_MESSAGE });

		dispatch.finishAll();
		clock = new Date('2026-11-11T02:02:10Z');
		await automationTick(deps());
		expect(dispatch.enqueued).toHaveLength(2);
	});

	it('queues one slot behind a running mission when asked to', async () => {
		const automation = await create({ overlap: 'queue' });
		for (const at of ['02:00:10', '02:01:10', '02:02:10']) {
			clock = new Date(`2026-11-11T${at}Z`);
			await automationTick(deps());
		}
		const [skipped] = await deps().store.listRuns(automation.id, 1);
		expect(skipped?.message).toBe(ALREADY_QUEUED_MESSAGE);
		expect(await runs(deps(), automation.id)).toEqual([
			['2026-11-11T02:02:00.000Z', 'skipped'],
			['2026-11-11T02:01:00.000Z', 'queued'],
			['2026-11-11T02:00:00.000Z', 'fired']
		]);

		dispatch.finishAll();
		await automationTick(deps());
		expect(dispatch.enqueued.map((input) => input.idempotency_key)).toEqual([
			automationIdempotencyKey(automation.id, '2026-11-11T02:00:00.000Z'),
			automationIdempotencyKey(automation.id, '2026-11-11T02:01:00.000Z')
		]);
	});

	it('records refusals and stops firing while dispatch is disarmed', async () => {
		const automation = await create();
		dispatch.armed = false;
		clock = new Date('2026-11-11T02:00:10Z');
		await automationTick(deps());
		expect(dispatch.enqueued).toHaveLength(0);
		const [refused] = await deps().store.listRuns(automation.id, 1);
		expect(refused).toMatchObject({ outcome: 'refused', message: 'Agent dispatch is disarmed.' });

		dispatch.armed = true;
		clock = new Date('2026-11-11T02:01:10Z');
		await automationTick(deps());
		expect(dispatch.enqueued).toHaveLength(1);
	});

	it('pauses an automation whose creator is no longer an admin', async () => {
		const automation = await create();
		role = 'member';
		clock = new Date('2026-11-11T02:00:10Z');
		await automationTick(deps());
		const paused = await deps().store.get(automation.id);
		expect(paused).toMatchObject({ enabled: false, paused_reason: CREATOR_NOT_ADMIN_MESSAGE });
		expect(dispatch.enqueued).toHaveLength(0);

		// Paused automations claim no further slots.
		role = 'admin';
		clock = new Date('2026-11-11T02:05:10Z');
		await automationTick(deps());
		expect(await runs(deps(), automation.id)).toEqual([['2026-11-11T02:00:00.000Z', 'refused']]);
	});

	it('finishes a slot a crash left firing, without launching twice', async () => {
		const automation = await create();
		const store = createAutomationStore(client, () => clock);
		clock = new Date('2026-11-11T02:00:10Z');
		// Crash after the claim and before the launch.
		expect(await store.claimSlot(automation.id, '2026-11-11T02:00:00.000Z', 'schedule')).toBe(true);
		// Crash after the launch and before the outcome was written.
		expect(await store.claimSlot(automation.id, '2026-11-11T01:00:00.000Z', 'schedule')).toBe(true);
		await dispatch.enqueue({
			idempotency_key: automationIdempotencyKey(automation.id, '2026-11-11T01:00:00.000Z'),
			project: PROJECT,
			actor: 'x',
			payload: LOOP.payload
		});
		dispatch.finishAll();

		await automationTick(deps(store));
		expect(dispatch.enqueued).toHaveLength(2);
		expect(await runs(deps(), automation.id)).toEqual([
			['2026-11-11T02:00:00.000Z', 'fired'],
			['2026-11-11T01:00:00.000Z', 'fired']
		]);
	});

	it('fails a slot whose project or issue is gone', async () => {
		const gone = await create({ project_id: 'd_gone' });
		const tackle = await create({
			name: 'Tackle',
			payload: { operation: 'tackle', issue_id: 'beads-404' }
		});
		clock = new Date('2026-11-11T02:00:10Z');
		await automationTick(deps());
		expect((await deps().store.listRuns(gone.id, 1))[0]?.outcome).toBe('failed');
		expect((await deps().store.listRuns(tackle.id, 1))[0]?.outcome).toBe('failed');
		expect(dispatch.enqueued).toHaveLength(0);
	});

	it('passes the issue and writes a comment as the automation', async () => {
		await create({
			cron: '0 9 * * *',
			payload: { operation: 'comment', issue_id: 'beads-1', text: 'Daily triage', author: '' }
		});
		clock = new Date('2026-11-12T09:00:10Z');
		await automationTick(deps());
		const [input] = dispatch.enqueued;
		expect(input?.issue?.id).toBe('beads-1');
		expect(input?.payload).toMatchObject({ operation: 'comment', author: input?.actor });
	});
});

describe('fireAutomationSlot', () => {
	it('runs now even while the previous mission is running, and never twice per slot', async () => {
		const automation = await create();
		clock = new Date('2026-11-11T02:00:10Z');
		await automationTick(deps());
		const manual = await fireAutomationSlot(automation, clock.toISOString(), 'manual', deps());
		expect(manual).toMatchObject({ trigger: 'manual', outcome: 'fired' });
		expect(await fireAutomationSlot(automation, clock.toISOString(), 'manual', deps())).toBe(
			undefined
		);
		expect(dispatch.enqueued).toHaveLength(2);
		// A manual run leaves the schedule's cursor where it was.
		expect((await deps().store.get(automation.id))?.last_slot).toBe('2026-11-11T02:00:00.000Z');
	});
});
