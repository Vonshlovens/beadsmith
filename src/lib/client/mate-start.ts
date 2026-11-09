/**
 * The First Mate start screen's next actions and its "where it runs" note
 * (design standards, section 6: introduce the next useful action when it is
 * available, respect the reader's role and the app's state, never present an
 * unavailable action).
 *
 * Each suggestion comes from live data, such as "4 ready issues in api", and
 * fills the composer with a prompt; it never sends. What may be suggested
 * depends on where a new chat runs: on Sand the chat has crew tools
 * (ADR-0020) and can read todos and missions, route todos and start repo
 * workers; on the operator's own runner (the forge guest) it has no crew
 * tools, so only questions about Beads are offered there. Without a runner,
 * replies are placeholders and nothing is suggested from data.
 */
import type { MateRunnerId, MateRunnerInfo } from '#lib/mate.js';
import type { DispatchStatus } from '#lib/types.js';

/** The ready issue fields the builder reads. */
export interface StartReadyIssue {
	project_id: string;
	project_name: string;
}

/** The todo fields the builder reads. */
export interface StartTodo {
	status: 'open' | 'done' | 'archived';
	routed_project_id: string | null;
}

/** The mission fields the builder reads. */
export interface StartMission {
	project_id: string;
	issue_id?: string;
	status: DispatchStatus;
	updated_at: string;
}

export interface StartContext {
	/** Members cannot chat with First Mate yet. */
	admin: boolean;
	/** Where a new chat runs; null when no runner is configured. */
	runner: MateRunnerId | null;
	/** Missions can be launched (dispatch configured, armed, viewer allowed). */
	can_launch: boolean;
	/** The chat's chosen project, or null for every project. */
	scope: string | null;
	/** Live data; null while loading or when it could not be read. */
	ready: readonly StartReadyIssue[] | null;
	todos: readonly StartTodo[] | null;
	missions: readonly StartMission[] | null;
}

export interface StartSuggestion {
	/** Stable key for the list. */
	id: 'ready' | 'todos' | 'missions';
	/** What the data says, such as "4 ready issues in api". */
	label: string;
	/** What it puts in the composer. */
	prompt: string;
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/**
 * The project to point ready work at: the chat's scope when it has ready
 * issues, else the one with the most (ties keep the first listed, which the
 * Ready deck sorts by priority).
 */
function readyFocus(
	ready: readonly StartReadyIssue[],
	scope: string | null
): { name: string; count: number } | null {
	const counts = new Map<string, { name: string; count: number }>();
	for (const issue of ready) {
		const entry = counts.get(issue.project_id);
		if (entry) entry.count += 1;
		else counts.set(issue.project_id, { name: issue.project_name, count: 1 });
	}
	if (scope !== null && counts.has(scope)) return counts.get(scope)!;
	let best: { name: string; count: number } | null = null;
	for (const entry of counts.values()) {
		if (best === null || entry.count > best.count) best = entry;
	}
	return best;
}

/**
 * Issues whose latest mission failed: work that stopped and needs a person.
 * A later mission on the same issue, of any outcome, means someone already
 * picked it up. Missions without an issue (a File mission) count alone.
 */
export function missionsNeedingYou(missions: readonly StartMission[]): number {
	const latest = new Map<string, StartMission>();
	missions.forEach((mission, index) => {
		const key =
			mission.issue_id === undefined
				? `#${index}`
				: `${mission.project_id}\u0000${mission.issue_id}`;
		const seen = latest.get(key);
		if (seen === undefined || Date.parse(mission.updated_at) > Date.parse(seen.updated_at)) {
			latest.set(key, mission);
		}
	});
	return [...latest.values()].filter((mission) => mission.status === 'failed').length;
}

/**
 * Next actions for the start screen, most useful first. Empty for members,
 * without a runner, and while nothing has loaded.
 *
 * @param ctx - Role, runner and live data.
 */
export function startSuggestions(ctx: StartContext): StartSuggestion[] {
	if (!ctx.admin || ctx.runner === null) return [];
	const out: StartSuggestion[] = [];
	const crew = ctx.runner === 'e2b';

	const focus = ctx.ready === null ? null : readyFocus(ctx.ready, ctx.scope);
	if (focus !== null) {
		out.push({
			id: 'ready',
			label: `${plural(focus.count, 'ready issue', 'ready issues')} in ${focus.name}`,
			prompt: `What's ready in ${focus.name}, and which issue should go first?`
		});
	}

	// Todos and missions are Beadsmith's own rows: only crew tools can read them.
	if (crew && ctx.missions !== null) {
		const stuck = missionsNeedingYou(ctx.missions);
		if (stuck > 0) {
			out.push({
				id: 'missions',
				label: `${plural(stuck, 'mission needs', 'missions need')} you`,
				prompt:
					stuck === 1
						? 'One mission failed. What went wrong, and what should we do next?'
						: `${stuck} missions failed. What went wrong, and what should we do next?`
			});
		}
	}

	if (crew && ctx.todos !== null) {
		const unrouted = ctx.todos.filter(
			(todo) => todo.status === 'open' && todo.routed_project_id === null
		).length;
		if (unrouted > 0) {
			out.push({
				id: 'todos',
				label: `${plural(unrouted, 'todo', 'todos')} not routed`,
				// Routing files an issue through a mission; without dispatch, ask
				// for a plan instead of an action that would be refused.
				prompt: ctx.can_launch
					? `Go through my ${plural(unrouted, 'unrouted todo', 'unrouted todos')} and suggest a project for each. Ask before routing any.`
					: `Go through my ${plural(unrouted, 'unrouted todo', 'unrouted todos')} and suggest a project for each.`
			});
		}
	}
	return out;
}

export interface RunsOnNote {
	/** The runner's name, such as "Sand". */
	label: string;
	/** Whether the chat gets crew tools there. */
	crew: boolean;
	/** Sand is offered but not picked: say how to get crew tools. */
	sand_offered: boolean;
}

/**
 * Where a new chat runs, for the start screen's note. Null for members and
 * without a runner (the note says that instead).
 *
 * @param runner - Where a new chat runs.
 * @param runners - Configured chat runners, default first.
 */
export function runsOnNote(
	runner: MateRunnerId | null,
	runners: readonly MateRunnerInfo[]
): RunsOnNote | null {
	if (runner === null) return null;
	const info = runners.find((entry) => entry.id === runner);
	const crew = runner === 'e2b';
	return {
		label: info?.label ?? (crew ? 'Sand' : 'your runner'),
		crew,
		sand_offered: !crew && runners.some((entry) => entry.id === 'e2b')
	};
}
