import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { APP_FRAME_CSP } from '#lib/server/grown/app-spec.js';
import type { SurfaceBindingResult } from '#lib/surfaces.js';
import {
	APP_CALLS_IN_FLIGHT,
	APP_CALLS_PER_WINDOW,
	APP_CALL_WINDOW_MS,
	APP_FRAME_MAX_HEIGHT,
	APP_FRAME_MIN_HEIGHT,
	APP_FRAME_SANDBOX,
	MCP_APPS_PROTOCOL_VERSION,
	appFrameSrc,
	createAppBridge,
	type AppBridgeDeps,
	type HostMessage
} from './app-bridge.js';

const FRAME = { name: 'the app frame' };
const OTHER = { name: 'another window' };

function setup(overrides: Partial<AppBridgeDeps> = {}) {
	const posted: HostMessage[] = [];
	const warnings: string[] = [];
	const heights: number[] = [];
	let clock = 1_000_000;
	const callTool = vi.fn(async (): Promise<SurfaceBindingResult> => ({
		ok: true,
		yields: 'issues',
		data: { issues: [{ id: 'p-1' }] }
	}));
	const bridge = createAppBridge({
		frame: () => FRAME,
		post: (message) => posted.push(message),
		callTool,
		hostContext: () => ({
			theme: 'dark',
			displayMode: 'inline',
			platform: 'web',
			viewer: { role: 'member' }
		}),
		onHeight: (height) => heights.push(height),
		warn: (reason) => warnings.push(reason),
		now: () => clock,
		...overrides
	});
	const send = (data: unknown, source: unknown = FRAME, origin = 'null') =>
		bridge.receive({ source, origin, data });
	return {
		bridge,
		send,
		posted,
		warnings,
		heights,
		callTool,
		tick: (ms: number) => (clock += ms)
	};
}

const request = (id: number, method: string, params?: unknown) => ({
	jsonrpc: '2.0',
	id,
	method,
	...(params === undefined ? {} : { params })
});

describe('the app frame', () => {
	it('is sandboxed to scripts alone: no same origin, so no cookies, storage or parent DOM', () => {
		expect(APP_FRAME_SANDBOX).toBe('allow-scripts');
		// The frame document sandboxes itself the same way and has no network,
		// so `fetch`, XHR and WebSocket fail even if it is opened directly.
		expect(APP_FRAME_CSP).toContain('sandbox allow-scripts');
		expect(APP_FRAME_CSP).toContain("connect-src 'none'");
		expect(APP_FRAME_CSP).not.toContain('allow-same-origin');
	});

	it('lets the page frame only same-origin documents, so an app cannot navigate itself away', () => {
		const config = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8');
		expect(config).toMatch(/'frame-src': \['self'\]/);
	});

	it('loads from the frame route with the theme and revision in the URL', () => {
		expect(appFrameSrc('burn down', 'dark', 3)).toBe('/api/apps/burn%20down/frame?theme=dark&r=3');
	});
});

