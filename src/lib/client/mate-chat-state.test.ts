import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from './api.js';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/env', () => ({ browser: true }));
// Unknown dispatch health: every mission counts as followed.
vi.mock('#lib/client/projects.svelte.js', () => ({ statusSnapshot: () => null }));

// Exercise the state machine without a DOM. Svelte's field initializers are
// identities here; rendering/reactive scheduling still needs browser QA.
vi.stubGlobal('$state', <T>(value: T) => value);
const { mate_chats: chats, CHAT_MISSION_POLL_MS } = await import('./mate-chat.svelte.js');
const { STREAM_GRACE_MS, STREAM_SETTLE_MS, streamRetryDelay } = await import('./mate-chat.js');

class FakeSource {
	static CLOSED = 2;
	static instances: FakeSource[] = [];
	readyState = 1;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onopen: (() => void) | null = null;
	listeners: Record<string, (event: { data: string }) => void> = {};
	constructor(readonly url: string) {
		FakeSource.instances.push(this);
	}
	addEventListener(type: string, listener: (event: { data: string }) => void) {
		this.listeners[type] = listener;
	}
	close() {
		this.readyState = 2;
	}
}
const chat = {
	id: 'mc_test',
	title: 'Test',
	scope: null,
	runner: 'remote' as const,
	created_at: '2026-01-01',
	updated_at: '2026-01-01'
};

beforeEach(() => {
	vi.stubGlobal('EventSource', FakeSource);
	FakeSource.instances = [];
	chats.close();
	chats.pending_by_chat = {};
	chats.drafts = {};
	chats.status = { connected: true, reachable: true };
	vi.spyOn(api, 'mateChat').mockResolvedValue({ chat, events: [] });
	vi.spyOn(api, 'mateChatMissions').mockResolvedValue({ missions: [] });
});
afterEach(() => {
	chats.close();
	vi.restoreAllMocks();
});

it('retries a failed detail load in place and follows the stream', async () => {
	vi.mocked(api.mateChat).mockRejectedValueOnce(new Error('offline'));
	await chats.open(chat.id);
	expect(chats.open_error).toBeTruthy();
	await chats.open(chat.id);
	expect(api.mateChat).toHaveBeenCalledTimes(2);
	expect(chats.open_error).toBeNull();
	expect(FakeSource.instances).toHaveLength(1);
});

it('reconnects a closed stream and ignores queued events from the old source', async () => {
	await chats.open(chat.id);
	const old = FakeSource.instances[0]!;
	old.close();
	old.onerror!();
	await chats.open(chat.id);
	expect(FakeSource.instances).toHaveLength(2);
	old.onmessage!({ data: JSON.stringify({ type: 'assistant', id: 'stale', text: 'wrong chat' }) });
	expect(chats.events).toEqual([]);
});

it('keeps a failed send identity when retrying the chat connection', async () => {
	await chats.open(chat.id);
	vi.spyOn(api, 'sendMateMessage')
		.mockRejectedValueOnce(new Error('offline'))
		.mockResolvedValue({ event_id: 'e1' });
	await chats.send(chat.id, 'hello', 'same-message');
	const source = FakeSource.instances[0]!;
	source.close();
	source.onerror!();
	await chats.open(chat.id);
	expect(chats.pending[0]?.message_id).toBe('same-message');
	await chats.send(chat.id, chats.pending[0]!.text, chats.pending[0]!.message_id);
	expect(api.sendMateMessage).toHaveBeenLastCalledWith(chat.id, {
		text: 'hello',
		message_id: 'same-message'
	});
	FakeSource.instances[1]!.onmessage!({
		data: JSON.stringify({ type: 'user', id: 'e1', text: 'hello' })
	});
	expect(chats.pending).toEqual([]);
});

it('settles an in-flight send after reconnecting the same chat', async () => {
	await chats.open(chat.id);
	let acknowledge!: (value: { event_id: string }) => void;
	vi.spyOn(api, 'sendMateMessage').mockImplementation(
		() =>
			new Promise((resolve) => {
				acknowledge = resolve;
			})
	);
	const sent = chats.send(chat.id, 'hello', 'in-flight');
	const source = FakeSource.instances[0]!;
	source.close();
	source.onerror!();
	vi.mocked(api.mateChat).mockResolvedValue({
		chat,
		events: [
			{ type: 'user', id: 'e1', text: 'hello', at: '2026-01-01', message_id: 'in-flight' },
			{ type: 'result', id: 'e2', status: 'succeeded', at: '2026-01-01' }
		]
	});
	await chats.open(chat.id);
	expect(chats.pending).toEqual([]);
	expect(chats.working).toBe(false);
	acknowledge({ event_id: 'e1' });
	await sent;
	expect(chats.pending).toEqual([]);
});

