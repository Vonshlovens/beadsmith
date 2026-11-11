import { describe, expect, it } from 'vitest';
import { RalphClient } from '../dispatch/ralph.js';
import { parseCurlOutput, sandboxRalphFetch } from './ralph-transport.js';
import type { SandboxRef } from './sandbox.js';

/** Just enough of a sandbox to see the commands and answer them. */
function sandbox(answer: { stdout?: string; exit_code?: number; chunks?: string[] }) {
	const calls: Array<{ command: string; envs?: Record<string, string>; follow?: boolean }> = [];
	const ref = {
		id: 'sbx1',
		async exec(command: string, envs?: Record<string, string>) {
			calls.push({ command, envs });
			return { exit_code: answer.exit_code ?? 0, stdout: answer.stdout ?? '' };
		},
		async follow(command: string, on_stdout: (chunk: string) => void) {
			calls.push({ command, follow: true });
			for (const chunk of answer.chunks ?? []) on_stdout(chunk);
		}
	} as unknown as SandboxRef;
	return { ref, calls };
}

const RUN = {
	id: 'run-1',
	name: 'bdx-build-0123abcd',
	mode: 'build',
	status: 'running',
	stopReason: null,
	currentIteration: 1,
	maxIterations: 5,
	startedAt: '2026-11-11T10:00:00.000Z',
	updatedAt: '2026-11-11T10:00:00.000Z',
	alive: true
};

describe('sandboxRalphFetch', () => {
	it('reads a JSON answer and the status curl appends', async () => {
		const { ref, calls } = sandbox({
			stdout: `${JSON.stringify({ run: RUN, iterations: [] })}\n__beadsmith_status=200`
		});
		const detail = await new RalphClient(sandboxRalphFetch(ref), '').getRun(RUN.name);
		expect(detail.run.name).toBe(RUN.name);
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toContain(`'http://127.0.0.1:7420/v1/runs/${RUN.name}'`);
		expect(calls[0].command).toContain('-X GET');
	});

	it('passes a body base64-encoded in the environment, never in the command', async () => {
		const { ref, calls } = sandbox({ stdout: '{"state":"stopped"}\n__beadsmith_status=200' });
		const client = new RalphClient(sandboxRalphFetch(ref), '');
		expect(await client.stop(RUN.name, { graceful: true })).toBe('stopped');
		expect(calls[0].command).toMatch(/^printf %s "\$RALPH_BODY" \| base64 -d \| curl /);
		expect(calls[0].command).not.toContain('graceful');
		expect(Buffer.from(calls[0].envs!.RALPH_BODY, 'base64').toString()).toBe('{"graceful":true}');
	});

	it('carries ralph errors and an unreachable serve as client errors', async () => {
		const missing = sandbox({ stdout: '{"error":"no such ralph"}\n__beadsmith_status=404' });
		await expect(
			new RalphClient(sandboxRalphFetch(missing.ref), '').getRun(RUN.name)
		).rejects.toMatchObject({ status: 404 });
		const down = sandbox({ exit_code: 7, stdout: '' });
		await expect(
			new RalphClient(sandboxRalphFetch(down.ref), '').getRun(RUN.name)
		).rejects.toMatchObject({ status: 0 });
	});

	it('refuses routes and headers outside the allowlist before running anything', async () => {
		const { ref, calls } = sandbox({});
		const fetch = sandboxRalphFetch(ref);
		await expect(fetch({ method: 'POST', path: '/v1/runs', headers: {} })).rejects.toThrow(/route/);
		await expect(
			fetch({ method: 'GET', path: '/v1/runs/x', headers: { 'last-event-id': "1'; rm -rf ~" } })
		).rejects.toThrow(/header/);
		await expect(
			fetch({ method: 'GET', path: '/v1/runs/x', headers: { authorization: 'Bearer t' } })
		).rejects.toThrow(/header/);
		expect(calls).toEqual([]);
	});

	it('streams events as curl prints them and resumes with Last-Event-ID', async () => {
		const frame = (id: number, event: object) =>
			`id: ${id}\nevent: x\ndata: ${JSON.stringify({ iteration: 1, ...event })}\n\n`;
		const text =
			frame(4, { type: 'assistant', text: 'hello' }) +
			frame(5, { type: 'run_finished', reason: 'complete', iterations: 1 }) +
			'event: end\ndata: {}\n\n';
		const { ref, calls } = sandbox({ chunks: [text.slice(0, 17), text.slice(17)] });
		const seen: string[] = [];
		const outcome = await new RalphClient(sandboxRalphFetch(ref), '').streamEvents(
			RUN.name,
			(entry) => {
				seen.push(`${entry.id}:${entry.event.type}`);
			},
			{ last_event_id: '3' }
		);
		expect(outcome).toBe('terminal');
		expect(seen).toEqual(['4:assistant', '5:run_finished']);
		expect(calls[0].follow).toBe(true);
		expect(calls[0].command).toContain("-H 'last-event-id: 3'");
		expect(calls[0].command).toContain('-N --fail');
	});

	it('reports a stream that ends without ralph’s end frame as a disconnect', async () => {
		const { ref } = sandbox({ chunks: ['id: 1\ndata: {"type":"assistant","text":"a"}\n\n'] });
		const outcome = await new RalphClient(sandboxRalphFetch(ref), '').streamEvents(
			RUN.name,
			() => {}
		);
		expect(outcome).toBe('disconnected');
	});
});

describe('parseCurlOutput', () => {
	it('splits on the last status mark only', () => {
		expect(parseCurlOutput('{"a":"\\n__beadsmith_status=1"}\n__beadsmith_status=201')).toEqual({
			status: 201,
			body: '{"a":"\\n__beadsmith_status=1"}'
		});
		expect(parseCurlOutput('no mark')).toBeUndefined();
		expect(parseCurlOutput('x\n__beadsmith_status=000')).toBeUndefined();
	});
});
