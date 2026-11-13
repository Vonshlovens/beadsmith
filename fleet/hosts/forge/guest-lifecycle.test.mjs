// Run on the host, as root, against its deployed guest, as described in
// docs/operations/host-forge.md. No model call occurs.
//
// The runner's own lifecycle (delete, idle eviction, shutdown and SIGTERM all
// end a chat's CLI with hc's terminal kill; a lost channel leaves it running
// for the next message; delete discards the chat) is unit-tested against a
// fake hc in src/lib/mate-runner/. This checks what only the real guest can
// show (ADR-0021, ADR-0023):
//
// 1. the runner's `ssh <guest> connect <session>` reaches that chat's own hc
//    core, so its terminals live in the chat's `mate-chat@` unit, as the
//    chat's own user, and not in the SSH session;
// 2. a terminal's program has the system PATH;
// 3. killing a terminal ends its program and every descendant in its session,
//    even ones that ignore SIGTERM and SIGHUP, and leaves other terminals;
// 4. a terminal outlives the abrupt loss of the channel that started it and
//    is found again by its label over a new one;
// 5. Claude Code starts in a terminal and reaches its prompt without a
//    first-run dialog (the guest pre-accepts them), and ends when killed;
// 6. one chat cannot read or write another chat's home, reach its core's
//    socket, see its processes or signal them;
// 7. a chat's home survives a restart of its unit (under whatever UID it
//    gets next), and discarding one chat stops it and removes its home while
//    another chat runs on.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { claudeCode } from '../../../src/lib/agent-session/claude-code.ts';
import { AgentSession } from '../../../src/lib/agent-session/session.ts';
import { connectHc } from '../../../src/lib/hc/client.ts';
import { childProcessTransport } from '../../../src/lib/hc/node-transport.ts';
import { sshArgs } from '../../../src/lib/mate-runner/spawn.ts';

// The path every chat sees as its own home.
const HOME = '/var/lib/agent/home';
const WORKDIR = `${HOME}/work`;
const config = {
	target: 'root@10.100.0.2',
	identity_file: '/var/lib/mate-runner/ssh/agent_ed25519',
	known_hosts_file: '/var/lib/microvm-keys/known_hosts',
	workdir: WORKDIR,
	config_dir: `${HOME}/.claude`,
	claude: '/run/current-system/sw/bin/mate-claude'
};
const LABEL = 'beadsmith-lifecycle-test';
const FIXTURE = readFileSync(new URL('./guests/lifecycle-fake.mjs', import.meta.url), 'utf8');

/** Run a command in the guest as root, over the control key. */
const root = (command, input) =>
	execFileSync('/run/current-system/sw/bin/mate-ssh', [command], {
		encoding: 'utf8',
		...(input === undefined ? {} : { input })
	}).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The guest's unit instance and user for a chat (mate-chat in guests/mate.nix). */
const instance = (chat) => createHash('sha256').update(chat).digest('hex').slice(0, 24);
const user = (chat) => `mc-${instance(chat)}`;
/** A chat's home as root sees it in the guest. */
const homeOf = (chat) => `/var/lib/private/mate-chats/${instance(chat)}`;

/** One runner-shaped channel to a chat's core: the ssh process and an hc client over it. */
async function channel(chat) {
	const child = spawn('ssh', sshArgs(config, 'connect', chat), {
		stdio: ['pipe', 'pipe', 'ignore']
	});
	return { child, client: await connectHc(childProcessTransport(child)) };
}

function discard(chat) {
	execFileSync('ssh', sshArgs(config, 'discard', chat), { stdio: 'ignore' });
}

function installFixture(chat) {
	const file = `${homeOf(chat)}/work/lifecycle-fake.mjs`;
	root(`cat > ${file} && chown ${user(chat)}:${user(chat)} ${file}`, FIXTURE);
}

const pids = (chat, id) =>
	root(`cat ${homeOf(chat)}/work/lifecycle-${id}.pids`)
		.split('\n')
		.filter(Boolean)
		.map(Number);
function alive(ids) {
	return root(`for p in ${ids.join(' ')}; do test ! -e /proc/$p/stat || cat /proc/$p/stat; done`)
		.split('\n')
		.filter((line) => line && !/^\d+ \(.*\) Z /.test(line)).length;
}
function inChatUnit(pid, chat) {
	const unit = new RegExp(`/mate-chat@${instance(chat)}\\.service(/|$)`, 'm');
	return unit.test(root(`cat /proc/${pid}/cgroup`));
}
const uidOf = (pid) => root(`stat -c %u /proc/${pid}`);
const chatUid = (chat) => root(`id -u ${user(chat)}`);

async function fixture(client, id) {
	const terminal = await client.run({
		argv: ['/run/current-system/sw/bin/node', `${WORKDIR}/lifecycle-fake.mjs`, '--session-id', id],
		cwd: WORKDIR,
		labels: { [LABEL]: id }
	});
	await delay(1500);
	return terminal;
}

/**
 * What chat `prober` can do to chat `target`, run from a terminal of the
 * prober's own core. Each line is `<check> ok` or `<check> LEAK`.
 */
