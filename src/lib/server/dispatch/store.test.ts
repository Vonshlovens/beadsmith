import { type Client, createClient } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import type { RalphIteration } from './ralph.js';
import { createDispatchStore, runClaimOf } from './store.js';
import { DispatchError } from './types.js';

let client: Client;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	await initStateSchema(client);
});

const baseInput = {
	idempotency_key: 'idem-aaaaaaaa',
	project_id: 'd_beads_web',
	dolt_database: 'beads_web',
	operation: 'file' as const,
	actor: 'owner@example.com',
	payload: { operation: 'file' as const, notes: 'File the login bug.' }
};

describe('createDispatchStore', () => {
	it('inserts a queued record', async () => {
		const store = createDispatchStore(client);
		const { record, created } = await store.create(baseInput);

		expect(created).toBe(true);
		expect(record.status).toBe('queued');
		expect(record.id).toMatch(/^dq_[a-f0-9]{32}$/);
		expect(record.payload).toEqual(baseInput.payload);
	});

	it('replays the same idempotency key and payload', async () => {
		const store = createDispatchStore(client);
		const first = await store.create(baseInput);
		const second = await store.create(baseInput);

		expect(second.created).toBe(false);
		expect(second.record.id).toBe(first.record.id);
	});

	it('rejects the same key with a different payload', async () => {
		const store = createDispatchStore(client);
		await store.create(baseInput);

		await expect(
			store.create({
				...baseInput,
				payload: { operation: 'file', notes: 'A different request.' }
			})
		).rejects.toBeInstanceOf(DispatchError);
	});

	it('updates launch status without dropping the payload', async () => {
		const store = createDispatchStore(client);
		const { record } = await store.create(baseInput);
		const updated = await store.updateStatus(record.id, {
			status: 'launched',
			agent_id: 'bc-test',
			agent_url: 'https://runner.example.com/agents/bc-test'
		});

		expect(updated?.status).toBe('launched');
		expect(updated?.agent_id).toBe('bc-test');
		expect(updated?.payload).toEqual(baseInput.payload);
	});

	it('lists recent records newest first and filters by issue', async () => {
		const store = createDispatchStore(client);
		await store.create({
			...baseInput,
			idempotency_key: 'idem-file-1',
			now: () => new Date('2026-08-25T01:00:00.000Z')
		});
		await store.create({
			...baseInput,
			idempotency_key: 'idem-tackle-old',
			operation: 'tackle',
			payload: {
				operation: 'tackle',
				issue_id: 'beads-web-s42.3',
				title: 'Missions view'
			},
			now: () => new Date('2026-08-25T02:00:00.000Z')
		});
		await store.create({
			...baseInput,
			idempotency_key: 'idem-tackle-new',
			project_id: 'd_other',
			dolt_database: 'other',
			operation: 'tackle',
			payload: { operation: 'tackle', issue_id: 'beads-web-s42.3' },
			now: () => new Date('2026-08-25T03:00:00.000Z')
		});

		await store.create({
			...baseInput,
			idempotency_key: 'idem-comment-1',
			operation: 'comment',
			payload: {
				operation: 'comment',
				issue_id: 'beads-web-s42.3',
				text: 'private comment body',
				author: 'owner@example.com'
			},
			now: () => new Date('2026-08-25T03:30:00.000Z')
		});

		const all = await store.list({ limit: 10 });
		expect(all.map((row) => row.idempotency_key)).toEqual([
			'idem-comment-1',
			'idem-tackle-new',
			'idem-tackle-old',
			'idem-file-1'
		]);

		const for_issue = await store.list({
			issue_id: 'beads-web-s42.3',
			limit: 10
		});
		expect(for_issue).toHaveLength(3);
		expect(
			for_issue.every(
				(row) => row.payload.operation === 'tackle' || row.payload.operation === 'comment'
			)
		).toBe(true);

		const for_project = await store.list({
			project_id: 'd_beads_web',
			limit: 10
		});
		expect(for_project).toHaveLength(3);
		expect(for_project.every((row) => row.project_id === 'd_beads_web')).toBe(true);
	});

	it('persists terminal run metadata', async () => {
		const store = createDispatchStore(client);
		const { record } = await store.create(baseInput);

		const updated = await store.updateStatus(record.id, {
			status: 'succeeded',
			result_summary: 'Completed the requested work.',
			duration_ms: 12_345,
			git_pr_url: 'https://github.com/example-org/beads-web/pull/42'
		});

		expect(updated).toMatchObject({
			status: 'succeeded',
			result_summary: 'Completed the requested work.',
			duration_ms: 12_345,
			git_pr_url: 'https://github.com/example-org/beads-web/pull/42'
		});
	});

	it('does not regress a terminal record to an in-flight status', async () => {
		const store = createDispatchStore(client);
		const { record } = await store.create(baseInput);
		await store.updateStatus(record.id, { status: 'succeeded' });
		const stale = await store.updateStatus(record.id, { status: 'running' });
		const enriched = await store.updateStatus(record.id, {
			status: 'succeeded',
			result_summary: 'Late terminal metadata.'
		});

		expect(stale?.status).toBe('succeeded');
		expect(enriched).toMatchObject({
			status: 'succeeded',
			result_summary: 'Late terminal metadata.'
		});
	});

	it('starts a follow-up run from a terminal record', async () => {
		const store = createDispatchStore(client);
		const { record } = await store.create(baseInput);
		await store.updateStatus(record.id, {
			status: 'succeeded',
			agent_id: 'bc-1',
			run_id: 'run-1'
		});

		const resumed = await store.startFollowUp(record.id, {
			run_id: 'run-2',
			status: 'launched'
		});
		expect(resumed).toMatchObject({
			status: 'launched',
			agent_id: 'bc-1',
			run_id: 'run-2'
		});
	});

	it('does not start a follow-up while the mission is still in flight', async () => {
		const store = createDispatchStore(client);
		const { record } = await store.create(baseInput);
		await store.updateStatus(record.id, {
			status: 'running',
			agent_id: 'bc-1',
			run_id: 'run-1'
		});

		const resumed = await store.startFollowUp(record.id, {
			run_id: 'run-2',
			status: 'launched'
		});
		expect(resumed).toBeUndefined();
		expect((await store.get(record.id))?.status).toBe('running');
		expect((await store.get(record.id))?.run_id).toBe('run-1');
	});

	it('refuses a status write for a run claim the mission has left', async () => {
		const store = createDispatchStore(client);
		const { record } = await store.create(baseInput);
		const running = (await store.updateStatus(record.id, {
			status: 'running',
			agent_id: 'bc-1',
			run_id: 'run-1'
		}))!;
		expect(running.generation).toBe(0);
		const old_claim = runClaimOf(running);
		await store.updateStatus(record.id, { status: 'succeeded' });

		// A restart claim keeps the run id but moves to a new generation.
		const claimed = await store.startFollowUp(record.id, { run_id: 'run-1', status: 'launching' });
		expect(claimed?.generation).toBe(1);
		expect(
			await store.updateStatus(record.id, { status: 'succeeded', expect: old_claim })
		).toBeUndefined();
		expect((await store.get(record.id))?.status).toBe('launching');

		// The claim's own write lands, and the old run's still does not.
		const saved = await store.updateStatus(record.id, {
			status: 'launched',
			agent_id: 'bc-2',
			run_id: 'run-2',
			expect: runClaimOf(claimed!)
		});
		expect(saved).toMatchObject({ status: 'launched', agent_id: 'bc-2', run_id: 'run-2' });
		expect(
			await store.updateStatus(record.id, { status: 'succeeded', expect: old_claim })
		).toBeUndefined();
		expect((await store.get(record.id))?.status).toBe('launched');
	});

	it('still reads back a write the terminal guard refused on the current claim', async () => {
		const store = createDispatchStore(client);
		const { record } = await store.create(baseInput);
		const running = (await store.updateStatus(record.id, {
			status: 'running',
			agent_id: 'bc-1',
			run_id: 'run-1'
		}))!;
		await store.updateStatus(record.id, { status: 'cancelled' });
		const read = await store.updateStatus(record.id, {
			status: 'failed',
			expect: runClaimOf(running)
		});
		expect(read?.status).toBe('cancelled');
	});
});

