#!/usr/bin/env node
// Carry `hc connect` over E2B's text-only process channel (ADR-0021 rule 1).
//
//   beadsmith-hc connect
//
// Installed by the template as /usr/local/bin/beadsmith-hc; kept as .cjs here
// so Node runs it as CommonJS in both places.
//
// hc's framed protocol is binary, but the E2B SDK hands a command's output
// to Beadsmith as decoded text, which would corrupt frames. This wrapper
// runs `hc connect` and changes the encoding only:
//
//   stdout  every chunk hc writes, as one base64 line ("\n"-terminated)
//   stdin   base64 lines, decoded and written to hc in order
//
// Nothing here parses or filters hc's protocol, opens a socket or a port, or
// reaches another machine: it is the same `hc connect` a shell would run, as
// the sandbox's user, against the core on its default Unix socket. Beadsmith
// starts it with the E2B SDK (src/lib/server/e2b/image.ts, HC_CARRIER).
//
// Exit status: hc's own, 2 for usage or a line that is not base64.
'use strict';

const { spawn } = require('node:child_process');
const { constants } = require('node:os');

const BASE64_LINE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

if (process.argv.length !== 3 || process.argv[2] !== 'connect') {
	process.stderr.write('usage: beadsmith-hc connect\n');
	process.exit(2);
}

const hc = spawn('hc', ['connect'], { stdio: ['pipe', 'pipe', 'inherit'] });

hc.on('error', (error) => {
	process.stderr.write(`beadsmith-hc: cannot run hc: ${error.message}\n`);
	process.exit(127);
});

// hc → Beadsmith. Pause hc's output while our stdout is full, so a slow
// reader slows hc down instead of growing this process's memory.
hc.stdout.on('data', (chunk) => {
	if (!process.stdout.write(`${chunk.toString('base64')}\n`)) {
		hc.stdout.pause();
		process.stdout.once('drain', () => hc.stdout.resume());
	}
});

// Beadsmith → hc.
let pending = '';
let failed = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (text) => {
	if (failed) return;
	pending += text;
	let newline;
	while ((newline = pending.indexOf('\n')) !== -1) {
		const line = pending.slice(0, newline).replace(/\r$/, '');
		pending = pending.slice(newline + 1);
		if (line === '') continue;
		if (!BASE64_LINE.test(line)) {
			// A corrupt frame would desynchronize hc's stream; stop instead.
			failed = true;
			process.stderr.write('beadsmith-hc: input line is not base64\n');
			hc.stdin.end();
			hc.kill('SIGTERM');
			process.exitCode = 2;
			return;
		}
		if (!hc.stdin.write(Buffer.from(line, 'base64'))) {
			process.stdin.pause();
			hc.stdin.once('drain', () => process.stdin.resume());
		}
	}
});
process.stdin.on('end', () => hc.stdin.end());
// hc gone first: writes would fail with EPIPE, which is not ours to report.
hc.stdin.on('error', () => {});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
	process.on(signal, () => hc.kill(signal));
}

hc.on('close', (code, signal) => {
	if (process.exitCode === undefined)
		process.exitCode = code ?? 128 + (constants.signals[signal] ?? 0);
	// Let buffered output reach Beadsmith before exiting.
	process.stdout.end(() => process.exit());
});
