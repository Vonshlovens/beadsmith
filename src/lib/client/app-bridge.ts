/**
 * The host side of a sandboxed app's bridge (ADR-0025 rule 6), in the MCP
 * Apps (SEP-1865) wire shape: JSON-RPC 2.0 over `postMessage` between the
 * page and its `<iframe sandbox="allow-scripts">`. The app runs in an opaque
 * origin with no network (the frame route's CSP), so this is its only way to
 * reach Beadsmith, and everything it asks for is answered as the viewer by
 * the server, never by the app's author.
 *
 * Beadsmith implements the subset an app needs:
 * - `ui/initialize` (request): answered with the host's info and context
 *   (theme, viewer role), so an app can adapt without reading the page.
 * - `tools/call` (request): forwarded for allowlisted reads to
 *   `POST /api/apps/:slug/call`; the answer is an MCP `CallToolResult`, and a
 *   tool's refusal is a result with `isError`, as MCP has it. An allowlisted
 *   action (a todo change or a mission launch) first waits for the host
 *   confirmation, which the page draws outside the frame from the action's
 *   name and arguments (`describeBridgeAction`); the app cannot draw, skip or
 *   pre-answer it, and only a confirmed call goes to
 *   `POST /api/apps/:slug/actions` with exactly those arguments. A member's
 *   action is refused here with the reason, before any dialog, and one
 *   confirmation is open at a time, so an app cannot stack dialogs.
 * - `ping` (request), `ui/notifications/initialized` and
 *   `ui/notifications/size-changed` (notifications; the last sizes the frame).
 *
 * An app opens at `/views/<slug>` directly rather than as some tool call's
 * result, so the host has no tool input or result of its own to announce and
 * sends no `ui/notifications/tool-input` or `tool-result`: a tool's result
 * reaches the app as the response to its own `tools/call`.
 *
 * Every frame is checked before anything acts on it: it must come from this
 * host's iframe window, from the opaque origin (`"null"`; a frame that
 * somehow holds a same-origin document is not the app), fit the 64 KB frame
 * limit and be a JSON-RPC message. Anything else is dropped; drops other than
 * foreign windows (which are normal: extensions, other frames) are logged.
 * Calls are also capped here at the server's rate, so an app looping on
 * `tools/call` spends no requests once it is over the limit.
 */
import { BRIDGE_FRAME_MAX_BYTES } from '#lib/apps.js';
import { isBridgeAction } from '#lib/grown.js';
import type { BridgeActionCall } from '#lib/client/surfaces.js';
import { PRODUCT_NAME } from '#lib/product.js';
import type { SurfaceBindingResult } from '#lib/surfaces.js';
import type { AccountRole, ResolvedTheme } from '#lib/types.js';

/**
 * The iframe's `sandbox` flags: scripts only. No `allow-same-origin` (the
 * app gets an opaque origin, so no Beadsmith cookies, storage or DOM), and
 * no top navigation, popups, forms or modals.
 */
export const APP_FRAME_SANDBOX = 'allow-scripts';

/** The MCP Apps protocol version the host answers `ui/initialize` with. */
export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';

/** Calls an app may make per window, matching the server's bridge limit. */
export const APP_CALLS_PER_WINDOW = 60;
export const APP_CALL_WINDOW_MS = 60_000;

/** Calls waiting on the server at once; more are refused until one returns. */
export const APP_CALLS_IN_FLIGHT = 4;

/** Frame heights an app may ask for with `size-changed`, in CSS pixels. */
export const APP_FRAME_MIN_HEIGHT = 160;
export const APP_FRAME_MAX_HEIGHT = 4000;
export const APP_FRAME_DEFAULT_HEIGHT = 480;

/** JSON-RPC errors the host answers with. */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** What the host tells an app about where it runs (`ui/initialize`). */
export interface AppHostContext {
	theme: ResolvedTheme;
	displayMode: 'inline';
	platform: 'web';
	/** Who the app reads as: its calls are answered with this role's permissions. */
	viewer: { role: AccountRole };
}

type JsonRpcId = string | number;

/** A message the host sends: a response to one of the app's requests. */
export type HostMessage =
	| { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
	| { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string } };

/** The subset of a `MessageEvent` the bridge reads. */
export interface BridgeEvent {
	source: unknown;
	origin: string;
	data: unknown;
}