function probeScript(target, targetPid) {
	const other = `/var/lib/private/mate-chats/${instance(target)}`;
	const check = (name, command) =>
		`if ${command} >/dev/null 2>&1; then echo "${name} LEAK"; else echo "${name} ok"; fi`;
	return [
		'exec > ' + `${WORKDIR}/probe.out` + ' 2>&1',
		check('list-other-home', `ls ${other}`),
		check('read-other-config', `cat ${other}/.claude.json`),
		check('write-other-work', `touch ${other}/work/probe-was-here`),
		check('reach-other-socket', `ls /run/mate-chat/${instance(target)}`),
		check('see-other-process', `test -e /proc/${targetPid}`),
		check('signal-other-process', `kill -0 ${targetPid}`),
		check('see-old-shared-state', `ls ${'/var/lib/agent/ssh'}`),
		// Positive control: its own home is there and writable.
		`if touch ${HOME}/.probe && test -s ${HOME}/.claude.json; then echo "own-home ok"; else echo "own-home LEAK"; fi`,
		'echo done'
	].join('\n');
}

const chatA = randomUUID();
const chatB = randomUUID();
const keeperId = randomUUID();
const victimId = randomUUID();
const claudeId = chatA;
const channels = [];
try {
	const first = await channel(chatA);
	channels.push(first);
	assert.equal(root(`systemctl is-active mate-chat@${instance(chatA)}.service`), 'active');
	installFixture(chatA);
	const keeper = await fixture(first.client, keeperId);
	const victim = await fixture(first.client, victimId);
	assert.equal(
		pids(chatA, keeperId).length,
		3,
		'fixture started its descendants (PATH resolves tools)'
	);
	assert.equal(pids(chatA, victimId).length, 3, 'second fixture started its descendants');
	for (const pid of [...pids(chatA, keeperId), ...pids(chatA, victimId)]) {
		assert.ok(inChatUnit(pid, chatA), `pid ${pid} runs under the chat's mate-chat@ unit`);
		assert.equal(uidOf(pid), chatUid(chatA), `pid ${pid} runs as the chat's own user`);
	}
	console.log("PASS terminals run in the chat's own unit, as its own user, with the system PATH");

	await first.client.kill(victim.address);
	await delay(3000);
	assert.equal(alive(pids(chatA, victimId)), 0, 'killed terminal leaves no descendants');
	assert.equal(alive(pids(chatA, keeperId)), 3, 'other terminal survives a kill');
	console.log('PASS kill ends the program and its session, not other terminals');

	first.child.kill('SIGKILL');
	await delay(3000);
	assert.equal(alive(pids(chatA, keeperId)), 3, 'terminal survives the loss of its channel');
	const second = await channel(chatA);
	channels.push(second);
	const found = await second.client.list({ labels: { [LABEL]: keeperId } });
	assert.equal(found.length, 1, 'terminal found by label over a new channel');
	assert.equal(found[0].address, keeper.address);
	console.log('PASS a terminal outlives an abrupt SSH loss and is found again');

	// Chat B, another chat on the same guest, probes chat A while A's keeper runs.
	const probe = await channel(chatB);
	channels.push(probe);
	assert.notEqual(chatUid(chatB), chatUid(chatA), 'two chats have two users');
	const [targetPid] = pids(chatA, keeperId);
	await probe.client.run({
		argv: ['/run/current-system/sw/bin/bash', '-c', probeScript(chatA, targetPid)],
		cwd: WORKDIR,
		labels: { [LABEL]: 'probe' }
	});
	let report = '';
	for (let i = 0; i < 20 && !report.includes('done'); i++) {
		await delay(500);
		report = root(`cat ${homeOf(chatB)}/work/probe.out 2>/dev/null || true`);
	}
	assert.ok(report.includes('done'), `probe finished: ${report}`);
	assert.doesNotMatch(report, /LEAK/, `chat B reached chat A:\n${report}`);
	assert.equal(root(`test -e ${homeOf(chatA)}/work/probe-was-here && echo yes || echo no`), 'no');
	assert.equal(alive(pids(chatA, keeperId)), 3, "chat A's processes survived chat B's probe");
	console.log("PASS one chat cannot read, write, reach, see or signal another chat's state");

	await second.client.kill(keeper.address);
	await delay(3000);
	assert.equal(alive(pids(chatA, keeperId)), 0, 'keeper cleanup');

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
	assert.ok(inChatUnit(cli.pid, chatA), "Claude Code runs under the chat's unit");
	await session.cancel();
	session.close();
	await delay(3000);
	assert.equal(alive([cli.pid]), 0, 'Claude Code ends when its terminal is killed');
	console.log('PASS Claude Code reaches its prompt with no first-run dialog');

	for (const { child, client } of channels.splice(0)) {
		client.close();
		child.kill('SIGKILL');
	}
	root(`systemctl restart mate-chat@${instance(chatB)}.service`);
	const resumed = await channel(chatB);
	channels.push(resumed);
	assert.equal(
		root(`stat -c %u ${homeOf(chatB)}/work/probe.out`),
		chatUid(chatB),
		"chat B's files belong to its user after a restart"
	);
	assert.match(root(`cat ${homeOf(chatB)}/work/probe.out`), /done/);
	console.log("PASS a chat's home survives a restart of its unit");

	discard(chatA);
	assert.notEqual(
		root(`systemctl is-active mate-chat@${instance(chatA)}.service || true`),
		'active'
	);
	assert.equal(
		root(`test -e ${homeOf(chatA)} && echo yes || echo no`),
		'no',
		"discard removed A's home"
	);
	assert.equal(root(`systemctl is-active mate-chat@${instance(chatB)}.service`), 'active');
	console.log('PASS discard stops one chat and removes its home, and leaves the other');
} finally {
	for (const { child, client } of channels) {
		client.close();
		child.kill('SIGKILL');
	}
	for (const chat of [chatA, chatB]) {
		try {
			discard(chat);
		} catch {
			console.error(`could not discard test chat ${chat}`);
		}
	}
}
