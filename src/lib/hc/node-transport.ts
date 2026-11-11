/**
 * An {@link HcTransport} over a child process's stdio, for `hc connect` run
 * through `ssh` from the forge runner (ADR-0021 rule 1). The child is the
 * whole channel: closing the transport ends it, and its exit closes the
 * transport.
 */

import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { HcTransport } from './client.js';

export function childProcessTransport(
	child: ChildProcessByStdio<Writable, Readable, Readable | null>
): HcTransport {
	const data: Array<(bytes: Uint8Array) => void> = [];
	const closed: Array<(error?: Error) => void> = [];
	let ended = false;
	const end = (error?: Error): void => {
		if (ended) return;
		ended = true;
		for (const listener of closed) listener(error);
	};
	child.stdout.on('data', (chunk: Buffer) => {
		const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length);
		for (const listener of data) listener(bytes);
	});
	child.stdout.on('end', () => end());
	child.on('error', (error) => end(error));
	child.on('exit', (code, signal) =>
		end(
			code === 0 || signal === 'SIGTERM'
				? undefined
				: new Error(`hc connect exited (${code ?? signal})`)
		)
	);
	child.stdin.on('error', (error) => end(error));
	return {
		write(bytes) {
			if (!ended) child.stdin.write(bytes);
		},
		onData(listener) {
			data.push(listener);
		},
		onClose(listener) {
			closed.push(listener);
		},
		close() {
			if (!child.stdin.destroyed) child.stdin.end();
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
		}
	};
}
