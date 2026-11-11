/**
 * Reach a chat's hc core (ADR-0021 rule 1): over SSH in the First Mate guest
 * (the production shape), or as a local `hc connect` (development).
 *
 * Either way the runner gets an hc client and nothing else: the session core
 * (`src/lib/agent-session/`) launches Claude Code in a terminal of that core.
 * The guest provides everything the agent needs: the working directory with
 * its AGENTS.md and skills, `bd`, and the model endpoint (ANTHROPIC_BASE_URL
 * pointing at a host-side proxy that adds the credential, ADR-0015 rule 6).
 * Nothing secret is passed on these command lines.
 */

import { spawn } from 'node:child_process';
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

export interface SshAgentConfig extends AgentPlace {
	/** `user@host` of the guest. */
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

/** `ssh` arguments that run `hc connect` in the guest, with the host key pinned. */
export function sshArgs(config: SshAgentConfig): string[] {
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
		`exec ${shellQuote(config.hc)} connect`
	];
}

function launchOf(place: AgentPlace): AgentConnection['launch'] {
	return { cwd: place.workdir, config_dir: place.config_dir, command: place.claude };
}

/** Connect to the guest's hc core over SSH; the channel ends with the client. */
export function sshConnector(config: SshAgentConfig): ConnectAgent {
	return async () => {
		const child = spawn('ssh', sshArgs(config), { stdio: ['pipe', 'pipe', 'ignore'] });
		return { client: await connectHc(childProcessTransport(child)), launch: launchOf(config) };
	};
}

/** Connect to an hc core on this machine (development). */
export function localConnector(place: AgentPlace): ConnectAgent {
	return async () => {
		const child = spawn(place.hc, ['connect'], { stdio: ['pipe', 'pipe', 'ignore'] });
		return { client: await connectHc(childProcessTransport(child)), launch: launchOf(place) };
	};
}
