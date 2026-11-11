import { createClient, type Client } from '@libsql/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isCrewNotice } from '#lib/mate.js';
import { createDispatchStore, type DispatchStore } from '../dispatch/store.js';
import type { DispatchRecord } from '../dispatch/types.js';
import { MateRunnerError, type MateMessageInput, type MateRunner } from '../mate/runner.js';
import { createMateStore, type MateStore } from '../mate/store.js';
import { initStateSchema } from '../state/db.js';
import {
	crewNoticeMessageId,
	crewNoticeText,
	deliverCrewNotice,
	deliverDueCrewNotices,
	type CrewNoticeDeps
} from './notices.js';

let client: Client;
let dispatch: DispatchStore;
let mate: MateStore;
let sent: Array<{ chat_id: string; input: MateMessageInput }>;
let runner: MateRunner;
let runner_up: boolean;
let deps: CrewNoticeDeps;

function fakeRunner(): MateRunner {
	// Like the real runners: a repeated message id is accepted, not sent twice.
	const seen = new Set<string>();
	return {
		async sendMessage(chat_id: string, input: MateMessageInput) {
			if (!runner_up) throw new MateRunnerError('unavailable', 'down');
			if (!seen.has(input.message_id)) {
				seen.add(input.message_id);
				sent.push({ chat_id, input });
			}
			return { event_id: `e${sent.length}` };
		},
		streamEvents: vi.fn(),
		interrupt: vi.fn(),
		deleteChat: vi.fn(),
		health: vi.fn()
	} as unknown as MateRunner;
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	dispatch = createDispatchStore(client);
	mate = createMateStore(client);
	sent = [];
	runner_up = true;
	runner = fakeRunner();
	deps = { dispatch, mate, runnerFor: () => runner, log: () => {} };
	await client.execute({
		sql: `INSERT INTO auth_user (id, name, email, role, banned, created_at, updated_at)
			VALUES ('u1', 'u1', 'u1@example.test', 'admin', 0, 0, 0)`,
		args: []
	});
});

async function chatMission(
	chat_id: string | undefined,
	status: 'succeeded' | 'failed' | 'running' = 'succeeded',
	key = 'k1'
): Promise<DispatchRecord> {
	const { record } = await dispatch.create({
		idempotency_key: `crew:${key}`,
		project_id: 'd_web',
		dolt_database: 'web',
		operation: 'tackle',
		actor: 'u1@example.test',
		payload: { operation: 'tackle', issue_id: 'web-12' },
		...(chat_id === undefined ? {} : { chat_id })
	});
	await dispatch.updateStatus(record.id, {
		status: 'launched',
		agent_id: 'agent-1',
		run_id: 'run-1'
	});
	return (await dispatch.updateStatus(record.id, {
		status,
		result_summary: 'Opened a pull request for the login fix.',
		git_pr_url: status === 'succeeded' ? 'https://github.com/o/r/pull/12' : undefined,
		error_message: status === 'failed' ? 'Tests failed.' : undefined
	}))!;
}

