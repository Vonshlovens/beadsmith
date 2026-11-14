// Harmless live-test fixture for fleet/hosts/forge/guest-lifecycle.test.mjs,
// installed by that test into each chat it starts (docs/operations/host-forge.md).
// It stands in for an agent CLI in an hc terminal: it resolves tools by name
// (the terminal must have the system PATH), then starts two generations of
// descendants in its own session, all ignoring SIGTERM and SIGHUP, so that
// ending it takes more than a polite signal to the terminal's program.
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const id = args[args.indexOf('--session-id') + 1];
const depth = Number(args[args.indexOf('--depth') + 1] ?? 0) || 0;
if (depth === 0) {
	for (const command of ['git', 'curl', 'rg', 'ls', 'bash'])
		execFileSync(command, ['--version'], { stdio: 'ignore' });
}
// HOME is the chat's home, from its unit.
appendFileSync(`${process.env.HOME}/work/lifecycle-${id}.pids`, `${process.pid}\n`);
for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => {});
if (depth < 2) {
	spawn(
		process.execPath,
		[import.meta.filename, '--session-id', id, '--depth', String(depth + 1)],
		{ stdio: 'ignore' }
	);
}
setInterval(() => {}, 1000);
