// Run on the host, as root, against its deployed guest after installing the
// fixture as described in docs/operations/host-forge.md. No model call occurs.
//
// The runner's own lifecycle (delete, idle eviction, shutdown and SIGTERM all
// end a chat's CLI with hc's terminal kill; a lost channel leaves it running
// for the next message) is unit-tested against a fake hc in
// src/lib/mate-runner/. This checks what only the real guest can show:
//
// 1. the runner's `ssh <guest> hc connect` reaches the hc core the guest runs
//    as a user service, so terminals live in that service's cgroup and not in
//    the SSH session;
// 2. a terminal's program has the system PATH;
// 3. killing a terminal ends its program and every descendant in its session,
//    even ones that ignore SIGTERM and SIGHUP, and leaves other terminals;
// 4. a terminal outlives the abrupt loss of the channel that started it and
//    is found again by its label over a new one;
// 5. Claude Code starts in a terminal and reaches its prompt without a
//    first-run dialog (the guest pre-accepts them), and ends when killed.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { claudeCode } from '../../../src/lib/agent-session/claude-code.ts';
import { AgentSession } from '../../../src/lib/agent-session/session.ts';
import { connectHc } from '../../../src/lib/hc/client.ts';
import { childProcessTransport } from '../../../src/lib/hc/node-transport.ts';
import { sshArgs } from '../../../src/lib/mate-runner/spawn.ts';

const WORKDIR = '/var/lib/agent/home/work';
const config = {
	target: 'agent@10.100.0.2',
	identity_file: '/var/lib/mate-runner/ssh/agent_ed25519',
	known_hosts_file: '/var/lib/microvm-keys/known_hosts',
	workdir: WORKDIR,
	config_dir: '/var/lib/agent/home/.claude',
	claude: '/run/current-system/sw/bin/mate-claude',
	hc: '/run/current-system/sw/bin/hc'
};
const LABEL = 'beadsmith-lifecycle-test';
const root = (command) =>
	execFileSync('/run/current-system/sw/bin/mate-ssh', [command], { encoding: 'utf8' }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One runner-shaped channel: the ssh process and an hc client over it. */
async function channel() {
	const child = spawn('ssh', sshArgs(config), { stdio: ['pipe', 'pipe', 'ignore'] });
	return { child, client: await connectHc(childProcessTransport(child)) };
}

const pids = (id) =>
	root(`cat ${WORKDIR}/lifecycle-${id}.pids`).split('\n').filter(Boolean).map(Number);
function alive(ids) {
	return root(`for p in ${ids.join(' ')}; do test ! -e /proc/$p/stat || cat /proc/$p/stat; done`)
		.split('\n')
		.filter((line) => line && !/^\d+ \(.*\) Z /.test(line)).length;
}
function inCoreService(pid) {
	return /\/hc-core\.service(\/|$)/m.test(root(`cat /proc/${pid}/cgroup`));
}

async function fixture(client, id) {
	const terminal = await client.run({
		argv: ['/run/current-system/sw/bin/node', `${WORKDIR}/lifecycle-fake.mjs`, '--session-id', id],
		cwd: WORKDIR,
		labels: { [LABEL]: id }
	});
	await delay(1500);
	assert.equal(pids(id).length, 3, `fixture ${id} started its descendants (PATH resolves tools)`);
	return terminal;
}

const keeperId = randomUUID();
const victimId = randomUUID();
const claudeId = randomUUID();
let first;
let second;
try {
	first = await channel();
	const keeper = await fixture(first.client, keeperId);
	const victim = await fixture(first.client, victimId);
	for (const pid of [...pids(keeperId), ...pids(victimId)]) {
		assert.ok(inCoreService(pid), `pid ${pid} runs under hc-core.service`);
	}
	console.log('PASS terminals run under the guest core service with the system PATH');

	await first.client.kill(victim.address);
	await delay(3000);
	assert.equal(alive(pids(victimId)), 0, 'killed terminal leaves no descendants');
	assert.equal(alive(pids(keeperId)), 3, 'other terminal survives a kill');
	console.log('PASS kill ends the program and its session, not other terminals');

	first.child.kill('SIGKILL');
	await delay(3000);
	assert.equal(alive(pids(keeperId)), 3, 'terminal survives the loss of its channel');
	second = await channel();
	const found = await second.client.list({ labels: { [LABEL]: keeperId } });
	assert.equal(found.length, 1, 'terminal found by label over a new channel');
	assert.equal(found[0].address, keeper.address);
	console.log('PASS a terminal outlives an abrupt SSH loss and is found again');

	await second.client.kill(keeper.address);
	await delay(3000);
	assert.equal(alive(pids(keeperId)), 0, 'keeper cleanup');

	const session = new AgentSession({
		harness: claudeCode,
		launch: {
			session_id: claudeId,
			cwd: config.workdir,
			config_dir: config.config_dir,
			command: config.claude
		},
		labels: { [LABEL]: claudeId },
		onEvent: () => {}
	});
	await session.attach(second.client);
	const [cli] = await second.client.list({ labels: { [LABEL]: claudeId } });
	assert.ok(cli?.pid, 'Claude Code terminal is live');
	assert.ok(inCoreService(cli.pid), 'Claude Code runs under hc-core.service');
	await session.cancel();
	session.close();
	await delay(3000);
	assert.equal(alive([cli.pid]), 0, 'Claude Code ends when its terminal is killed');
	console.log('PASS Claude Code reaches its prompt with no first-run dialog');
} finally {
	const client = second?.client;
	if (client !== undefined) {
		for (const terminal of await client.list({ all: true }).catch(() => [])) {
			if (terminal.labels[LABEL] === undefined) continue;
			if (terminal.state === 'live') await client.kill(terminal.address).catch(() => {});
			await client.remove(terminal.address).catch(() => {});
		}
		client.close();
	}
	first?.child.kill('SIGKILL');
	second?.child.kill('SIGKILL');
	root(`rm -f ${WORKDIR}/lifecycle-${keeperId}.pids ${WORKDIR}/lifecycle-${victimId}.pids`);
}
