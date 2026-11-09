import { describe, expect, it } from 'vitest';
import { isMissionEvent } from '../mission-events.js';
import { ClaudeStreamMapper, interruptLine, safeToolName, userInputLine } from './claude-stream.js';

describe('ClaudeStreamMapper', () => {
	it('maps assistant text, thinking and tool calls, and closes calls on their result', () => {
		const mapper = new ClaudeStreamMapper();
		expect(mapper.map({ type: 'system', subtype: 'init', session_id: 's' })).toEqual([]);
		expect(
			mapper.map({
				type: 'assistant',
				message: {
					content: [
						{ type: 'thinking', thinking: 'Look at ready work first.' },
						{ type: 'text', text: 'Checking the board.' },
						{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'bd ready' } }
					]
				}
			})
		).toEqual([
			{ type: 'thinking', text: 'Look at ready work first.' },
			{ type: 'assistant', text: 'Checking the board.' },
			{ type: 'tool_call', call_id: 'toolu_1', name: 'Bash', status: 'running' }
		]);
		expect(
			mapper.map({
				type: 'user',
				message: {
					content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'secret output' }]
				}
			})
		).toEqual([{ type: 'tool_call', call_id: 'toolu_1', name: 'Bash', status: 'completed' }]);
		expect(
			mapper.map({
				type: 'result',
				subtype: 'success',
				is_error: false,
				result: 'Two ready.',
				duration_ms: 1234.4
			})
		).toEqual([{ type: 'result', status: 'succeeded', text: 'Two ready.', duration_ms: 1234 }]);
	});

	it('marks a tool result with is_error as a failed call, without its output', () => {
		const mapper = new ClaudeStreamMapper();
		mapper.map({
			type: 'assistant',
			message: { content: [{ type: 'tool_use', id: 't', name: 'mcp__crew__show_issue' }] }
		});
		const events = mapper.map({
			type: 'user',
			message: {
				content: [
					{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'no such issue' }
				]
			}
		});
		expect(events).toEqual([
			{ type: 'tool_call', call_id: 't', name: 'mcp__crew__show_issue', status: 'failed' }
		]);
		expect(JSON.stringify(events)).not.toContain('no such issue');
	});

	it('never forwards tool inputs or outputs', () => {
		const mapper = new ClaudeStreamMapper();
		const events = [
			...mapper.map({
				type: 'assistant',
				message: {
					content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/etc/x' } }]
				}
			}),
			...mapper.map({
				type: 'user',
				message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'TOKEN=abc' }] }
			})
		];
		expect(JSON.stringify(events)).not.toMatch(/etc\/x|TOKEN/);
	});

	it('marks a turn the runner interrupted as cancelled, once', () => {
		const mapper = new ClaudeStreamMapper();
		mapper.markInterrupted();
		expect(
			mapper.map({ type: 'result', subtype: 'error_during_execution', is_error: true })
		).toEqual([{ type: 'result', status: 'cancelled' }]);
		expect(mapper.map({ type: 'result', subtype: 'error_max_turns', is_error: true })).toEqual([
			{ type: 'result', status: 'failed' }
		]);
	});

	it('ignores malformed lines and blank text', () => {
		const mapper = new ClaudeStreamMapper();
		expect(mapper.map(null)).toEqual([]);
		expect(
			mapper.map({ type: 'assistant', message: { content: [{ type: 'text', text: '  ' }] } })
		).toEqual([]);
		expect(
			mapper.map({
				type: 'user',
				message: { content: [{ type: 'tool_result', tool_use_id: 'unknown' }] }
			})
		).toEqual([]);
	});

	it('produces events the browser accepts once they have ids', () => {
		const mapper = new ClaudeStreamMapper();
		const drafts = mapper.map({
			type: 'assistant',
			message: { content: [{ type: 'tool_use', id: 'toolu_9', name: 'mcp__beads__ready' }] }
		});
		for (const draft of drafts) expect(isMissionEvent({ ...draft, id: 'e000000001' })).toBe(true);
	});
});

describe('safeToolName', () => {
	it('keeps valid names and repairs the rest', () => {
		expect(safeToolName('Bash')).toBe('Bash');
		expect(safeToolName('mcp__x__y')).toBe('mcp__x__y');
		expect(safeToolName('weird tool!')).toBe('weird_tool_');
		expect(safeToolName('9lives')).toBe('tool_9lives');
		expect(safeToolName(undefined)).toBe('tool_');
		expect(safeToolName('a'.repeat(100))).toHaveLength(64);
	});
});

describe('stdin lines', () => {
	it('writes Claude Code stream-json input', () => {
		expect(JSON.parse(userInputLine('hi', 'sid'))).toEqual({
			type: 'user',
			message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
			parent_tool_use_id: null,
			session_id: 'sid'
		});
		expect(JSON.parse(interruptLine('r1'))).toEqual({
			type: 'control_request',
			request_id: 'r1',
			request: { subtype: 'interrupt' }
		});
	});
});