describe('app bridge frame checks', () => {
	it("ignores another window's messages without logging them", async () => {
		const { send, posted, warnings, callTool } = setup();
		await send(request(1, 'tools/call', { name: 'ready_work' }), OTHER);
		expect(posted).toEqual([]);
		expect(warnings).toEqual([]);
		expect(callTool).not.toHaveBeenCalled();
	});

	it('drops and logs a frame whose document is not in the opaque origin', async () => {
		const { send, posted, warnings } = setup();
		await send(request(1, 'ui/initialize'), FRAME, 'https://beadsmith.example');
		expect(posted).toEqual([]);
		expect(warnings).toHaveLength(1);
	});

	it('drops an oversized frame, a non-JSON one, and anything not JSON-RPC 2.0', async () => {
		const { send, posted, warnings, callTool } = setup();
		await send(
			request(1, 'tools/call', { name: 'ready_work', arguments: { pad: 'x'.repeat(70_000) } })
		);
		const cyclic: Record<string, unknown> = { jsonrpc: '2.0', id: 2, method: 'ping' };
		cyclic.self = cyclic;
		await send(cyclic);
		await send({ id: 3, method: 'ping' });
		await send('ping');
		await send({ jsonrpc: '2.0', id: 4, result: {} }); // the host sends no requests
		await send({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' });
		expect(posted).toEqual([]);
		expect(callTool).not.toHaveBeenCalled();
		expect(warnings).toHaveLength(6);
	});

	it('does nothing when the frame has no window yet', async () => {
		const { send, posted } = setup({ frame: () => null });
		await send(request(1, 'ping'), null);
		expect(posted).toEqual([]);
	});
});

describe('app bridge methods', () => {
	it('answers ui/initialize with the host context: theme and the role the app reads as', async () => {
		const { send, posted } = setup();
		await send(request(1, 'ui/initialize', { protocolVersion: MCP_APPS_PROTOCOL_VERSION }));
		expect(posted).toEqual([
			{
				jsonrpc: '2.0',
				id: 1,
				result: expect.objectContaining({
					protocolVersion: MCP_APPS_PROTOCOL_VERSION,
					hostContext: {
						theme: 'dark',
						displayMode: 'inline',
						platform: 'web',
						viewer: { role: 'member' }
					}
				})
			}
		]);
	});

	it('forwards tools/call and answers with an MCP tool result', async () => {
		const { send, posted, callTool } = setup();
		await send(request(7, 'tools/call', { name: 'ready_work', arguments: { limit: 5 } }));
		expect(callTool).toHaveBeenCalledWith('ready_work', { limit: 5 });
		expect(posted).toEqual([
			{
				jsonrpc: '2.0',
				id: 7,
				result: {
					content: [{ type: 'text', text: '{"issues":[{"id":"p-1"}]}' }],
					structuredContent: { issues: [{ id: 'p-1' }] },
					isError: false
				}
			}
		]);
	});

	it("passes a tool's refusal, and a failed request, to the app as a tool error", async () => {
		const refusing = setup({
			callTool: async () => ({ ok: false, code: 'forbidden', message: 'needs an admin' })
		});
		await refusing.send(request(1, 'tools/call', { name: 'list_todos' }));
		expect(refusing.posted[0]).toEqual({
			jsonrpc: '2.0',
			id: 1,
			result: { content: [{ type: 'text', text: 'needs an admin' }], isError: true }
		});

		const failing = setup({
			callTool: async () => {
				throw new Error('create_todo is not a read an app may call.');
			}
		});
		await failing.send(request(2, 'tools/call', { name: 'create_todo' }));
		expect(failing.posted[0]).toMatchObject({
			id: 2,
			result: { isError: true, content: [{ text: 'create_todo is not a read an app may call.' }] }
		});
	});

	it('marks a result the server cut by whole rows', async () => {
		const { send, posted } = setup({
			callTool: async () => ({
				ok: true,
				yields: 'issues',
				data: { issues: [], total: 900 },
				truncated: true
			})
		});
		await send(request(1, 'tools/call', { name: 'ready_work' }));
		expect(posted[0]).toMatchObject({
			result: { structuredContent: { issues: [], total: 900, truncated: true } }
		});
	});

	it('refuses tools/call without a name, and an unknown method', async () => {
		const { send, posted, callTool } = setup();
		await send(request(1, 'tools/call', { arguments: {} }));
		await send(request(2, 'tools/call', { name: 'ready_work', arguments: [1] }));
		await send(request(3, 'resources/read', { uri: 'ui://x' }));
		expect(callTool).not.toHaveBeenCalled();
		expect(posted.map((m) => ('error' in m ? m.error.code : null))).toEqual([
			-32602, -32602, -32601
		]);
	});

	it('answers ping, and sizes the frame within bounds on size-changed', async () => {
		const { send, posted, heights } = setup();
		await send(request(1, 'ping'));
		expect(posted).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
		for (const height of [600.4, 10, 1e9, Number.NaN]) {
			await send({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height } });
		}
		await send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
		expect(heights).toEqual([600, APP_FRAME_MIN_HEIGHT, APP_FRAME_MAX_HEIGHT]);
	});

	it('never sends a frame over the limit: the structured copy goes first, then the answer', async () => {
		const big = 'y'.repeat(40_000);
		const halved = setup({
			callTool: async () => ({ ok: true, yields: 'issue', data: { body: big } })
		});
		await halved.send(request(1, 'tools/call', { name: 'show_issue' }));
		expect(halved.posted[0]).toMatchObject({ id: 1, result: { isError: false } });
		expect('structuredContent' in (halved.posted[0] as { result: object }).result).toBe(false);

		const huge = setup({
			callTool: async () => ({ ok: true, yields: 'issue', data: { body: 'z'.repeat(70_000) } })
		});
		await huge.send(request(2, 'tools/call', { name: 'show_issue' }));
		expect(huge.posted[0]).toMatchObject({ id: 2, error: { code: -32603 } });
	});
});

describe('app bridge call limits', () => {
	it(`allows ${APP_CALLS_PER_WINDOW} calls a window, then refuses without a request`, async () => {
		const { send, posted, callTool, tick } = setup();
		for (let index = 0; index < APP_CALLS_PER_WINDOW; index += 1) {
			await send(request(index, 'tools/call', { name: 'ready_work' }));
		}
		await send(request(99, 'tools/call', { name: 'ready_work' }));
		expect(callTool).toHaveBeenCalledTimes(APP_CALLS_PER_WINDOW);
		expect(posted.at(-1)).toMatchObject({ id: 99, result: { isError: true } });

		tick(APP_CALL_WINDOW_MS);
		await send(request(100, 'tools/call', { name: 'ready_work' }));
		expect(callTool).toHaveBeenCalledTimes(APP_CALLS_PER_WINDOW + 1);
	});

	it(`lets ${APP_CALLS_IN_FLIGHT} calls wait at once`, async () => {
		const pending: (() => void)[] = [];
		const callTool = vi.fn(
			() =>
				new Promise<SurfaceBindingResult>((resolve) =>
					pending.push(() => resolve({ ok: true, yields: 'issues', data: { issues: [] } }))
				)
		);
		const { send, posted } = setup({ callTool });
		const waiting = Array.from({ length: APP_CALLS_IN_FLIGHT }, (_, index) =>
			send(request(index, 'tools/call', { name: 'ready_work' }))
		);
		await send(request(50, 'tools/call', { name: 'ready_work' }));
		expect(callTool).toHaveBeenCalledTimes(APP_CALLS_IN_FLIGHT);
		expect(posted).toEqual([
			expect.objectContaining({ id: 50, result: expect.objectContaining({ isError: true }) })
		]);
		for (const resolve of pending) resolve();
		await Promise.all(waiting);
		expect(posted).toHaveLength(APP_CALLS_IN_FLIGHT + 1);
	});
});