describe('dispatch turns', () => {
	it('keeps turns in order per mission and ignores a second reply for one run', async () => {
		const store = createDispatchStore(client);
		const { record } = await store.create(baseInput);
		const { record: other } = await store.create({
			...baseInput,
			idempotency_key: 'idem-bbbbbbbb'
		});

		await store.appendTurn(record.id, { role: 'operator', text: 'File the login bug.' });
		await store.appendTurn(record.id, {
			role: 'agent',
			text: 'Filed beads-web-9.',
			run_id: 'run-1',
			status: 'succeeded'
		});
		await store.appendTurn(record.id, {
			role: 'agent',
			text: 'Duplicate poll of the same run.',
			run_id: 'run-1',
			status: 'succeeded'
		});
		await store.appendTurn(record.id, { role: 'operator', text: 'Add a repro.', run_id: 'run-2' });
		await store.appendTurn(record.id, { role: 'operator', text: '   ' });
		await store.appendTurn(other.id, { role: 'operator', text: 'Other mission.' });

		const turns = await store.listTurns(record.id);
		expect(turns.map((turn) => [turn.role, turn.text, turn.run_id, turn.status])).toEqual([
			['operator', 'File the login bug.', undefined, undefined],
			['agent', 'Filed beads-web-9.', 'run-1', 'succeeded'],
			['operator', 'Add a repro.', 'run-2', undefined]
		]);
		expect(turns[0]!.seq).toBeLessThan(turns[1]!.seq);
		expect(await store.listTurns(other.id)).toHaveLength(1);
	});

	it('caps turn text', async () => {
		const store = createDispatchStore(client);
		const { record } = await store.create(baseInput);
		await store.appendTurn(record.id, { role: 'operator', text: 'x'.repeat(20_000) });
		const [turn] = await store.listTurns(record.id);
		expect(turn!.text).toHaveLength(8000);
	});
});

