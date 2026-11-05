import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from './api.js';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/env', () => ({ browser: true }));

// Exercise the state machine without a DOM. Svelte's field initializers are
// identities here; rendering/reactive scheduling still needs browser QA.
vi.stubGlobal('$state', <T>(value: T) => value);
const { mate_chats: chats } = await import('./mate-chat.svelte.js');

class FakeSource {
	static CLOSED = 2;
	static instances: FakeSource[] = [];
	readyState = 1;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onopen: (() => void) | null = null;
	constructor() {
		FakeSource.instances.push(this);
	}
	addEventListener() {}
	close() {
		this.readyState = 2;
	}
}
const chat = {
	id: 'mc_test',
	title: 'Test',
	scope: null,
	created_at: '2026-01-01',
	updated_at: '2026-01-01'
};

beforeEach(() => {
	vi.stubGlobal('EventSource', FakeSource);
	FakeSource.instances = [];
	chats.close();
	chats.status = { connected: true, reachable: true };
	vi.spyOn(api, 'mateChat').mockResolvedValue({ chat, events: [] });
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
