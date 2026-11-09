/**
 * Start a chat's Claude Code process: over SSH in the First Mate sandbox (the
 * production shape), or as a local command (development and tests).
 *
 * The sandbox provides everything else: the working directory with its
 * AGENTS.md and skills, `bd`, and the model endpoint (ANTHROPIC_BASE_URL
 * pointing at a host-side proxy that adds the credential, ADR-0015 rule 6).
 * Nothing secret is passed on this command line.
 */

import { spawn } from 'node:child_process';
import type { AgentLaunch, AgentProcess, SpawnAgent } from './session.js';

export interface SshAgentConfig {
	/** `user@host` of the sandbox. */
	target: string;
	/** Private key the runner uses to reach the sandbox. */
	identity_file: string;
	/** known_hosts file pinning the sandbox's host key. */
	known_hosts_file: string;
	/** Directory in the sandbox the agent runs in. */
	workdir: string;
	/** The Claude Code executable in the sandbox. */
	claude: string;
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

/** Claude Code arguments for one long-lived chat process. */
export function claudeArgs(launch: AgentLaunch): string[] {
	const args = [
		'-p',
		'--input-format',
		'stream-json',
		'--output-format',
		'stream-json',
		'--verbose',
		// The sandbox is the boundary (ADR-0015): no per-tool prompts, which
		// nobody could answer from a headless process anyway.
		'--permission-mode',
		'bypassPermissions',
		launch.resume ? '--resume' : '--session-id',
		launch.session_id
	];
	if (launch.scope !== null) {
		args.push('--append-system-prompt', scopePrompt(launch.scope));
	}
	if (launch.mcp_config !== undefined) {
		args.push('--mcp-config', launch.mcp_config);
	}
	return args;
}

/** Quote one word for a POSIX shell. */
export function shellQuote(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

export function sshArgs(config: SshAgentConfig, launch: AgentLaunch): string[] {
	const remote = `cd ${shellQuote(config.workdir)} && exec ${[config.claude, ...claudeArgs(launch)]
		.map(shellQuote)
		.join(' ')}`;
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
		remote
	];
}

export function sshSpawner(config: SshAgentConfig): SpawnAgent {
	return (launch) =>
		spawn('ssh', sshArgs(config, launch), { stdio: ['pipe', 'pipe', 'pipe'] }) as AgentProcess;
}

/** Run Claude Code (or a stand-in speaking its stream-json) on this machine. */
export function localSpawner(command: string, cwd: string): SpawnAgent {
	return (launch) =>
		spawn(command, claudeArgs(launch), { cwd, stdio: ['pipe', 'pipe', 'pipe'] }) as AgentProcess;
}
