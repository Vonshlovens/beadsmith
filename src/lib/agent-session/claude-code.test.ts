import { describe, expect, it } from 'vitest';
import { claudeCode, claudeProjectDir } from './claude-code';

const SESSION = '0b7c1f2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const line = (value: unknown) => JSON.stringify(value);

describe('claudeCode.argv', () => {
	it('starts an interactive session with bypassed prompts and no prompt on the command line', () => {
		expect(
			claudeCode.argv({
				session_id: SESSION,
				resume: false,
				cwd: '/work',
				config_dir: '/home/user/.claude'
			})
		).toEqual(['claude', '--permission-mode', 'bypassPermissions', '--session-id', SESSION]);
	});

	it('resumes, and passes model, effort, system prompt and the crew MCP config', () => {
		expect(
			claudeCode.argv({
				session_id: SESSION,
				resume: true,
				cwd: '/work',
				config_dir: '/home/user/.claude',
				command: '/usr/local/bin/claude',
				model: 'claude-opus-5-5[1m]',
				effort: 'high',
				append_system_prompt: 'Scope: one project.',
				mcp_config: '/run/crew/mcp.json'
			})
		).toEqual([
			'/usr/local/bin/claude',
			'--permission-mode',
			'bypassPermissions',
			'--resume',
			SESSION,
			'--model',
			'claude-opus-5-5[1m]',
			'--effort',
			'high',
			'--append-system-prompt',
			'Scope: one project.',
			'--mcp-config',
			'/run/crew/mcp.json'
		]);
	});

	it('refuses values that could be read as flags or paths elsewhere', () => {
		const base = { session_id: SESSION, resume: false, cwd: '/w', config_dir: '/c' };
		expect(() => claudeCode.argv({ ...base, session_id: 'not-a-uuid' })).toThrow();
		expect(() => claudeCode.argv({ ...base, model: '--dangerously' })).toThrow();
		expect(() => claudeCode.argv({ ...base, effort: 'HIGH; rm' })).toThrow();
		expect(() => claudeCode.argv({ ...base, mcp_config: 'relative.json' })).toThrow();
	});
});

describe('claudeCode.transcriptPath', () => {
	it('names the file the way Claude Code does', () => {
		expect(claudeProjectDir('/home/user/work.dir/beadsmith_x')).toBe(
			'-home-user-work-dir-beadsmith-x'
		);
		expect(
			claudeCode.transcriptPath({
				session_id: SESSION,
				cwd: '/home/user/run',
				config_dir: '/home/user/.claude/'
			})
		).toBe(`/home/user/.claude/projects/-home-user-run/${SESSION}.jsonl`);
	});
});

describe('transcript mapper', () => {
	it('maps text, thinking and tool calls and drops tool inputs and outputs', () => {
		const mapper = claudeCode.mapper('');
		expect(
			mapper.map(line({ type: 'user', message: { role: 'user', content: 'Do the work' } }), 1)
		).toEqual([]);
		expect(
			mapper.map(
				line({
					type: 'assistant',
					message: { content: [{ type: 'thinking', thinking: 'Plan it.' }] }
				}),
				2
			)
		).toEqual([{ id: '2.0', type: 'thinking', text: 'Plan it.' }]);
		expect(
			mapper.map(
				line({
					type: 'assistant',
					message: {
						content: [
							{ type: 'tool_use', id: 'toolu_1', name: 'mcp__crew__tackle', input: { x: 1 } }
						]
					}
				}),
				3
			)
		).toEqual([
			{
				id: '3.0',
				type: 'tool_call',
				call_id: 'toolu_1',
				name: 'mcp__crew__tackle',
				status: 'running'
			}
		]);
		const closed = mapper.map(
			line({
				type: 'user',
				message: {
					content: [
						{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'secret' }
					]
				}
			}),
			4
		);
		expect(closed).toEqual([
			{
				id: '4.0',
				type: 'tool_call',
				call_id: 'toolu_1',
				name: 'mcp__crew__tackle',
				status: 'failed'
			}
		]);
		expect(JSON.stringify(closed)).not.toContain('secret');
		expect(
			mapper.map(
				line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }),
				5
			)
		).toEqual([{ id: '5.0', type: 'assistant', text: 'Done.' }]);
		expect(mapper.turn).toEqual({ ended: false, api_error: false, last_text: 'Done.' });
		expect(
			mapper.map(line({ type: 'system', subtype: 'turn_duration', durationMs: 1234 }), 6)
		).toEqual([]);
		expect(mapper.turn).toMatchObject({ ended: true, duration_ms: 1234 });
		mapper.beginTurn();
		expect(mapper.turn).toEqual({ ended: false, api_error: false });
	});

	it('scrubs the redacted secret and credential shapes', () => {
		const mapper = claudeCode.mapper('hunter2-dolt');
		const [event] = mapper.map(
			line({
				type: 'assistant',
				message: { content: [{ type: 'text', text: 'pw hunter2-dolt and Bearer abc.def' }] }
			}),
			1
		);
		expect(event).toEqual({
			id: '1.0',
			type: 'assistant',
			text: 'pw [redacted] and Bearer [redacted]'
		});
	});

	it('skips sidechains, records and broken lines, and notes API errors', () => {
		const mapper = claudeCode.mapper('');
		expect(
			mapper.map(
				line({
					type: 'assistant',
					isSidechain: true,
					message: { content: [{ type: 'text', text: 'subagent' }] }
				}),
				1
			)
		).toEqual([]);
		expect(
			mapper.map(
				line({
					type: 'api-request-blob',
					message: { role: 'assistant', content: [{ type: 'text', text: 'copy' }] }
				}),
				2
			)
		).toEqual([]);
		expect(mapper.map('{"type":"assistant"', 3)).toEqual([]);
		expect(
			mapper.map(
				line({
					type: 'assistant',
					isApiErrorMessage: true,
					message: { content: [{ type: 'text', text: 'API Error: overloaded' }] }
				}),
				4
			)
		).toHaveLength(1);
		expect(mapper.turn.api_error).toBe(true);
	});
});

describe('live context size', () => {
	it('keeps the latest assistant request’s input, cache read and cache creation', () => {
		const mapper = claudeCode.mapper('');
		const usage = (input: number, read: number, created: number) =>
			line({
				type: 'assistant',
				message: {
					content: [{ type: 'text', text: 'hi' }],
					usage: {
						input_tokens: input,
						cache_read_input_tokens: read,
						cache_creation_input_tokens: created,
						output_tokens: 999
					}
				}
			});
		mapper.map(usage(10, 1_000, 5), 1);
		expect(mapper.turn.context_tokens).toBe(1_015);
		mapper.map(usage(3, 120_000, 2_000), 2);
		expect(mapper.turn.context_tokens).toBe(122_003);
		// A subagent's requests are its own context, not this one.
		mapper.map(JSON.stringify({ ...JSON.parse(usage(1, 500_000, 0)), isSidechain: true }), 3);
		expect(mapper.turn.context_tokens).toBe(122_003);
		mapper.beginTurn();
		expect(mapper.turn.context_tokens).toBeUndefined();
	});
});