it('settles only the matching message identity before a send response, including duplicate replay', async () => {
	await chats.open(chat.id);
	let rejectFirst!: (error: Error) => void;
	let acknowledgeSecond!: (value: { event_id: string }) => void;
	vi.spyOn(api, 'sendMateMessage')
		.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					rejectFirst = reject;
				})
		)
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					acknowledgeSecond = resolve;
				})
		);
	const first = chats.send(chat.id, 'same text', 'first');
	const second = chats.send(chat.id, 'same text', 'second');
	const source = FakeSource.instances[0]!;
	source.onmessage!({ data: JSON.stringify({ type: 'user', id: 'e1', text: 'same text' }) });
	expect(chats.pending).toHaveLength(2);
	source.onmessage!({
		data: JSON.stringify({ type: 'user', id: 'e1', text: 'same text', message_id: 'first' })
	});
	expect(chats.events).toHaveLength(1);
	expect(chats.pending.map((item) => item.message_id)).toEqual(['second']);
	rejectFirst(new Error('response lost'));
	await first;
	expect(chats.pending.map((item) => item.message_id)).toEqual(['second']);
	acknowledgeSecond({ event_id: 'e2' });
	await second;
});

it('retains failed sends and drafts across chat navigation without mixing them', async () => {
	await chats.open(chat.id);
	chats.drafts[chat.id] = 'unfinished thought';
	vi.spyOn(api, 'sendMateMessage').mockRejectedValue(new Error('offline'));
	await chats.send(chat.id, 'keep me', 'retained');
	await chats.open('mc_other');
	expect(chats.pending).toEqual([]);
	expect(chats.drafts.mc_other).toBeUndefined();
	await chats.open(chat.id);
	expect(chats.drafts[chat.id]).toBe('unfinished thought');
	expect(chats.pending[0]).toMatchObject({ message_id: 'retained', text: 'keep me' });
});

it('records a late send failure for its original chat', async () => {
	await chats.open(chat.id);
	let reject!: (error: Error) => void;
	vi.spyOn(api, 'sendMateMessage').mockImplementation(
		() =>
			new Promise((_, no) => {
				reject = no;
			})
	);
	const sent = chats.send(chat.id, 'hello', 'late');
	await chats.open('mc_other');
	reject(new Error('offline'));
	await sent;
	expect(chats.pending).toEqual([]);
	await chats.open(chat.id);
	expect(chats.pending[0]?.error).toBeTruthy();
});

it('keeps the transcript while reconnecting and after a failed refresh', async () => {
	await chats.open(chat.id);
	FakeSource.instances[0]!.onmessage!({
		data: JSON.stringify({ type: 'assistant', id: 'e1', text: 'keep reading' })
	});
	FakeSource.instances[0]!.close();
	vi.mocked(api.mateChat).mockRejectedValueOnce(new Error('offline'));
	await chats.open(chat.id);
	expect(chats.events[0]?.id).toBe('e1');
	expect(chats.open_error).toBeTruthy();
	expect(chats.opening).toBe(false);
});

it('says nothing about a drop that heals within the grace period', async () => {
	vi.useFakeTimers();
	try {
		await chats.open(chat.id);
		const source = FakeSource.instances[0]!;
		source.readyState = 0;
		source.onerror!();
		expect(chats.stream_error).toBeNull();
		await vi.advanceTimersByTimeAsync(STREAM_GRACE_MS / 2);
		source.readyState = 1;
		source.onopen!();
		await vi.advanceTimersByTimeAsync(STREAM_GRACE_MS * 2);
		expect(chats.stream_error).toBeNull();
		expect(chats.stream_lost).toBe(false);
	} finally {
		vi.useRealTimers();
	}
});

