/**
 * An in-memory `ralph serve` `/v1` for unit tests, behind the same
 * {@link RalphFetch} a runner supplies. It answers the routes and shapes
 * ralph does (camelCase records, `id:`/`event:` SSE frames, an `end` frame
 * once a run has finished, `Last-Event-ID` resume) and records every request
 * so tests can check that only allowlisted calls were made.
 */
import type { RalphFetch, RalphRequest } from '../server/dispatch/ralph.js';

export interface FakeRalphRun {
	id: string;
	name: string;
	mode: 'run' | 'plan' | 'build' | 'reverse';
	status: 'running' | 'finished' | 'failed' | 'stopped';
	stopReason: string | null;
	currentIteration: number;
	maxIterations: number;
	/** Extra fields ralph sends that Beadsmith must drop. */
	[key: string]: unknown;
}

export class FakeRalph {
	readonly requests: RalphRequest[] = [];
	readonly runs = new Map<string, FakeRalphRun>();
	readonly iterations = new Map<string, Record<string, unknown>[]>();
	readonly reports = new Map<string, Record<string, unknown>>();
	readonly events = new Map<string, Array<{ id: number; event: Record<string, unknown> }>>();
	readonly steers: Array<{ name: string; text: string }> = [];
	readonly stops: Array<{ name: string; graceful: boolean }> = [];
	/** End the next stream without ralph's `end` frame, as a dropped channel would. */
	dropStream = false;
	#nextEvent = 1;

	addRun(run: Partial<FakeRalphRun> & { name: string }): FakeRalphRun {
		const full: FakeRalphRun = {
			id: `run-${run.name}`,
			mode: 'build',
			status: 'running',
			stopReason: null,
			currentIteration: 1,
			maxIterations: 10,
			pid: 4242,
			dir: '/home/agent/work',
			prompt: 'secret prompt text',
			callbackUrl: null,
			harness: 'claude',
			startedAt: '2026-11-11T10:00:00.000Z',
			updatedAt: '2026-11-11T10:05:00.000Z',
			alive: true,
			inputTokens: 10,
			outputTokens: 20,
			costUsd: 0.5,
			...run
		};
		this.runs.set(full.name, full);
		return full;
	}

	emit(name: string, event: Record<string, unknown>): number {
		const id = this.#nextEvent++;
		const list = this.events.get(name) ?? [];
		list.push({
			id,
			event: {
				ts: '2026-11-11T10:00:00.000Z',
				run: `run-${name}`,
				instance: name,
				iteration: 1,
				...event
			}
		});
		this.events.set(name, list);
		return id;
	}

	readonly fetch: RalphFetch = async (request) => {
		this.requests.push(request);
		const match = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(request.path);
		const run = match === null ? undefined : this.runs.get(match[1]);
		if (match === null || run === undefined) return json({ error: 'not found' }, 404);
		const route = `${request.method} ${match[2] ?? ''}`;
		const body: Record<string, unknown> =
			request.body === undefined ? {} : (JSON.parse(request.body) as Record<string, unknown>);
		switch (route) {
			case 'GET ':
				return json({
					run,
					iterations: this.iterations.get(run.name) ?? [],
					logPath: '/home/agent/.local/state/ralph/run.log'
				});
			case 'GET /report':
				return json(this.reports.get(run.name) ?? {});
			case 'POST /steer':
				this.steers.push({ name: run.name, text: String(body.text) });
				return json({ steerId: this.steers.length }, 201);
			case 'POST /stop':
				this.stops.push({ name: run.name, graceful: body.graceful === true });
				return json({ state: body.graceful === true ? 'stopping' : 'stopped', message: 'ok' });
			case 'GET /stream':
				return this.#stream(run, request.headers['last-event-id']);
			default:
				return json({ error: 'not found' }, 404);
		}
	};

	#stream(run: FakeRalphRun, last: string | undefined): Response {
		const after = last === undefined ? 0 : Number.parseInt(last, 10);
		const frames = (this.events.get(run.name) ?? [])
			.filter((entry) => entry.id > after)
			.map(
				(entry) =>
					`id: ${entry.id}\nevent: ${String(entry.event.type)}\ndata: ${JSON.stringify(entry.event)}\n\n`
			);
		frames.push(': ping\n\n');
		if (!this.dropStream && run.status !== 'running') {
			frames.push(`event: end\ndata: ${JSON.stringify({ reason: 'run_finished' })}\n\n`);
		}
		this.dropStream = false;
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				// Split mid-frame to exercise the SSE reader's buffering.
				const text = frames.join('');
				const half = Math.floor(text.length / 2);
				controller.enqueue(encoder.encode(text.slice(0, half)));
				controller.enqueue(encoder.encode(text.slice(half)));
				controller.close();
			}
		});
		return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
	}
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}
