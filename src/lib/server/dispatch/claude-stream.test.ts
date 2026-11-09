import { describe, expect, it } from 'vitest';
import {
	ClaudeStreamMapper,
	findPullRequestUrl,
	parseClaudeResult,
	parseStreamEventId
} from './claude-stream.js';

const line = (value: unknown) => JSON.stringify(value);

describe('ClaudeStreamMapper', () => {
	it('maps text, thinking and tool calls, and drops tool inputs and results', () => {
		const mapper = new ClaudeStreamMapper();
		const assistant = line({
			type: 'assistant',
			message: {
				content: [
					{ type: 'thinking', thinking: 'Look at the issue first.' },
					{ type: 'text', text: 'Claiming the issue.' },
					{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'cat .env' } }
				]
			}
		});
		const events = mapper.map(assistant, 4);
		expect(events).toEqual([
			{ type: 'thinking', id: '4.0', text: 'Look at the issue first.' },
			{ type: 'assistant', id: '4.1', text: 'Claiming the issue.' },
			{ type: 'tool_call', id: '4.2', call_id: 'toolu_01', name: 'Bash', status: 'running' }
		]);
		expect(JSON.stringify(events)).not.toContain('cat .env');

		const tool_result = line({
			type: 'user',
			message: {
				content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'SECRET=hunter2' }]
			}
		});
		const closed = mapper.map(tool_result, 5);
		expect(closed).toEqual([
			{ type: 'tool_call', id: '5.0', call_id: 'toolu_01', name: 'Bash', status: 'completed' }
		]);
		expect(JSON.stringify(closed)).not.toContain('hunter2');
	});

	it('marks a tool result with is_error as a failed call, without its output', () => {
		const mapper = new ClaudeStreamMapper();
		mapper.map(
			line({
				type: 'assistant',
				message: { content: [{ type: 'tool_use', id: 'toolu_02', name: 'Bash' }] }
			}),
			1
		);
		const failed = mapper.map(
			line({
				type: 'user',
				message: {
					content: [
						{ type: 'tool_result', tool_use_id: 'toolu_02', is_error: true, content: 'exit 1' }
					]
				}
			}),
			2
		);
		expect(failed).toEqual([
			{ type: 'tool_call', id: '2.0', call_id: 'toolu_02', name: 'Bash', status: 'failed' }
		]);
		expect(JSON.stringify(failed)).not.toContain('exit 1');
	});

	it('turns MCP tool names into renderable ones and ignores the prompt echo', () => {
		const mapper = new ClaudeStreamMapper();
		expect(
			mapper.map(
				line({
					type: 'assistant',
					message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__beads__list' }] }
				}),
				1
			)[0]
		).toMatchObject({ name: 'mcp__beads__list' });
		expect(
			mapper.map(
				line({ type: 'user', message: { content: [{ type: 'text', text: 'the prompt' }] } }),
				2
			)
		).toEqual([]);
		expect(mapper.map('not json', 3)).toEqual([]);
		expect(mapper.map(line({ type: 'system', subtype: 'init' }), 4)).toEqual([]);
	});

	it('maps the final result and redacts credentials and the given secret', () => {
		const mapper = new ClaudeStreamMapper('dolt-password-123456');
		const result = line({
			type: 'result',
			subtype: 'success',
			is_error: false,
			duration_ms: 4200,
			result: 'Done. Password dolt-password-123456, key sk-ant-api03-abcdefghijkl.'
		});
		const [event] = mapper.map(result, 9);
		expect(event).toMatchObject({ type: 'result', status: 'succeeded', duration_ms: 4200 });
		expect(JSON.stringify(event)).not.toContain('dolt-password-123456');
		expect(JSON.stringify(event)).not.toContain('sk-ant-api03-abcdefghijkl');
	});
});

describe('parseClaudeResult', () => {
	it('treats any non-success subtype as an error', () => {
		expect(
			parseClaudeResult(line({ type: 'result', subtype: 'error_max_turns', is_error: false }))
		).toMatchObject({
			is_error: true
		});
		expect(parseClaudeResult(line({ type: 'assistant' }))).toBeUndefined();
	});
});

describe('stream helpers', () => {
	it('parses resumable event ids', () => {
		expect(parseStreamEventId('12.3')).toEqual({ line: 12, index: 3 });
		expect(parseStreamEventId('0.1')).toBeUndefined();
		expect(parseStreamEventId('abc')).toBeUndefined();
		expect(parseStreamEventId(undefined)).toBeUndefined();
	});

	it('finds the first pull request URL in a summary', () => {
		expect(findPullRequestUrl('Opened https://github.com/example-org/app/pull/42.')).toBe(
			'https://github.com/example-org/app/pull/42'
		);
		expect(findPullRequestUrl('No PR this time.')).toBeUndefined();
	});
});
