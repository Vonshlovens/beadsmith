// Harmless live-test fixture; installed only by the operator test procedure.
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const id = args[args.indexOf('--session-id') + 1];
const depth = Number(args[args.indexOf('--depth') + 1] ?? 0) || 0;
// Resolve tools by name in the same transient service as real chat workloads.
if (depth === 0) {
	for (const command of ['git', 'curl', 'rg', 'ls', 'bash'])
		execFileSync(command, ['--version'], { stdio: 'ignore' });
}
appendFileSync(`/var/lib/agent/home/work/lifecycle-${id}.pids`, `${process.pid}\n`);
process.on('SIGTERM', () => {});
if (depth < 2) {
	spawn(
		process.execPath,
		[import.meta.filename, '--session-id', id, '--depth', String(depth + 1)],
		{ detached: true, stdio: 'ignore' }
	).unref();
}
if (depth === 0) {
	console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
	createInterface({ input: process.stdin }).on('line', () => {
		console.log(
			JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 })
		);
	});
}
setInterval(() => {}, 1000);
