// Run on the host against its deployed guest after installing the two test
// fixtures as described in docs/operations/host-forge.md. No model call occurs.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore } from '../../../src/lib/mate-runner/event-log.ts';
import { createRunnerHandler } from '../../../src/lib/mate-runner/server.ts';
import { sshSpawner } from '../../../src/lib/mate-runner/spawn.ts';
import { signRequest } from '../../../src/lib/mate-runner/signature.ts';
const ssh = sshSpawner({
	target: 'agent@10.100.0.2',
	identity_file: '/var/lib/mate-runner/ssh/agent_ed25519',
	known_hosts_file: '/var/lib/microvm-keys/known_hosts',
	workdir: '/var/lib/agent/home/work',
	claude: '/var/lib/agent/home/work/lifecycle-fake'
});
const root = (command) =>
	execFileSync('/run/current-system/sw/bin/mate-ssh', [command], { encoding: 'utf8' }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pids = (id) =>
	root(`cat /var/lib/agent/home/work/lifecycle-${id}.pids`).split('\n').map(Number);
function alive(ids) {
	return root(`for p in ${ids.join(' ')}; do test ! -e /proc/$p/stat || cat /proc/$p/stat; done`)
		.split('\n')
		.filter((line) => line && !/^\d+ \(.*\) Z /.test(line)).length;
}
const keeperId = randomUUID();
const keeper = ssh({ session_id: keeperId, resume: false, scope: null });
keeper.stdout.resume();
keeper.stderr.resume();
const dir = mkdtempSync(join(tmpdir(), 'guest-lifecycle-'));
const processes = new Map();
const handler = createRunnerHandler({
	secret: 'fixture-secret-with-at-least-32-characters',
	store: new ChatStore(dir),
	max_live_sessions: 1,
	spawn: (launch) => {
		const child = ssh(launch);
		processes.set(launch.session_id, child);
		return child;
	}
});
const server = createServer((req, res) => void handler(req, res)).listen(18787, '127.0.0.1');
await once(server, 'listening');
async function request(method, path, input, port = 18787) {
	const body = input ? JSON.stringify(input) : '';
	const ts = String(Math.floor(Date.now() / 1000));
	const res = await fetch(`http://127.0.0.1:${port}` + path, {
		method,
		headers: {
			'x-beadsmith-timestamp': ts,
			'x-beadsmith-signature': signRequest(
				'fixture-secret-with-at-least-32-characters',
				ts,
				method,
				path,
				body
			)
		},
		...(body ? { body } : {})
	});
	assert.ok(res.ok, `${method} ${path}: ${res.status}`);
	return res;
}
const ids = [];
async function launch(name) {
	const id = randomUUID();
	ids.push(id);
	await request('POST', `/v1/mate/chats/${name}/messages`, {
		session_id: id,
		message_id: 'fixture',
		prompt: 'fixture',
		scope: null
	});
	await delay(1000);
	assert.equal(pids(id).length, 3);
	return id;
}
async function gone(id, label) {
	await delay(3000);
	assert.equal(alive(pids(id)), 0, label);
	assert.equal(alive(pids(keeperId)), 3, 'independent chat survives ' + label);
	console.log('PASS', label);
}
try {
	await delay(1000);
	assert.equal(pids(keeperId).length, 3);
	const deleted = await launch('delete');
	await request('DELETE', '/v1/mate/chats/delete');
	await gone(deleted, 'delete');
	const evicted = await launch('evicted');
	const next = await launch('next');
	await gone(evicted, 'idle eviction');
	processes.get(next).kill('SIGKILL');
	await gone(next, 'abrupt SSH client disconnect');
	const stopped = await launch('stop');
	await handler.close();
	await gone(stopped, 'runner close hook');
	writeFileSync(join(dir, 'secret'), 'fixture-secret-with-at-least-32-characters', { mode: 0o600 });
	const runner = spawn(
		process.execPath,
		[
			'--import',
			new URL('../../../scripts/ts-resolve.mjs', import.meta.url).pathname,
			new URL('../../../scripts/mate-runner.ts', import.meta.url).pathname
		],
		{
			env: {
				...process.env,
				MATE_RUNNER_LISTEN: '127.0.0.1:18788',
				MATE_RUNNER_SECRET_FILE: join(dir, 'secret'),
				MATE_RUNNER_STATE_DIR: join(dir, 'signal-test'),
				MATE_AGENT_SSH: 'agent@10.100.0.2',
				MATE_AGENT_SSH_KEY: '/var/lib/mate-runner/ssh/agent_ed25519',
				MATE_AGENT_KNOWN_HOSTS: '/var/lib/microvm-keys/known_hosts',
				MATE_AGENT_WORKDIR: '/var/lib/agent/home/work',
				MATE_AGENT_CLAUDE: '/var/lib/agent/home/work/lifecycle-fake'
			},
			stdio: 'ignore'
		}
	);
	try {
		await delay(1000);
		const id = randomUUID();
		ids.push(id);
		await request(
			'POST',
			'/v1/mate/chats/signal/messages',
			{ session_id: id, message_id: 'fixture', prompt: 'fixture', scope: null },
			18788
		);
		await delay(1000);
		assert.equal(pids(id).length, 3);
		const exited = once(runner, 'exit');
		runner.kill('SIGTERM');
		await exited;
		await gone(id, 'runner process SIGTERM');
	} finally {
		runner.kill('SIGKILL');
	}
} finally {
	await handler.close();
	server.close();
	keeper.stdin.end();
	await delay(3000);
	assert.equal(alive(pids(keeperId)), 0, 'keeper cleanup');
	for (const id of [...ids, keeperId]) root(`rm -f /var/lib/agent/home/work/lifecycle-${id}.pids`);
	rmSync(dir, { recursive: true });
}
