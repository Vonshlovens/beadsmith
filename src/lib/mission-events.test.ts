import { describe, expect, it } from 'vitest';
import {
	encodeMissionEvent,
	groupMissionEvents,
	isMissionEvent,
	missionStreamEnded,
	parseMissionEventJson,
	reduceMissionEvents,
	type MissionEvent
} from './mission-events.js';

describe('mission event union', () => {
	it('preserves bounded user message identities while discarding invalid metadata', () => {
		const user = { type: 'user', id: 'e1', text: 'hello' };
		expect(
			parseMissionEventJson(JSON.stringify({ ...user, message_id: 'message-1', raw: 'drop' }))
		).toEqual({ ...user, message_id: 'message-1' });
		for (const message_id of ['', 'x'.repeat(65), 'bad id', { raw: 'drop' }]) {
			expect(parseMissionEventJson(JSON.stringify({ ...user, message_id }))).toEqual(user);
		}
		expect(parseMissionEventJson(JSON.stringify(user))).toEqual(user);
	});

	it('accepts the documented types and rejects raw runner payloads', () => {
		const assistant: MissionEvent = { type: 'assistant', id: '1-0', text: 'Hello' };
		expect(isMissionEvent(assistant)).toBe(true);
		expect(
			isMissionEvent({
				type: 'assistant',
				id: '1-0',
				text: 'Hello',
				args: { cmd: 'cat /etc/passwd' }
			})
		).toBe(true);
		expect(encodeMissionEvent({ ...assistant, text: 'Hello' })).toEqual(assistant);
		expect(
			isMissionEvent({
				type: 'tool_call',
				id: '1-1',
				call_id: 'call-1',
				name: 'read_file',
				status: 'running',
				args: { path: 'SECRET' }
			})
		).toBe(true);
		expect(
			isMissionEvent({ type: 'tool_call', id: '1-2', call_id: 'c', name: 'Bash', status: 'failed' })
		).toBe(true);
		expect(
			isMissionEvent({
				type: 'tool_call',
				id: '1-3',
				call_id: 'c',
				name: 'Bash',
				status: 'errored'
			})
		).toBe(false);
		expect(parseMissionEventJson('{"type":"heartbeat","id":"1"}')).toBeUndefined();
		expect(parseMissionEventJson('not-json')).toBeUndefined();
	});

	it('drops extra keys when encoding', () => {
		const encoded = encodeMissionEvent({
			type: 'tool_call',
			id: 'evt-1',
			call_id: 'call-1',
			name: 'read_file',
			status: 'completed'
		});
		expect(encoded).toEqual({
			type: 'tool_call',
			id: 'evt-1',
			call_id: 'call-1',
			name: 'read_file',
			status: 'completed'
		});
		expect(JSON.stringify(encoded)).not.toContain('args');
	});

	it('concatenates assistant deltas and upserts tool calls', () => {
		const reduced = reduceMissionEvents([
			{ type: 'assistant', id: 'a1', text: 'Hi' },
			{ type: 'assistant', id: 'a2', text: ' there' },
			{ type: 'tool_call', id: 't1', call_id: 'c1', name: 'read_file', status: 'running' },
			{ type: 'thinking', id: 'th1', text: 'hmm' },
			{
				type: 'tool_call',
				id: 't2',
				call_id: 'c1',
				name: 'read_file',
				status: 'completed'
			}
		]);
		expect(reduced).toEqual([
			{ type: 'assistant', id: 'a2', text: 'Hi there' },
			{ type: 'tool_call', id: 't2', call_id: 'c1', name: 'read_file', status: 'completed' },
			{ type: 'thinking', id: 'th1', text: 'hmm' }
		]);
	});
});

describe('groupMissionEvents', () => {
	const call = (
		id: string,
		call_id: string,
		name: string,
		status: 'running' | 'completed' | 'failed'
	): MissionEvent => ({ type: 'tool_call', id, call_id, name, status });

	it('folds consecutive tool calls into one group between messages', () => {
		const items = groupMissionEvents([
			{ type: 'assistant', id: 'a1', text: 'Looking.' },
			call('t1', 'c1', 'Read', 'completed'),
			call('t2', 'c2', 'Bash', 'running'),
			call('t3', 'c3', 'Read', 'running'),
			call('t4', 'c2', 'Bash', 'failed'),
			{ type: 'assistant', id: 'a2', text: 'Done.' },
			call('t5', 'c4', 'Edit', 'running')
		]);
		expect(items.map((item) => item.type)).toEqual([
			'assistant',
			'tool_group',
			'assistant',
			'tool_group'
		]);
		const first = items[1];
		expect(first?.type === 'tool_group' && first.calls.map((c) => c.call_id)).toEqual([
			'c1',
			'c2',
			'c3'
		]);
		expect(first?.type === 'tool_group' && first.calls.map((c) => c.status)).toEqual([
			'completed',
			'failed',
			'running'
		]);
		expect(items[3]).toEqual({
			type: 'tool_group',
			calls: [{ type: 'tool_call', id: 't5', call_id: 'c4', name: 'Edit', status: 'running' }]
		});
	});

	it('keeps earlier positions when the stream grows', () => {
		const head: MissionEvent[] = [
			{ type: 'thinking', id: 'th1', text: 'a' },
			call('t1', 'c1', 'Read', 'running')
		];
		const before = groupMissionEvents(head);
		const after = groupMissionEvents([
			...head,
			call('t2', 'c1', 'Read', 'completed'),
			call('t3', 'c2', 'Grep', 'running'),
			{ type: 'thinking', id: 'th2', text: 'b' }
		]);
		expect(after.slice(0, before.length).map((item) => item.type)).toEqual(
			before.map((item) => item.type)
		);
		expect(after[1]?.type === 'tool_group' && after[1].calls.map((c) => c.status)).toEqual([
			'completed',
			'running'
		]);
		expect(after[2]).toEqual({ type: 'thinking', id: 'th2', text: 'b' });
	});

	it('returns nothing for an empty stream', () => {
		expect(groupMissionEvents([])).toEqual([]);
	});
});

describe('missionStreamEnded', () => {
	it('ends on a result or the proxy answer, and reconnects otherwise', () => {
		expect(missionStreamEnded({ got_result: true, got_answer: false })).toBe(true);
		expect(missionStreamEnded({ got_result: false, got_answer: true })).toBe(true);
		expect(missionStreamEnded({ got_result: false, got_answer: false })).toBe(false);
	});
});
