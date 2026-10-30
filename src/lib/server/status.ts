import { getEnv, type ServerEnv } from './env.js';
import { getDoltClient, toDoltConnectionError, type DoltClient } from './dolt/client.js';
import { discoverProjects } from './discovery.js';
import { dispatchEnabled } from './dispatch/policy.js';
import { PROVIDER_CAPABILITIES } from './dispatch/provider.js';
import { getDispatchPolicyStore, stateDbHealthy, getStateStore } from './state/db.js';
import type { DoltFailureKind, Project, StatusSnapshot } from '$lib/types.js';
import { roleCan, type AccountRole } from './auth/roles.js';

export const DOLT_PROBE_TTL_MS = 15_000;
export const AGENT_WINDOW_MS = 15 * 60 * 1000;
const MAX_AGENT_PROBE_PROJECTS = 8;

/**
 * Case-insensitive substring match of an event actor against configured agents.
 * @param actor Event actor.
 * @param agent_actors Configured agent names.
 */
export function isAgentActor(actor: string, agent_actors: string[]): boolean {
	const lower = actor.toLowerCase();
	return agent_actors.some((name) => {
		return name.length > 0 && lower.includes(name.toLowerCase());
	});
}

interface DoltProbe {
	reachable: boolean;
	failure_kind?: DoltFailureKind;
	latency_ms?: number;
	checked_at: number;
}

let dolt_probe: DoltProbe | undefined;

/** Clear cached status probes (tests only). */
export function resetStatusCache(): void {
	dolt_probe = undefined;
}

export interface StatusDeps {
	env?: ServerEnv;
	dolt?: DoltClient;
	projects?: () => Promise<Project[]>;
	now?: () => number;
	state_ok?: boolean;
	/** Injected global arm; when omitted, load from service-local SQLite. */
	armed?: boolean;
}

/** Probe the remote Dolt server, caching both outcomes briefly. */
async function probeDolt(client: DoltClient, now: () => number): Promise<DoltProbe> {
	const current = now();
	if (dolt_probe !== undefined && current - dolt_probe.checked_at < DOLT_PROBE_TTL_MS) {
		return dolt_probe;
	}
	try {
		const latency_ms = await client.ping();
		dolt_probe = { reachable: true, latency_ms, checked_at: current };
	} catch (error) {
		dolt_probe = {
			reachable: false,
			failure_kind: toDoltConnectionError(error).kind,
			checked_at: current
		};
	}
	return dolt_probe;
}

async function resolveArmed(deps: StatusDeps): Promise<boolean> {
	if (deps.armed !== undefined) {
		return deps.armed;
	}
	try {
		return await (await getDispatchPolicyStore()).getArmed();
	} catch {
		return false;
	}
}

export interface AgentActivity {
	active: boolean;
	/** Distinct agent actors seen within the activity window. */
	count: number;
	last_actor?: string;
	last_seen?: string;
}

/**
 * Find the most recent agent event across remote projects.
 * @param client Dolt client.
 * @param projects Discovered remote projects.
 * @param agent_actors Configured agent names.
 * @param now Clock.
 */
export async function findAgentActivity(
	client: DoltClient,
	projects: Project[],
	agent_actors: string[],
	now: () => number = Date.now
): Promise<AgentActivity> {
	const targets = projects
		.filter((project) => {
			return project.state === 'remote' && project.dolt_database !== undefined;
		})
		.slice(0, MAX_AGENT_PROBE_PROJECTS);

	let best: { actor: string; created_at: string; time: number } | undefined;
	const active_actors = new Set<string>();
	await Promise.all(
		targets.map(async (project) => {
			try {
				const events = await client.recentEvents(project.dolt_database as string, 20);
				for (const event of events) {
					if (!isAgentActor(event.actor, agent_actors)) {
						continue;
					}
					const time = Date.parse(event.created_at);
					if (Number.isNaN(time)) {
						continue;
					}
					if (now() - time <= AGENT_WINDOW_MS) {
						active_actors.add(event.actor);
					}
					if (best === undefined || time > best.time) {
						best = { actor: event.actor, created_at: event.created_at, time };
					}
				}
			} catch {
				/* An individual unreadable project contributes no activity. */
			}
		})
	);

	if (best === undefined) {
		return { active: false, count: 0 };
	}
	return {
		active: now() - best.time <= AGENT_WINDOW_MS,
		count: active_actors.size,
		last_actor: best.actor,
		last_seen: best.created_at
	};
}

/**
 * Mask a status snapshot for one viewer. A viewer without dispatch:launch (a
 * member, a service token) sees dispatch as off and `viewer_can_launch:
 * false`, so File/Tackle and every agent control hide instead of offering
 * actions the API refuses. Used by `/api/status` and the layout load alike.
 * @param status Snapshot from `getStatus`.
 * @param role The viewer's role from `locals.role`.
 */
export function statusForViewer(
	status: StatusSnapshot,
	role: AccountRole | undefined
): StatusSnapshot {
	const can_launch = roleCan(role, { dispatch: ['launch'] });
	return {
		...status,
		dispatch: {
			...status.dispatch,
			enabled: can_launch && status.dispatch.enabled,
			viewer_can_launch: can_launch
		}
	};
}

/**
 * Build the health snapshot for the remote control plane.
 *
 * The browser receives only safe availability state; connection metadata and
 * the protected credential value stay in the service runtime.
 * @param deps Injectable environment and clients.
 */
export async function getStatus(deps: StatusDeps = {}): Promise<StatusSnapshot> {
	const env = deps.env ?? getEnv();
	const now = deps.now ?? Date.now;
	const dolt_client = deps.dolt ?? getDoltClient();
	let reachable = false;
	let latency_ms: number | undefined;
	let failure_kind: DoltFailureKind | undefined;
	if (env.dolt_configured) {
		const probe = await probeDolt(dolt_client, now);
		reachable = probe.reachable;
		latency_ms = probe.latency_ms;
		failure_kind = probe.failure_kind;
	}

	let state_ok = deps.state_ok;
	if (state_ok === undefined) {
		try {
			await getStateStore();
			state_ok = stateDbHealthy();
		} catch {
			state_ok = false;
		}
	}

	let agents: AgentActivity = { active: false, count: 0 };
	if (env.dolt_configured && reachable) {
		try {
			const projects =
				deps.projects === undefined ? await discoverProjects() : await deps.projects();
			agents = await findAgentActivity(dolt_client, projects, env.agent_actors, now);
		} catch {
			agents = { active: false, count: 0 };
		}
	}

	// "Key configured" now means a usable provider is configured.
	const key_configured = env.dispatch_provider !== 'none';
	const armed = await resolveArmed(deps);

	return {
		mode: 'remote',
		dolt: {
			configured: env.dolt_configured,
			reachable,
			failure_kind,
			latency_ms
		},
		state_db: { ok: state_ok === true },
		agents,
		dispatch: {
			enabled: dispatchEnabled(key_configured, armed),
			key_configured,
			armed,
			provider: env.dispatch_provider,
			...(env.dispatch_provider === 'none'
				? {}
				: { capabilities: PROVIDER_CAPABILITIES[env.dispatch_provider] }),
			...(env.dispatch_provider_error === undefined
				? {}
				: { provider_error: env.dispatch_provider_error })
		}
	};
}