describe('deliverCrewNotice', () => {
	it('tells the launching chat once, even when the outcome is observed twice', async () => {
		const chat = await mate.createChat('u1', { title: 't', scope: 'd_web' });
		const record = await chatMission(chat.id);

		expect(await deliverCrewNotice(record, deps)).toBe('sent');
		// The follower and a page refresh both see the same terminal row.
		expect(await deliverCrewNotice(record, deps)).toBe('sent');
		expect(await deliverCrewNotice((await dispatch.get(record.id))!, deps)).toBe('skipped');

		expect(sent).toHaveLength(1);
		const [{ chat_id, input }] = sent;
		expect(chat_id).toBe(chat.id);
		expect(input.session_id).toBe((await mate.getChat('u1', chat.id))!.session_id);
		expect(input.scope).toBe('d_web');
		expect(input.message_id).toBe(crewNoticeMessageId(record, 'succeeded:run-1'));
		expect(input.prompt).toContain('[crew] Tackle on web-12 (d_web) succeeded.');
		expect(input.prompt).toContain('PR: https://github.com/o/r/pull/12.');
		expect(input.prompt).toContain(`Mission ${record.id}`);
		expect((await dispatch.get(record.id))!.chat_notice).toBe('succeeded:run-1');
	});

	it('sends the chat model and effort, which the runner holds the chat to', async () => {
		const chat = await mate.createChat('u1', {
			title: 't',
			scope: null,
			model: 'claude-opus-5-5',
			effort: 'high'
		});
		expect(await deliverCrewNotice(await chatMission(chat.id), deps)).toBe('sent');
		expect(sent[0].input).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
	});

	it('sends nothing after a restart once the outcome was told', async () => {
		const chat = await mate.createChat('u1', { title: 't', scope: null });
		const record = await chatMission(chat.id);
		await deliverCrewNotice(record, deps);
		// A new process: fresh runner state, the durable row is all that is left.
		runner = fakeRunner();
		const reloaded = createDispatchStore(client);
		expect(await deliverDueCrewNotices(chat.id, { ...deps, dispatch: reloaded })).toEqual([]);
		expect(await deliverCrewNotice((await reloaded.get(record.id))!, deps)).toBe('skipped');
		expect(sent).toHaveLength(1);
	});

	it('sends nothing for a mission without a chat or still working', async () => {
		const chat = await mate.createChat('u1', { title: 't', scope: null });
		expect(await deliverCrewNotice(await chatMission(undefined), deps)).toBe('skipped');
		expect(await deliverCrewNotice(await chatMission(chat.id, 'running', 'k2'), deps)).toBe(
			'skipped'
		);
		expect(sent).toEqual([]);
	});

	it('keeps a notice due while the runner is down and delivers it on chat open', async () => {
		const chat = await mate.createChat('u1', { title: 't', scope: null });
		const record = await chatMission(chat.id, 'failed');
		runner_up = false;
		expect(await deliverCrewNotice(record, deps)).toBe('deferred');
		expect((await dispatch.get(record.id))!.chat_notice).toBeUndefined();

		runner_up = true;
		expect(await deliverDueCrewNotices(chat.id, deps)).toEqual(['sent']);
		expect(await deliverDueCrewNotices(chat.id, deps)).toEqual([]);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.input.prompt).toContain('failed. Summary: Tests failed.');
	});

	it('defers when the chat’s runner is not configured', async () => {
		const chat = await mate.createChat('u1', { title: 't', scope: null });
		const record = await chatMission(chat.id);
		expect(await deliverCrewNotice(record, { ...deps, runnerFor: () => undefined })).toBe(
			'deferred'
		);
		expect(await dispatch.listChatNoticesDue(chat.id, 10)).toHaveLength(1);
	});

	it('drops the notice of a deleted chat or a banned owner instead of retrying forever', async () => {
		const chat = await mate.createChat('u1', { title: 't', scope: null });
		const record = await chatMission(chat.id);
		await mate.deleteChat('u1', chat.id);
		expect(await deliverCrewNotice(record, deps)).toBe('dropped');
		expect(await dispatch.listChatNoticesDue(chat.id, 10)).toEqual([]);

		const other = await mate.createChat('u1', { title: 't', scope: null });
		await client.execute("UPDATE auth_user SET banned = 1 WHERE id = 'u1'");
		expect(await deliverCrewNotice(await chatMission(other.id, 'succeeded', 'k3'), deps)).toBe(
			'dropped'
		);
		expect(sent).toEqual([]);
	});

	it('tells a follow-up run’s outcome as a new notice', async () => {
		const chat = await mate.createChat('u1', { title: 't', scope: null });
		const record = await chatMission(chat.id);
		await deliverCrewNotice(record, deps);
		await dispatch.startFollowUp(record.id, { run_id: 'run-2', status: 'launched' });
		const second = (await dispatch.updateStatus(record.id, { status: 'succeeded' }))!;
		expect(await deliverDueCrewNotices(chat.id, deps)).toEqual(['sent']);
		expect(sent.map((item) => item.input.message_id)).toEqual([
			crewNoticeMessageId(record, 'succeeded:run-1'),
			crewNoticeMessageId(second, 'succeeded:run-2')
		]);
	});

	it('marks the stored user event as a crew notice, not the user’s text', async () => {
		const chat = await mate.createChat('u1', { title: 't', scope: null });
		await deliverCrewNotice(await chatMission(chat.id), deps);
		const { input } = sent[0]!;
		// The runner echoes the message back as a `user` event with its id.
		await mate.appendEvents(
			chat.id,
			[
				{ type: 'user', id: 'e1', text: input.prompt, message_id: input.message_id },
				{ type: 'user', id: 'e2', text: 'what is ready?', message_id: 'b6c1f0de-1' }
			],
			'runner'
		);
		const events = await mate.listEvents(chat.id, { limit: 10 });
		expect(events.map(isCrewNotice)).toEqual([true, false]);
	});
});

describe('crewNoticeText', () => {
	it('names a File mission by project and keeps the summary to one bounded line', async () => {
		const { record } = await dispatch.create({
			idempotency_key: 'crew:file',
			project_id: 'd_web',
			dolt_database: 'web',
			operation: 'file',
			actor: 'u1@example.test',
			payload: { operation: 'file', notes: 'File it.' },
			chat_id: 'mc_x'
		});
		const text = crewNoticeText({
			...record,
			status: 'succeeded',
			result_summary: `Filed web-40.\n\n${'x'.repeat(1000)}`
		});
		expect(text.startsWith('[crew] File in d_web succeeded. Summary: Filed web-40. x')).toBe(true);
		expect(text).not.toContain('\n');
		expect(text.length).toBeLessThan(500);
		expect(text.endsWith('Tell the captain.')).toBe(true);
	});
});
