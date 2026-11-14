/**
 * The First Mate runner: a host-side service that keeps each First Mate chat
 * as interactive Claude Code in an hc terminal in the First Mate guest
 * (ADR-0021) and serves mate runner contract v1 (docs/first-mate.md) to
 * Beadsmith.
 *
 *   node --import ./scripts/ts-resolve.mjs scripts/mate-runner.ts
 *
 * Environment:
 *   MATE_RUNNER_LISTEN        host:port to listen on (default 127.0.0.1:8787)
 *   MATE_RUNNER_SECRET_FILE   file holding the shared signing secret (required,
 *                             at least 32 characters; Beadsmith's
 *                             BDX_MATE_RUNNER_SECRET)
 *   MATE_RUNNER_STATE_DIR     where chat logs live (default ./mate-runner-state)
 *   MATE_RUNNER_MAX_SESSIONS  live agent CLIs at once (default 3)
 * Where the agent runs (absolute paths on the agent's machine):
 *   MATE_AGENT_CLAUDE         Claude Code executable the terminal runs (default: claude)
 * The runner reaches each chat's hc core over SSH (production), where the
 * guest's `mate-chat` helper runs every chat as a Unix identity of its own
 * (ADR-0023) and MATE_AGENT_HC is not used:
 *   MATE_AGENT_SSH            user@host of the guest (the key may run only the helper)
 *   MATE_AGENT_SSH_KEY        private key file
 *   MATE_AGENT_KNOWN_HOSTS    known_hosts file pinning the guest
 *   MATE_AGENT_CHAT_HOMES     the guest directory holding each chat's home
 * or, with MATE_AGENT_LOCAL=1, with `hc connect` on this machine
 * (development: one core and one user for every chat):
 *   MATE_AGENT_WORKDIR        the working directory (default: cwd)
 *   MATE_AGENT_CLAUDE_CONFIG  Claude Code's config directory, where its
 *                             transcripts live (default ~/.claude)
 *   MATE_AGENT_HC             hc executable (default: hc)
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ChatStore } from '../src/lib/mate-runner/event-log.js';
import { createRunnerHandler } from '../src/lib/mate-runner/server.js';
import {
	localConnector,
	sshConnector,
	sshDiscarder,
	type AgentPlace,
	type SshAgentConfig
} from '../src/lib/mate-runner/spawn.js';
import type { ConnectAgent } from '../src/lib/mate-runner/session.js';

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (value === undefined || value.length === 0) {
		console.error(`mate-runner: ${name} is required`);
		process.exit(2);
	}
	return value;
}

const secret = readFileSync(required('MATE_RUNNER_SECRET_FILE'), 'utf8').trim();
if (secret.length < 32) {
	console.error('mate-runner: the secret must be at least 32 characters');
	process.exit(2);
}

function absolute(name: string, fallback?: string): string {
	const value = process.env[name]?.trim() || fallback;
	if (value === undefined) return required(name);
	if (!isAbsolute(value)) {
		console.error(`mate-runner: ${name} must be an absolute path`);
		process.exit(2);
	}
	return value;
}

const local = process.env.MATE_AGENT_LOCAL === '1';
const claude = process.env.MATE_AGENT_CLAUDE?.trim() || 'claude';
const ssh: SshAgentConfig | undefined = local
	? undefined
	: {
			claude,
			chat_homes: absolute('MATE_AGENT_CHAT_HOMES'),
			target: required('MATE_AGENT_SSH'),
			identity_file: required('MATE_AGENT_SSH_KEY'),
			known_hosts_file: required('MATE_AGENT_KNOWN_HOSTS')
		};
function localPlace(): AgentPlace {
	return {
		workdir: absolute('MATE_AGENT_WORKDIR', process.cwd()),
		config_dir: absolute('MATE_AGENT_CLAUDE_CONFIG', join(homedir(), '.claude')),
		claude,
		hc: process.env.MATE_AGENT_HC?.trim() || 'hc'
	};
}
const connect: ConnectAgent = ssh === undefined ? localConnector(localPlace()) : sshConnector(ssh);

const [host, port] = (process.env.MATE_RUNNER_LISTEN ?? '127.0.0.1:8787').split(/:(?=\d+$)/);
const handler = createRunnerHandler({
	secret,
	store: new ChatStore(process.env.MATE_RUNNER_STATE_DIR ?? './mate-runner-state'),
	connect,
	...(ssh === undefined ? {} : { discard: sshDiscarder(ssh) }),
	max_live_sessions: Number(process.env.MATE_RUNNER_MAX_SESSIONS ?? 3),
	agent: { log: (message) => console.warn(`mate-runner: ${message}`) }
});

const server = createServer((req, res) => {
	void handler(req, res);
});
server.listen(Number(port), host, () => {
	console.log(`mate-runner listening on ${host}:${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, async () => {
		server.close();
		await handler.close();
		server.closeAllConnections();
		process.exit(0);
	});
}