describe('loop iterations', () => {
	const FIRST: RalphIteration = {
		iteration: 1,
		outcome: 'completed',
		started_at: '2026-11-11T10:00:00.000Z',
		finished_at: '2026-11-11T10:05:00.000Z',
		duration_ms: 300_000,
		head_before: 'aaaaaaa',
		head_after: 'bbbbbbb',
		input_tokens: 1200,
		output_tokens: 300,
		cost_usd: 0.42,
		validate_ok: false,
		plan_open: 0
	};

	it('keeps a restarted loop’s earlier run and ignores repeats', async () => {
		const store = createDispatchStore(client);
		const restarted: RalphIteration = {
			...FIRST,
			started_at: '2026-11-11T11:00:00.000Z',
			finished_at: '2026-11-11T11:02:00.000Z',
			outcome: 'timed_out'
		};

		await store.recordLoopIterations('dq_1', 'run-a', [FIRST]);
		await store.recordLoopIterations('dq_1', 'run-a', [{ ...FIRST, outcome: 'failed' }]);
		await store.recordLoopIterations('dq_1', 'run-b', [restarted]);
		await store.recordLoopIterations('dq_1', 'run-b', []);
		await store.recordLoopIterations('dq_other', 'run-c', [FIRST]);

		expect(await store.listLoopIterations('dq_1')).toEqual([
			{ ...FIRST, run_id: 'run-a' },
			{ ...restarted, run_id: 'run-b' }
		]);
	});

	it('keeps how a loop run ended until a restart starts a new run', async () => {
		const store = createDispatchStore(client);
		const { record } = await store.create(baseInput);
		await store.updateStatus(record.id, { status: 'running', agent_id: 'sbx-1', run_id: 'run-a' });
		expect((await store.get(record.id))!.loop_end).toBeUndefined();

		await store.updateStatus(record.id, {
			status: 'succeeded',
			loop_end: { stop_reason: 'no_progress', needs_person: true }
		});
		// A later read without loop_end keeps it.
		await store.updateStatus(record.id, { status: 'succeeded', duration_ms: 10 });
		expect((await store.get(record.id))!.loop_end).toEqual({
			stop_reason: 'no_progress',
			needs_person: true
		});

		await store.startFollowUp(record.id, { run_id: 'run-b', status: 'running' });
		expect((await store.get(record.id))!.loop_end).toBeUndefined();

		// ralph recorded no reason: the run still ended.
		await store.updateStatus(record.id, {
			status: 'failed',
			loop_end: { stop_reason: null, needs_person: false }
		});
		expect((await store.get(record.id))!.loop_end).toEqual({
			stop_reason: null,
			needs_person: false
		});
	});
});