export interface AppBridgeDeps {
	/** The iframe's current window; frames from any other source are not this app's. */
	frame(): unknown;
	/** Send one message to the iframe. */
	post(message: HostMessage): void;
	/** Run an allowlisted read as the viewer. Throws on a transport or HTTP failure. */
	callTool(name: string, args: Record<string, unknown>): Promise<SurfaceBindingResult>;
	/**
	 * Show the host confirmation for an action, outside the frame; true when
	 * the person confirmed it.
	 */
	confirmAction(call: BridgeActionCall): Promise<boolean>;
	/**
	 * Run a confirmed action as the viewer with exactly the confirmed call.
	 * Resolves with the crew tool's result; throws with the reason on a refusal.
	 */
	runAction(call: BridgeActionCall): Promise<unknown>;
	hostContext(): AppHostContext;
	/** The app asked for a height (already clamped). */
	onHeight?(height: number): void;
	/** A dropped or refused frame, for the console. */
	warn?(reason: string): void;
	/** Milliseconds; tests pass a clock. */
	now?(): number;
}

export interface AppBridge {
	/** Handle one `message` event from the window. */
	receive(event: BridgeEvent): Promise<void>;
}

/** An MCP `CallToolResult`. */
export interface AppToolResult {
	content: { type: 'text'; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError: boolean;
}

/**
 * The frame route for an app. `theme` picks the token block inside the
 * frame, which cannot read the page's preference; `r` makes a new revision
 * a new URL so the frame reloads when the page does.
 * @param slug The app's slug.
 * @param theme The page's resolved theme.
 * @param revision The revision on screen.
 */
export function appFrameSrc(slug: string, theme: ResolvedTheme, revision: number): string {
	const query = new URLSearchParams({ theme, r: String(revision) });
	return `/api/apps/${encodeURIComponent(slug)}/frame?${query}`;
}

/**
 * Clamp a height an app asks for, so it can neither collapse to nothing nor
 * push the rest of the page out of reach.
 * @param height The requested height in CSS pixels.
 */
export function clampFrameHeight(height: number): number {
	return Math.min(APP_FRAME_MAX_HEIGHT, Math.max(APP_FRAME_MIN_HEIGHT, Math.round(height)));
}

/** UTF-8 bytes of a value as JSON, or undefined when it is not JSON (a cycle, a function). */
export function frameBytes(value: unknown): number | undefined {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? undefined : new TextEncoder().encode(text).length;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
	return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * A read's result as MCP has it. The data goes as `structuredContent` when it
 * is an object, and always as JSON text, which is what an MCP client without
 * structured content reads.
 * @param result The read as the server answered it.
 */
export function toolResult(result: SurfaceBindingResult): AppToolResult {
	if (!result.ok) {
		return { content: [{ type: 'text', text: result.message }], isError: true };
	}
	return dataResult(
		result.truncated && isRecord(result.data) ? { ...result.data, truncated: true } : result.data
	);
}

/** A successful result: the data as JSON text, and as `structuredContent` when it is an object. */
function dataResult(data: unknown): AppToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify(data) }],
		...(isRecord(data) ? { structuredContent: data } : {}),
		isError: false
	};
}

function errorResult(message: string): AppToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

/** Why an action was not run, for a viewer who may not run any. */
export const MEMBER_ACTION_REFUSAL =
	'App actions need an admin account. This app acts as you, and you are signed in as a member.';

/**
 * The bridge for one framed app.
 * @param deps Where frames come from and go, and how a read runs.
 */
