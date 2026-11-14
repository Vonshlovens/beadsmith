/**
 * Reach a chat's hc core (ADR-0021 rule 1): over SSH in the First Mate guest
 * (the production shape), or as a local `hc connect` (development).
 *
 * In the guest every chat has a core of its own, under a Unix identity of its
 * own (ADR-0023): the runner's key may only run the guest's `mate-chat`
 * helper, which starts that chat's core and connects to it as the chat's
 * user, or discards the chat. Each chat's home is
 * `<chat_homes>/<chatInstance(session id)>`, its working directory `work`
 * and its Claude Code config `.claude` under it.
 *
 * Either way the runner gets an hc client and nothing else: the session core
 * (`src/lib/agent-session/`) launches Claude Code in a terminal of that core.
 * The guest provides everything the agent needs: the working directory with
 * its AGENTS.md and skills, `bd`, and the model endpoint (ANTHROPIC_BASE_URL
 * pointing at a host-side proxy that adds the credential, ADR-0015 rule 6).
 * Nothing secret is passed on these command lines.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connectHc } from '../hc/client.js';
import { childProcessTransport } from '../hc/node-transport.js';
import type { AgentConnection, ConnectAgent } from './session.js';

/** Where the agent runs on the far side of the channel. */
export interface AgentPlace {
	/** Absolute working directory of the agent. */
	workdir: string;
	/** Absolute Claude Code config directory (`~/.claude`); its transcripts live under it. */
	config_dir: string;
	/** The Claude Code executable the terminal runs. */
	claude: string;
	/** The hc executable. */
	hc: string;
}

export interface SshAgentConfig extends Pick<AgentPlace, 'claude'> {
	/** Absolute directory in the guest that holds every chat's home. */
	chat_homes: string;
	/** `user@host` of the guest; the key may run only the guest's `mate-chat` helper. */
	target: string;
	/** Private key the runner uses to reach the guest. */
	identity_file: string;
	/** known_hosts file pinning the guest's host key. */
	known_hosts_file: string;
}

/**
 * What the agent is told about the chat's scope. Beadsmith's project ids are
 * `d_` plus the Dolt database name (docs/first-mate.md); the agent works with
 * the database name, which is what `bd` and SQL use.
 */
export function scopePrompt(scope: string): string {
	const database = scope.startsWith('d_') ? scope.slice(2) : scope;
	return `This chat is about the Beads project whose Dolt database is "${database}". This is the initial scope; follow scope changes supplied with later user messages. Start there unless the user asks about other projects.`;
}

/** Quote one word for a POSIX shell. */
export function shellQuote(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Lowercase UUIDs, as Beadsmith makes session ids; the guest helper checks the same. */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The guest's name for a chat: its `mate-chat@` unit instance, the `mc-`
 * user and its home's directory. The first 24 hex digits of the SHA-256 of
 * the CLI session id; the guest's `mate-chat` helper computes the same.
 */
export function chatInstance(session_id: string): string {
	return createHash('sha256').update(session_id).digest('hex').slice(0, 24);
}

/** Where one chat's agent runs in the guest. */
export function chatPlace(config: SshAgentConfig, session_id: string): AgentConnection['launch'] {
	const home = `${config.chat_homes}/${chatInstance(session_id)}`;
	return { cwd: `${home}/work`, config_dir: `${home}/.claude`, command: config.claude };
}

/** What the guest's `mate-chat` helper does for one chat. */
export type ChatCommand = 'connect' | 'discard';

/**
 * `ssh` arguments that ask the guest's `mate-chat` helper to `connect` to the
 * chat's hc core (starting it first) or `discard` the chat, with the host key
 * pinned. The guest forces the helper whatever is asked; this is its argument.
 */
export function sshArgs(
	config: SshAgentConfig,
	command: ChatCommand,
	session_id: string
): string[] {
	if (!SESSION_ID_PATTERN.test(session_id)) throw new Error('session_id must be a lowercase UUID');
	return [
		'-T',
		'-o',
		'BatchMode=yes',
		'-o',
		'IdentitiesOnly=yes',
		'-o',
		'StrictHostKeyChecking=yes',
		'-o',
		`UserKnownHostsFile=${config.known_hosts_file}`,
		'-o',
		'ServerAliveInterval=30',
		'-o',
		'ServerAliveCountMax=4',
		'-i',
		config.identity_file,
		config.target,
		'--',
		`${command} ${session_id}`
	];
}

function launchOf(place: AgentPlace): AgentConnection['launch'] {
	return { cwd: place.workdir, config_dir: place.config_dir, command: place.claude };
}

/** Connect to the chat's hc core in the guest over SSH; the channel ends with the client. */
export function sshConnector(config: SshAgentConfig): ConnectAgent {
	return async (session_id) => {
		const child = spawn('ssh', sshArgs(config, 'connect', session_id), {
			stdio: ['pipe', 'pipe', 'ignore']
		});
		return {
			client: await connectHc(childProcessTransport(child)),
			launch: chatPlace(config, session_id)
		};
	};
}

/**
 * Discard a deleted chat in the guest: stop its core (ending everything it
 * started) and remove its home, transcripts included.
 */
export function sshDiscarder(config: SshAgentConfig): (session_id: string) => Promise<void> {
	return (session_id) =>
		new Promise((resolve, reject) => {
			const child = spawn('ssh', sshArgs(config, 'discard', session_id), {
				stdio: ['ignore', 'ignore', 'pipe']
			});
			let stderr = '';
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (chunk: string) => {
				if (stderr.length < 2000) stderr += chunk;
			});
			child.once('error', reject);
			child.once('close', (code) => {
				if (code === 0) resolve();
				else reject(new Error(`discard exited ${code}: ${stderr.trim().slice(0, 500)}`));
			});
		});
}

/** Connect to an hc core on this machine (development). */
export function localConnector(place: AgentPlace): ConnectAgent {
	return async () => {
		const child = spawn(place.hc, ['connect'], { stdio: ['pipe', 'pipe', 'ignore'] });
		return { client: await connectHc(childProcessTransport(child)), launch: launchOf(place) };
	};
}
