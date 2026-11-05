/**
 * The First Mate runner: a host-side service that keeps each First Mate chat
 * as a long-lived Claude Code session in the First Mate sandbox and serves
 * mate runner contract v1 (docs/first-mate.md) to Beadsmith.
 *
 *   node --import ./scripts/ts-resolve.mjs scripts/mate-runner.ts
 *
 * Environment:
 *   MATE_RUNNER_LISTEN        host:port to listen on (default 127.0.0.1:8787)
 *   MATE_RUNNER_SECRET_FILE   file holding the shared signing secret (required,
 *                             at least 32 characters; Beadsmith's
 *                             BDX_MATE_RUNNER_SECRET)
 *   MATE_RUNNER_STATE_DIR     where chat logs live (default ./mate-runner-state)
 *   MATE_RUNNER_MAX_SESSIONS  live agent processes at once (default 3)
 * Agent, over SSH (production):
 *   MATE_AGENT_SSH            user@host of the sandbox
 *   MATE_AGENT_SSH_KEY        private key file
 *   MATE_AGENT_KNOWN_HOSTS    known_hosts file pinning the sandbox
 *   MATE_AGENT_WORKDIR        directory in the sandbox (default: the login directory)
 *   MATE_AGENT_CLAUDE         Claude Code executable (default: claude)
 * Or locally (development):
 *   MATE_AGENT_COMMAND        command to run instead of SSH, e.g. claude
 *   MATE_AGENT_LOCAL_WORKDIR  its working directory (default: cwd)
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { ChatStore } from '../src/lib/mate-runner/event-log.js';
import { createRunnerHandler } from '../src/lib/mate-runner/server.js';
import { localSpawner, sshSpawner } from '../src/lib/mate-runner/spawn.js';
import type { SpawnAgent } from '../src/lib/mate-runner/session.js';

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

let spawnAgent: SpawnAgent;
const local = process.env.MATE_AGENT_COMMAND?.trim();
if (local !== undefined && local.length > 0) {
	spawnAgent = localSpawner(local, process.env.MATE_AGENT_LOCAL_WORKDIR ?? process.cwd());
} else {
	spawnAgent = sshSpawner({
		target: required('MATE_AGENT_SSH'),
		identity_file: required('MATE_AGENT_SSH_KEY'),
		known_hosts_file: required('MATE_AGENT_KNOWN_HOSTS'),
		workdir: process.env.MATE_AGENT_WORKDIR ?? '.',
		claude: process.env.MATE_AGENT_CLAUDE ?? 'claude'
	});
}

const [host, port] = (process.env.MATE_RUNNER_LISTEN ?? '127.0.0.1:8787').split(/:(?=\d+$)/);
const handler = createRunnerHandler({
	secret,
	store: new ChatStore(process.env.MATE_RUNNER_STATE_DIR ?? './mate-runner-state'),
	spawn: spawnAgent,
	max_live_sessions: Number(process.env.MATE_RUNNER_MAX_SESSIONS ?? 3)
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