it('reports a lasting drop, and clears it once the stream has stayed up', async () => {
	vi.useFakeTimers();
	try {
		await chats.open(chat.id);
		const source = FakeSource.instances[0]!;
		source.readyState = 0;
		source.onerror!();
		await vi.advanceTimersByTimeAsync(STREAM_GRACE_MS);
		expect(chats.stream_error).toContain('Reconnecting');
		source.onopen!();
		// An open that fails again at once must not flicker the notice away.
		await vi.advanceTimersByTimeAsync(STREAM_SETTLE_MS / 2);
		expect(chats.stream_error).toContain('Reconnecting');
		await vi.advanceTimersByTimeAsync(STREAM_SETTLE_MS);
		expect(chats.stream_error).toBeNull();
	} finally {
		vi.useRealTimers();
	}
});

it('keeps the runner’s reason when its stream closes after a runner error', async () => {
	vi.useFakeTimers();
	try {
		await chats.open(chat.id);
		const source = FakeSource.instances[0]!;
		source.listeners.runner_error!({ data: JSON.stringify({ message: 'The runner is busy.' }) });
		source.readyState = 0;
		source.onerror!();
		await vi.advanceTimersByTimeAsync(STREAM_GRACE_MS);
		expect(chats.stream_error).toBe('The runner is busy. Retrying…');
	} finally {
		vi.useRealTimers();
	}
});

it('reconnects a stream EventSource gave up on, from the last event, with backoff', async () => {
	vi.useFakeTimers();
	try {
		await chats.open(chat.id);
		const source = FakeSource.instances[0]!;
		source.onmessage!({ data: JSON.stringify({ type: 'assistant', id: 'e1', text: 'hi' }) });
		source.close();
		source.onerror!();
		expect(FakeSource.instances).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(streamRetryDelay(0)!);
		expect(FakeSource.instances).toHaveLength(2);
		expect(FakeSource.instances[1]!.url).toContain('after=e1');
		// A message from the new stream ends the drop before anyone was told.
		FakeSource.instances[1]!.onmessage!({
			data: JSON.stringify({ type: 'assistant', id: 'e2', text: 'back' })
		});
		await vi.advanceTimersByTimeAsync(STREAM_GRACE_MS * 2);
		expect(chats.stream_error).toBeNull();
		expect(chats.events.map((event) => event.id)).toEqual(['e1', 'e2']);
	} finally {
		vi.useRealTimers();
	}
});

it('asks for a manual reconnect only after its own retries run out', async () => {
	vi.useFakeTimers();
	try {
		await chats.open(chat.id);
		let attempts = 0;
		while (streamRetryDelay(attempts) !== undefined) {
			const source = FakeSource.instances.at(-1)!;
			source.close();
			source.onerror!();
			expect(chats.stream_lost).toBe(false);
			await vi.advanceTimersByTimeAsync(streamRetryDelay(attempts)!);
			attempts += 1;
		}
		expect(FakeSource.instances).toHaveLength(attempts + 1);
		const last = FakeSource.instances.at(-1)!;
		last.close();
		last.onerror!();
		expect(chats.stream_lost).toBe(true);
		expect(chats.stream_error).toContain('Lost the live connection');
		await vi.advanceTimersByTimeAsync(60_000);
		expect(FakeSource.instances).toHaveLength(attempts + 1);
		await chats.open(chat.id);
		expect(chats.stream_lost).toBe(false);
		expect(chats.stream_error).toBeNull();
		expect(FakeSource.instances).toHaveLength(attempts + 2);
	} finally {
		vi.useRealTimers();
	}
});

it('takes a failed message back into the composer, after any draft', async () => {
	await chats.open(chat.id);
	vi.spyOn(api, 'sendMateMessage').mockRejectedValue(new Error('offline'));
	await chats.send(chat.id, 'first try', 'failed');
	chats.recall(chat.id, chats.pending[0]!);
	expect(chats.pending).toEqual([]);
	expect(chats.drafts[chat.id]).toBe('first try');
	await chats.send(chat.id, 'again', 'failed-2');
	chats.drafts[chat.id] = 'half typed  ';
	chats.recall(chat.id, chats.pending[0]!);
	expect(chats.drafts[chat.id]).toBe('half typed\n\nagain');
});

it('keeps saved scope on failure without treating it as a failed transcript load', async () => {
	await chats.open(chat.id);
	vi.spyOn(api, 'updateMateChat').mockRejectedValueOnce(new Error('offline'));
	await chats.setScope(chat.id, 'd_another');
	expect(chats.get(chat.id)?.scope).toBeNull();
	expect(chats.action_error).toContain('Scope was not changed');
	expect(chats.open_error).toBeNull();
	expect(chats.scope_saving).toBe(false);
});