export function createAppBridge(deps: AppBridgeDeps): AppBridge {
	const now = deps.now ?? Date.now;
	const warn = deps.warn ?? (() => {});
	const calls: number[] = [];
	let in_flight = 0;
	/** True while a host confirmation is open; a second action is refused. */
	let confirming = false;

	function send(message: HostMessage) {
		const bytes = frameBytes(message);
		if (bytes !== undefined && bytes <= BRIDGE_FRAME_MAX_BYTES) {
			deps.post(message);
			return;
		}
		// A tool result over the frame limit: drop the duplicate structured
		// copy first, and if the text alone is still too big, say so.
		if ('result' in message && isRecord(message.result) && 'structuredContent' in message.result) {
			const { structuredContent: _dropped, ...rest } = message.result;
			send({ ...message, result: rest });
			return;
		}
		deps.post({
			jsonrpc: '2.0',
			id: message.id,
			error: {
				code: INTERNAL_ERROR,
				message: `The answer is larger than the ${BRIDGE_FRAME_MAX_BYTES}-byte bridge frame limit.`
			}
		});
	}

	/** Take one call slot, or say why not. */
	function admit(): string | undefined {
		const at = now();
		while (calls.length > 0 && calls[0] <= at - APP_CALL_WINDOW_MS) calls.shift();
		if (calls.length >= APP_CALLS_PER_WINDOW) {
			return `This app is calling too often (at most ${APP_CALLS_PER_WINDOW} calls a minute). Wait a moment and try again.`;
		}
		if (in_flight >= APP_CALLS_IN_FLIGHT) {
			return `At most ${APP_CALLS_IN_FLIGHT} calls may wait at once. Wait for one to return.`;
		}
		calls.push(at);
		return undefined;
	}

	async function callTool(id: JsonRpcId, params: unknown) {
		if (
			!isRecord(params) ||
			typeof params.name !== 'string' ||
			(params.arguments !== undefined && !isRecord(params.arguments))
		) {
			send({
				jsonrpc: '2.0',
				id,
				error: { code: INVALID_PARAMS, message: 'tools/call needs { name, arguments? }' }
			});
			return;
		}
		const name = params.name;
		const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
		if (isBridgeAction(name)) {
			send({ jsonrpc: '2.0', id, result: await action({ tool: name, input: args }) });
			return;
		}
		const refused = admit();
		if (refused !== undefined) {
			send({ jsonrpc: '2.0', id, result: errorResult(refused) });
			return;
		}
		in_flight += 1;
		let result: AppToolResult;
		try {
			result = toolResult(await deps.callTool(name, args));
		} catch (error) {
			result = errorResult(error instanceof Error ? error.message : 'The call failed.');
		} finally {
			in_flight -= 1;
		}
		send({ jsonrpc: '2.0', id, result });
	}

	/**
	 * An action: refused for a member, then the host confirmation, then the
	 * run with the confirmed call, as the viewer.
	 */
	async function action(call: BridgeActionCall): Promise<AppToolResult> {
		if (deps.hostContext().viewer.role !== 'admin') return errorResult(MEMBER_ACTION_REFUSAL);
		if (confirming) {
			return errorResult(
				'A confirmation is already open. Wait for the person to answer it before asking again.'
			);
		}
		const refused = admit();
		if (refused !== undefined) return errorResult(refused);
		confirming = true;
		let confirmed: boolean;
		try {
			confirmed = await deps.confirmAction(call);
		} catch {
			confirmed = false;
		} finally {
			confirming = false;
		}
		if (!confirmed) return errorResult(`The person declined ${call.tool}; nothing ran.`);
		in_flight += 1;
		try {
			return dataResult(await deps.runAction(call));
		} catch (error) {
			return errorResult(error instanceof Error ? error.message : 'The action failed.');
		} finally {
			in_flight -= 1;
		}
	}

	async function receive(event: BridgeEvent): Promise<void> {
		const frame = deps.frame();
		if (frame === null || frame === undefined || event.source !== frame) return;
		if (event.origin !== 'null') {
			warn(`dropped a frame from origin ${event.origin}: the app's document is not sandboxed`);
			return;
		}
		const bytes = frameBytes(event.data);
		if (bytes === undefined) {
			warn('dropped a frame that is not JSON');
			return;
		}
		if (bytes > BRIDGE_FRAME_MAX_BYTES) {
			warn(`dropped a ${bytes}-byte frame (the limit is ${BRIDGE_FRAME_MAX_BYTES})`);
			return;
		}
		const message = event.data;
		if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
			// The host sends no requests, so a response from the app is malformed too.
			warn('dropped a frame that is not a JSON-RPC 2.0 request or notification');
			return;
		}
		if (message.id === undefined) {
			if (message.method === 'ui/notifications/size-changed') {
				const height = isRecord(message.params) ? message.params.height : undefined;
				if (typeof height === 'number' && Number.isFinite(height)) {
					deps.onHeight?.(clampFrameHeight(height));
				}
			}
			// `ui/notifications/initialized` and anything else: nothing to do.
			return;
		}
		if (!isId(message.id)) {
			warn('dropped a request whose id is not a string or number');
			return;
		}
		const id = message.id;
		switch (message.method) {
			case 'ui/initialize':
				send({
					jsonrpc: '2.0',
					id,
					result: {
						protocolVersion: MCP_APPS_PROTOCOL_VERSION,
						hostInfo: { name: PRODUCT_NAME, version: '1' },
						hostCapabilities: { serverTools: {} },
						hostContext: deps.hostContext()
					}
				});
				return;
			case 'ping':
				send({ jsonrpc: '2.0', id, result: {} });
				return;
			case 'tools/call':
				await callTool(id, message.params);
				return;
			default:
				send({
					jsonrpc: '2.0',
					id,
					error: {
						code: METHOD_NOT_FOUND,
						message: `${message.method} is not supported by this host`
					}
				});
		}
	}

	return { receive };
}
