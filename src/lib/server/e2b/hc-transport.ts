/**
 * An {@link HcTransport} to a Sand sandbox's hc core over the E2B process
 * channel (ADR-0021 rule 1): `beadsmith-hc connect` as a background command
 * with stdin open, the only way Beadsmith reaches the core. No port or
 * socket leaves the sandbox.
 *
 * The E2B SDK hands a command's output to callbacks as decoded text and
 * takes stdin as text, so hc's binary frames cross it base64-encoded, one
 * line per chunk each way (`sandbox/e2b/beadsmith-hc.cjs`, {@link HC_CARRIER}).
 */
import { connectHc, type HcClient, type HcTransport } from '#lib/hc/client.js';
import { HC_CARRIER } from './image.js';
import type { InteractiveCommand, SandboxRef } from './sandbox.js';

/** Start the carrier; its output goes to the callbacks. */
export type CarrierStart = (
	on_stdout: (chunk: string) => void,
	on_stderr: (chunk: string) => void
) => Promise<InteractiveCommand>;

export function carrierTransport(start: CarrierStart): HcTransport {
	const data: Array<(bytes: Uint8Array) => void> = [];
	const closed: Array<(error?: Error) => void> = [];
	let ended = false;
	let pending = '';
	const end = (error?: Error): void => {
		if (ended) return;
		ended = true;
		for (const listener of closed) listener(error);
	};
	const on_stdout = (chunk: string) => {
		if (ended) return;
		pending += chunk;
		let newline;
		while ((newline = pending.indexOf('\n')) !== -1) {
			const line = pending.slice(0, newline).trim();
			pending = pending.slice(newline + 1);
			if (line === '') continue;
			const buffer = Buffer.from(line, 'base64');
			const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
			for (const listener of data) listener(bytes);
		}
	};
	// hc's own diagnostics; the client reports a failed connection by itself.
	const on_stderr = () => {};

	// Writes keep their order: each waits for the previous one and for the start.
	let command: InteractiveCommand | undefined;
	let chain: Promise<unknown> = start(on_stdout, on_stderr).then(
		(started) => {
			command = started;
			void started
				.wait()
				.then((code) =>
					end(code === 0 ? undefined : new Error(`hc connect exited (${code ?? 'lost'})`))
				);
			if (ended) void started.kill().catch(() => undefined);
		},
		(error: unknown) => end(error instanceof Error ? error : new Error(String(error)))
	);

	return {
		write(bytes) {
			if (ended) return;
			const line = `${Buffer.from(bytes).toString('base64')}\n`;
			chain = chain.then(() => {
				if (ended || command === undefined) return;
				return command
					.sendStdin(line)
					.catch((error: unknown) =>
						end(error instanceof Error ? error : new Error(String(error)))
					);
			});
		},
		onData(listener) {
			data.push(listener);
		},
		onClose(listener) {
			closed.push(listener);
		},
		close() {
			end();
			void chain.then(async () => {
				await command?.closeStdin().catch(() => undefined);
				await command?.kill().catch(() => undefined);
			});
		}
	};
}

/** Open an hc client on the sandbox's core. */
export function connectSandboxHc(sandbox: SandboxRef): Promise<HcClient> {
	return connectHc(
		carrierTransport((on_stdout, on_stderr) =>
			sandbox.interactive(`${HC_CARRIER} connect`, { on_stdout, on_stderr })
		)
	);
}