it('acknowledges a stop request only until the terminal event arrives', async () => {
	await chats.open(chat.id);
	const source = FakeSource.instances[0]!;
	source.onmessage!({ data: JSON.stringify({ type: 'assistant', id: 'e1', text: 'working' }) });
	vi.spyOn(api, 'interruptMate').mockResolvedValue({ interrupted: true });
	await chats.interrupt(chat.id);
	expect(chats.interrupt_requested).toBe(true);
	await chats.interrupt(chat.id);
	expect(api.interruptMate).toHaveBeenCalledTimes(1);
	source.onmessage!({ data: JSON.stringify({ type: 'result', id: 'e2', status: 'cancelled' }) });
	expect(chats.interrupt_requested).toBe(false);
	expect(chats.working).toBe(false);
});

it('does not apply a late stop acknowledgment to the following turn', async () => {
	await chats.open(chat.id);
	const source = FakeSource.instances[0]!;
	source.onmessage!({ data: JSON.stringify({ type: 'assistant', id: 'e1', text: 'working' }) });
	let acknowledge!: (value: { interrupted: true }) => void;
	vi.spyOn(api, 'interruptMate')
		.mockResolvedValue({ interrupted: true })
		.mockImplementationOnce(() => new Promise((resolve) => (acknowledge = resolve)));
	const stopping = chats.interrupt(chat.id);
	source.onmessage!({ data: JSON.stringify({ type: 'result', id: 'e2', status: 'cancelled' }) });
	source.onmessage!({ data: JSON.stringify({ type: 'assistant', id: 'e3', text: 'next turn' }) });
	acknowledge({ interrupted: true });
	await stopping;
	expect(chats.working).toBe(true);
	expect(chats.interrupt_requested).toBe(false);
	await chats.interrupt(chat.id);
	expect(api.interruptMate).toHaveBeenCalledTimes(2);
});

it.each(['before', 'after'] as const)(
	'does not latch a pending send when its stop response arrives %s the failure',
	async (response_order) => {
		await chats.open(chat.id);
		const source = FakeSource.instances[0]!;
		let rejectSend!: (error: Error) => void;
		vi.spyOn(api, 'sendMateMessage').mockImplementationOnce(
			() => new Promise((_, reject) => (rejectSend = reject))
		);
		let acknowledgeStop!: (value: { interrupted: true }) => void;
		vi.spyOn(api, 'interruptMate')
			.mockResolvedValue({ interrupted: true })
			.mockImplementationOnce(() => new Promise((resolve) => (acknowledgeStop = resolve)));
		const sending = chats.send(chat.id, 'not yet admitted', 'failed-send');
		const stopping = chats.interrupt(chat.id);
		if (response_order === 'before') {
			acknowledgeStop({ interrupted: true });
			await stopping;
		}
		rejectSend(new Error('offline'));
		await sending;
		expect(chats.working).toBe(false);
		expect(chats.interrupt_requested).toBe(false);
		// No terminal event exists for the rejected send. A later turn must
		// remain stoppable even if the earlier stop POST is still in flight.
		source.onmessage!({ data: JSON.stringify({ type: 'assistant', id: 'next', text: 'working' }) });
		if (response_order === 'after') {
			acknowledgeStop({ interrupted: true });
			await stopping;
		}
		expect(chats.interrupt_requested).toBe(false);
		await chats.interrupt(chat.id);
		expect(api.interruptMate).toHaveBeenCalledTimes(2);
	}
);

it('keeps the stop acknowledgment for an active turn when a follow-up send fails', async () => {
	await chats.open(chat.id);
	const source = FakeSource.instances[0]!;
	source.onmessage!({ data: JSON.stringify({ type: 'assistant', id: 'e1', text: 'working' }) });
	let rejectSend!: (error: Error) => void;
	vi.spyOn(api, 'sendMateMessage').mockImplementationOnce(
		() => new Promise((_, reject) => (rejectSend = reject))
	);
	vi.spyOn(api, 'interruptMate').mockResolvedValue({ interrupted: true });
	const sending = chats.send(chat.id, 'follow-up', 'failed-followup');
	await chats.interrupt(chat.id);
	rejectSend(new Error('offline'));
	await sending;
	expect(chats.working).toBe(true);
	expect(chats.interrupt_requested).toBe(true);
	source.onmessage!({ data: JSON.stringify({ type: 'result', id: 'e2', status: 'cancelled' }) });
	expect(chats.interrupt_requested).toBe(false);
});

