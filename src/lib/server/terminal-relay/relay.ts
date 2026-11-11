/**
 * The admin terminal relay's runner side (ADR-0021 rule 4, ADR-0015 rule 5):
 * attach to the hc terminal an agent runs in, inside its own sandbox, over
 * the channel Beadsmith already holds. Providers and chat runners resolve a
 * mission or chat to a sandbox and a terminal; this module opens the hc
 * connection and the attach stream. Nothing here keeps, scrubs or logs the
 * bytes: they go straight to the handlers.
 */
import type { HcClient, HcStreamEnd, HcTerminal } from '#lib/hc/client.js';
import type { SandboxDriver, SandboxInfo, SandboxRef } from '../e2b/sandbox.js';

/** Watch (hc `observe`: no typing, no resizing) or take over (keystrokes and size). */
export type RelayMode = 'watch' | 'take_over';

export interface TerminalAttachRequest {
	mode: RelayMode;
	cols: number;
	rows: number;
	/** Raw output. The returned promise is the stream's backpressure. */
	onData(bytes: Uint8Array): void | Promise<void>;
	/** The terminal's grid changed (watchers only; a taker sets it). */
	onResize?(size: { cols: number; rows: number }): void;
}

/** One open attach. `close` detaches and drops the hc connection. */
export interface TerminalRelay {
	readonly mode: RelayMode;
	/** The grid when the attach began. */
	readonly size: { cols: number; rows: number };
	readonly ended: Promise<HcStreamEnd>;
	/** Keystrokes; refused while watching. */
	write(bytes: Uint8Array): void;
	/** Refused while watching. */
	resize(cols: number, rows: number): void;
	close(): void;
}

export type TerminalRelayErrorCode = 'not_found' | 'conflict' | 'unavailable';

/** A refusal whose message may reach the browser. */
export class TerminalRelayError extends Error {
	readonly code: TerminalRelayErrorCode;
	constructor(code: TerminalRelayErrorCode, message: string) {
		super(message);
		this.name = 'TerminalRelayError';
		this.code = code;
	}
}

export const RELAY_GONE_MESSAGE = "This agent's sandbox is gone.";
export const RELAY_PAUSED_MESSAGE =
	"This agent's sandbox is paused. Watching does not wake it; take over to resume it.";
export const RELAY_FINISHED_MESSAGE = "This agent's terminal has finished.";
export const RELAY_UNAVAILABLE_MESSAGE = "This agent's terminal could not be reached.";
export const RELAY_NOT_STARTED_MESSAGE = 'This chat has no agent yet. Send it a message first.';

/** Scrollback lines in the first paint, so a watcher sees the current screen and some context. */
const ATTACH_HISTORY = 2_000;

export interface SandboxTerminalDeps {
	driver: SandboxDriver;
	connect_hc: (sandbox: SandboxRef) => Promise<HcClient>;
	/** The sandbox timeout to set when connecting, as the runner's own reads do. */
	idle_ms: number;
}

/**
 * Attach to the live terminal `pick` chooses in sandbox `sandbox_id`.
 * Watching never resumes a paused sandbox (looking should not bill compute
 * or wake an agent); taking over does, since the admin means to act.
 */
export async function attachSandboxTerminal(
	deps: SandboxTerminalDeps,
	sandbox_id: string,
	/** Choose the agent's terminal among the live ones, knowing the sandbox's metadata. */
	pick: (live: HcTerminal[], info: SandboxInfo) => HcTerminal | undefined,
	request: TerminalAttachRequest
): Promise<TerminalRelay> {
	let found: SandboxInfo | undefined;
	try {
		found = await deps.driver.info(sandbox_id);
	} catch {
		throw new TerminalRelayError('unavailable', RELAY_UNAVAILABLE_MESSAGE);
	}
	const info = found;
	if (info === undefined) throw new TerminalRelayError('conflict', RELAY_GONE_MESSAGE);
	if (info.state === 'paused' && request.mode === 'watch') {
		throw new TerminalRelayError('conflict', RELAY_PAUSED_MESSAGE);
	}
	let sandbox: SandboxRef;
	try {
		sandbox = await deps.driver.connect(sandbox_id, deps.idle_ms);
	} catch {
		throw new TerminalRelayError('conflict', RELAY_GONE_MESSAGE);
	}
	let client: HcClient;
	try {
		client = await deps.connect_hc(sandbox);
	} catch {
		throw new TerminalRelayError('unavailable', RELAY_UNAVAILABLE_MESSAGE);
	}
	return attachHcTerminal(client, (live) => pick(live, info), request);
}

/**
 * Attach to the live terminal `pick` chooses on an hc connection the caller
 * opened for this relay alone. The relay owns `client` from here: it is
 * closed when the stream ends, when the relay is closed, or when the attach
 * fails. Shared by the sandbox relay above and the forge mate runner, which
 * opens the connection over its own SSH `hc connect`.
 */
export async function attachHcTerminal(
	client: HcClient,
	pick: (live: HcTerminal[]) => HcTerminal | undefined,
	request: TerminalAttachRequest
): Promise<TerminalRelay> {
	try {
		const terminal = pick((await client.list()).filter((t) => t.state === 'live'));
		if (terminal === undefined) throw new TerminalRelayError('conflict', RELAY_FINISHED_MESSAGE);
		const observe = request.mode === 'watch';
		const attachment = await client.attach(
			terminal.address,
			{ cols: request.cols, rows: request.rows, observe, history: ATTACH_HISTORY },
			{ onData: request.onData, onResize: request.onResize }
		);
		// The relay is over when the stream ends; the connection goes with it.
		void attachment.ended.then(() => client.close());
		return {
			mode: request.mode,
			size: { cols: attachment.terminal.cols, rows: attachment.terminal.rows },
			ended: attachment.ended,
			write: (bytes) => attachment.write(bytes),
			resize: (cols, rows) => attachment.resize(cols, rows),
			close: () => {
				attachment.close();
				client.close();
			}
		};
	} catch (error) {
		client.close();
		if (error instanceof TerminalRelayError) throw error;
		throw new TerminalRelayError('unavailable', RELAY_UNAVAILABLE_MESSAGE);
	}
}
