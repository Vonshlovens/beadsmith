import { describe, expect, it } from 'vitest';
import {
	encodeMissionEvent,
	isMissionEvent,
	parseMissionEventJson,
	reduceMissionEvents,
	type MissionEvent
} from './mission-events.js';

describe('mission event union', () => {
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