const MISSION = {
	id: 'dq_1',
	project_id: 'd_web',
	project_name: 'Web',
	operation: 'tackle' as const,
	status: 'running' as const,
	issue_id: 'web-1',
	agent_id: 'sbx1',
	actor: 'admin@example.com',
	created_at: '2026-01-01T00:00:00.000Z',
	updated_at: '2026-01-01T00:00:00.000Z'
};

it('loads the chat’s missions once on open, and again when a crew notice arrives', async () => {
	vi.mocked(api.mateChat).mockResolvedValue({
		chat,
		events: [{ type: 'user', id: 'n0', text: '[crew] old', at: '2026-01-01', message_id: 'crew-0' }]
	});
	vi.mocked(api.mateChatMissions).mockResolvedValue({ missions: [MISSION] });
	await chats.open(chat.id);
	await vi.waitFor(() => expect(chats.missions).toEqual([MISSION]));
	expect(api.mateChatMissions).toHaveBeenCalledTimes(1);

	FakeSource.instances[0]!.onmessage!({
		data: JSON.stringify({ type: 'user', id: 'n1', text: '[crew] done', message_id: 'crew-1' })
	});
	await vi.waitFor(() => expect(api.mateChatMissions).toHaveBeenCalledTimes(2));
});

it('drops an older missions read that answers after a newer one', async () => {
	await chats.open(chat.id);
	await vi.waitFor(() => expect(api.mateChatMissions).toHaveBeenCalledTimes(1));
	let answerOld!: (value: { missions: (typeof MISSION)[] }) => void;
	vi.mocked(api.mateChatMissions)
		.mockImplementationOnce(() => new Promise((resolve) => (answerOld = resolve)))
		.mockResolvedValueOnce({ missions: [MISSION] });
	const older = chats.loadMissions(chat.id);
	await chats.loadMissions(chat.id);
	answerOld({ missions: [] });
	await older;
	expect(chats.missions).toEqual([MISSION]);
});

it('keeps shown missions when a reload fails, and says so only when there are none', async () => {
	vi.mocked(api.mateChatMissions).mockRejectedValueOnce(new Error('offline'));
	await chats.open(chat.id);
	await vi.waitFor(() => expect(chats.missions_error).toBeTruthy());
	vi.mocked(api.mateChatMissions).mockResolvedValue({ missions: [MISSION] });
	await chats.loadMissions(chat.id);
	expect(chats.missions_error).toBeNull();
	vi.mocked(api.mateChatMissions).mockRejectedValueOnce(new Error('offline'));
	await chats.loadMissions(chat.id);
	expect(chats.missions).toEqual([MISSION]);
});

it('cancels a mission, showing the answered status or why it failed', async () => {
	vi.mocked(api.mateChatMissions).mockResolvedValue({ missions: [MISSION] });
	await chats.open(chat.id);
	await vi.waitFor(() => expect(chats.missions).toHaveLength(1));

	vi.spyOn(api, 'cancelDispatch').mockRejectedValueOnce(new Error('runner down'));
	await chats.cancelMission(chats.missions[0]!);
	expect(chats.cancel_errors[MISSION.id]).toContain('runner down');
	expect(chats.cancelling[MISSION.id]).toBeUndefined();

	vi.mocked(api.cancelDispatch).mockResolvedValueOnce({
		request: { ...MISSION, status: 'cancelled' }
	});
	await chats.cancelMission(chats.missions[0]!);
	expect(api.cancelDispatch).toHaveBeenLastCalledWith('d_web', 'dq_1');
	expect(chats.missions[0]).toMatchObject({ status: 'cancelled', project_name: 'Web' });
	expect(chats.cancel_errors[MISSION.id]).toBeUndefined();
});

it('polls a running mission through its status route until it finishes', async () => {
	vi.useFakeTimers();
	try {
		vi.mocked(api.mateChatMissions).mockResolvedValue({ missions: [MISSION] });
		const status = vi
			.spyOn(api, 'dispatch')
			.mockResolvedValue({ request: { ...MISSION, status: 'succeeded' } });
		await chats.open(chat.id);
		await vi.waitFor(() => expect(chats.missions).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(CHAT_MISSION_POLL_MS);
		expect(status).toHaveBeenCalledWith('d_web', 'dq_1');
		expect(chats.missions[0]?.status).toBe('succeeded');
		await vi.advanceTimersByTimeAsync(CHAT_MISSION_POLL_MS * 2);
		expect(status).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
	}
});
