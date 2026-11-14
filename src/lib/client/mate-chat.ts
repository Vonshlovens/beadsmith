/**
 * First Mate chats in the browser: the pure part behind `/first-mate`.
 *
 * Chats live on the server (`/api/mate/chats`, docs/first-mate.md); the
 * store in mate-chat.svelte.ts loads them and follows the open chat's event
 * stream. A chat is a log of MissionEvents from one long-lived agent session,
 * and the agent may speak unasked ("PR ready, captain"), so the view groups
 * events into bubbles rather than pairing questions with answers.
 */
import { FIRST_MATE_PATH } from '#lib/client/first-mate.js';
import { isCrewNotice, type MateEvent } from '#lib/mate.js';
import type { MissionResultStatus, MissionToolCallStatus } from '#lib/mission-events.js';

export { MAX_MESSAGE_CHARS, UNWIRED_REPLY, chatTitle } from '#lib/mate.js';

/** Starting points offered on a new chat. */
export const STARTERS: readonly string[] = [
	"What's ready to work on across every project?",
	'Which issues are stalled, and what is blocking them?',
	'Summarise what changed this week.',
	'Draft an issue for a bug I describe.'
];

/**
 * Link to one chat on the First Mate page.
 *
 * @param id - Chat id.
 */
export function chatHref(id: string): string {
	return `${FIRST_MATE_PATH}?${new URLSearchParams({ chat: id }).toString()}`;
}

export type MatePart =
	| { kind: 'text'; id: string; text: string }
	| { kind: 'thinking'; id: string; text: string }
	| {
			kind: 'tool';
			id: string;
			call_id: string;
			name: string;
			/** `stopped`: the turn ended (stop, failure, lost agent) before it completed. */
			status: MissionToolCallStatus | 'stopped';
	  }
	| { kind: 'error'; id: string; message: string };

export type MateRole = 'you' | 'mate' | 'crew';

export interface MateBubble {
	/** The first event's id. */
	id: string;
	/**
	 * Who it is from: you, First Mate, or `crew`, Beadsmith telling the agent
	 * a mission it launched has finished (a crew notice, ADR-0020 rule 5).
	 */
	role: MateRole;
	/** When the bubble's first event arrived. */
	at: string;
	parts: MatePart[];
	/** How the agent's turn ended, once it has. */
	result?: { status: MissionResultStatus; git_pr_url?: string; duration_ms?: number };
}

/**
 * Group a chat's events into bubbles. Each `user` event is one bubble of
 * yours, or of the crew when it is a crew notice. The agent's events gather into one bubble until its turn's `result`;
 * whatever it says after that, asked or not, starts the next one. Each
 * `assistant` event is a whole block of text: consecutive blocks become
 * paragraphs. A tool call shows once, with its latest status; one still
 * running when its turn ends (a result or an error) shows as stopped, since
 * no completion will follow.
 *
 * @param events - The chat's events, oldest first.
 */
export function groupMateEvents(events: readonly MateEvent[]): MateBubble[] {
	const bubbles: MateBubble[] = [];
	let open: MateBubble | null = null;
	// The agent's bubbles since its last turn ended. A message of yours sent
	// mid-turn splits a turn into several bubbles; its tool calls still
	// belong to it.
	let turn: MateBubble[] = [];

	/** A turn ended: a tool it left running will never complete. */
	const endTurn = (): void => {
		for (const bubble of turn) {
			bubble.parts = bubble.parts.map((part) =>
				part.kind === 'tool' && part.status === 'running' ? { ...part, status: 'stopped' } : part
			);
		}
		turn = [];
	};

	/**
	 * Where a turn's ending goes: the open bubble, else the turn's latest
	 * one (a message of yours came in after its last event), else a new one.
	 */
	const turnEnd = (event: MateEvent): MateBubble =>
		open === null ? (turn.at(-1) ?? mate(event)) : mate(event);

	const mate = (event: MateEvent): MateBubble => {
		if (open === null) {
			open = { id: event.id, role: 'mate', at: event.at, parts: [] };
			bubbles.push(open);
		}
		// A bubble left open by an error joins the next turn only once that
		// turn writes to it.
		if (!turn.includes(open)) turn.push(open);
		return open;
	};

	for (const event of events) {
		switch (event.type) {
			case 'user':
				open = null;
				bubbles.push({
					id: event.id,
					// Sent as a user message, but by Beadsmith, not by you.
					role: isCrewNotice(event) ? 'crew' : 'you',
					at: event.at,
					parts: [{ kind: 'text', id: event.id, text: event.text }]
				});
				break;
			case 'assistant':
			case 'thinking': {
				const bubble = mate(event);
				const kind = event.type === 'assistant' ? 'text' : 'thinking';
				const last = bubble.parts.at(-1);
				if (last !== undefined && last.kind === kind) {
					bubble.parts[bubble.parts.length - 1] = {
						...last,
						text: `${last.text}\n\n${event.text}`
					};
				} else {
					bubble.parts.push({ kind, id: event.id, text: event.text });
				}
				break;
			}
			case 'tool_call': {
				const part: MatePart = {
					kind: 'tool',
					id: event.id,
					call_id: event.call_id,
					name: event.name,
					status: event.status
				};
				// Update the call where it first appeared, even if a message of
				// yours came in between; otherwise it starts here.
				const owner = turn.findLast((bubble) =>
					bubble.parts.some((item) => item.kind === 'tool' && item.call_id === event.call_id)
				);
				if (owner === undefined) {
					mate(event).parts.push(part);
				} else {
					const index = owner.parts.findIndex(
						(item) => item.kind === 'tool' && item.call_id === event.call_id
					);
					owner.parts[index] = { ...part, id: owner.parts[index]!.id };
				}
				break;
			}
			case 'error': {
				const bubble = turnEnd(event);
				bubble.parts.push({ kind: 'error', id: event.id, message: event.message });
				endTurn();
				break;
			}
			case 'result': {
				const bubble = turnEnd(event);
				bubble.result = {
					status: event.status,
					...(event.git_pr_url === undefined ? {} : { git_pr_url: event.git_pr_url }),
					...(event.duration_ms === undefined ? {} : { duration_ms: event.duration_ms })
				};
				if (event.text !== undefined && !bubble.parts.some((part) => part.kind === 'text')) {
					bubble.parts.push({ kind: 'text', id: event.id, text: event.text });
				}
				open = null;
				endTurn();
				break;
			}
		}
	}
	return bubbles;
}

/**
 * Whether the agent is mid-turn: something happened since its last `result`
 * (or `error`), such as a message of yours or the start of its own reply.
 *
 * @param events - The chat's events, oldest first.
 */
export function isWorking(events: readonly MateEvent[]): boolean {
	let working = false;
	for (const event of events) {
		working = event.type !== 'result' && event.type !== 'error';
	}
	return working;
}

/**
 * Add events to a log, skipping ids it already has (a replay after a
 * reconnect, or the same event from another tab).
 *
 * @param log - Events so far.
 * @param incoming - New events, in order.
 */
export function mergeEvents(
	log: readonly MateEvent[],
	incoming: readonly MateEvent[]
): MateEvent[] {
	const seen = new Set(log.map((event) => event.id));
	const fresh = incoming.filter((event) => {
		if (seen.has(event.id)) {
			return false;
		}
		seen.add(event.id);
		return true;
	});
	return fresh.length === 0 ? [...log] : [...log, ...fresh];
}

/** Consecutive messages from one sender within this gap share a header. */
export const GROUP_GAP_MS = 7 * 60 * 1000;

/** Where a message sits in the transcript, after chat apps' message grouping. */
export interface MateRowPlacement {
	/** First of a run from one sender: it shows the avatar and time. */
	head: boolean;
	/** A new calendar day starts here: the divider's label. */
	day?: string;
}

/** Local calendar day of an ISO time, as a sortable key. */
function dayKey(iso: string): string {
	const date = new Date(iso);
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * A day divider's label: Today, Yesterday, or the date (with the year only
 * when it is not this year).
 *
 * @param iso - A time on that day.
 * @param now - The current time.
 */
export function dayLabel(iso: string, now = Date.now()): string {
	const date = new Date(iso);
	const today = new Date(now);
	if (dayKey(iso) === dayKey(today.toISOString())) return 'Today';
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (dayKey(iso) === dayKey(yesterday.toISOString())) return 'Yesterday';
	return date.toLocaleDateString(undefined, {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' })
	});
}

/** Clock time for a message header, such as 3:42 PM. */
export function clockTime(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime())
		? ''
		: date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Place each message: a header starts a run when the sender changes, the
 * day changes, or the sender paused for longer than `GROUP_GAP_MS`; a day
 * divider goes before the first message of each day.
 *
 * @param items - Messages in order, with their sender and time.
 * @param now - The current time, for Today and Yesterday.
 */
export function placeMateRows(
	items: readonly { role: MateRole; at: string }[],
	now = Date.now()
): MateRowPlacement[] {
	return items.map((item, index) => {
		const previous = index > 0 ? items[index - 1] : undefined;
		const new_day = previous === undefined || dayKey(previous.at) !== dayKey(item.at);
		const gap = previous === undefined ? Infinity : Date.parse(item.at) - Date.parse(previous.at);
		const head = new_day || previous?.role !== item.role || !(gap <= GROUP_GAP_MS);
		return new_day ? { head, day: dayLabel(item.at, now) } : { head };
	});
}

/**
 * Up to two initials for an avatar: from the name's first two words, else
 * the email's first letter.
 *
 * @param name - Display name, if any.
 * @param email - Email address, if any.
 */
export function initials(name: string | undefined, email: string | undefined): string {
	const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
	const letters =
		words.length > 0
			? words
					.slice(0, 2)
					.map((word) => [...word][0] ?? '')
					.join('')
			: ([...(email ?? '').trim()][0] ?? '');
	return letters.toLocaleUpperCase() || '?';
}

/**
 * Claude Code names MCP tools `mcp__<server>__<tool>`; the crew server is
 * `crew` (ADR-0020), so these are Beadsmith's own tools acting for you.
 */
export const CREW_TOOL_PREFIX = 'mcp__crew__';

/**
 * What each crew tool does, in words: while it runs, and once it returned.
 * A launch tool's "done" says the mission was requested, not that it ran:
 * the call can return a refusal, and the mission card reports the outcome
 * (design standards, section 9).
 */
const CREW_TOOL_VERBS: Record<string, readonly [running: string, done: string]> = {
	list_projects: ['Listing projects', 'Listed projects'],
	ready_work: ['Checking ready work', 'Checked ready work'],
	list_issues: ['Searching issues', 'Searched issues'],
	show_issue: ['Reading an issue', 'Read an issue'],
	list_missions: ['Checking missions', 'Checked missions'],
	show_mission: ['Reading a mission', 'Read a mission'],
	list_todos: ['Reading your todos', 'Read your todos'],
	create_todo: ['Adding a todo', 'Added a todo'],
	update_todo: ['Editing a todo', 'Edited a todo'],
	complete_todo: ['Completing a todo', 'Completed a todo'],
	route_todo: ['Routing a todo', 'Asked to route a todo'],
	file_issue: ['Requesting a File mission', 'Requested a File mission'],
	comment_issue: ['Requesting a Comment mission', 'Requested a Comment mission'],
	tackle_issue: ['Requesting a Tackle mission', 'Requested a Tackle mission'],
	discuss_issue: ['Requesting a Discuss mission', 'Requested a Discuss mission'],
	follow_up_mission: ['Sending a follow-up', 'Asked for a follow-up'],
	cancel_mission: ['Asking to cancel a mission', 'Asked to cancel a mission'],
	remember: ['Remembering something', 'Remembered something'],
	recall: ['Recalling memories', 'Recalled memories'],
	forget: ['Forgetting a memory', 'Forgot a memory']
};

/** Crew tools whose call can start a mission this chat owns. */
const LAUNCH_TOOLS: ReadonlySet<string> = new Set([
	'route_todo',
	'file_issue',
	'comment_issue',
	'tackle_issue',
	'discuss_issue',
	'follow_up_mission',
	'cancel_mission'
]);

export interface ToolActivity {
	/** One of Beadsmith's crew tools, rather than the agent's own (Bash, Read…). */
	crew: boolean;
	/** For a crew tool, a sentence-case phrase; otherwise the tool's name as sent. */
	label: string;
	/** For a crew tool, the bare name (`ready_work`), for the full-detail line. */
	tool?: string;
	/** A crew call that can start or change a mission. */
	launch: boolean;
}

/**
 * How a tool call reads in the chat. Crew tools get a phrase in the tense of
 * their status ("Checking ready work", then "Checked ready work"); a stopped
 * or failed call keeps the running phrase, since it never finished, and the
 * view marks which of the two it was. A crew tool this
 * build does not know reads as its name in words. Other tools keep their
 * name: they are the agent's own working steps, shown as chips.
 *
 * @param name - The tool name from the event, such as `mcp__crew__ready_work`.
 * @param status - Its latest status.
 */
export function toolActivity(
	name: string,
	status: MissionToolCallStatus | 'stopped'
): ToolActivity {
	if (!name.startsWith(CREW_TOOL_PREFIX)) {
		return { crew: false, label: name, launch: false };
	}
	const tool = name.slice(CREW_TOOL_PREFIX.length);
	const verbs = CREW_TOOL_VERBS[tool];
	const words = tool.replaceAll('_', ' ').trim();
	const fallback = words.length > 0 ? words[0]!.toUpperCase() + words.slice(1) : 'Crew tool';
	const label = verbs === undefined ? fallback : status === 'completed' ? verbs[1] : verbs[0];
	return { crew: true, label, tool, launch: LAUNCH_TOOLS.has(tool) };
}

/**
 * Whether new events mean the chat's missions may have changed: a launch
 * tool returned, or a crew notice reported an outcome.
 *
 * @param events - Events just added to the open chat.
 */
export function touchesMissions(events: readonly MateEvent[]): boolean {
	return events.some(
		(event) =>
			(event.type === 'user' && isCrewNotice(event)) ||
			(event.type === 'tool_call' &&
				event.status === 'completed' &&
				toolActivity(event.name, event.status).launch)
	);
}

/**
 * A run of the agent's own tool calls longer than this folds into a one-line
 * summary: a long turn can make hundreds of calls, and a wall of chips hides
 * the reply around it.
 */
export const TOOL_RUN_FOLD = 6;

export interface ToolRunSummary {
	/** Calls by tool name, most used first (ties keep first-use order). */
	counts: { name: string; count: number }[];
	/** The call still running, if any: what the agent is doing now. */
	running?: string;
	failed: number;
	stopped: number;
}

/**
 * Summarise a run of tool calls for its folded line.
 *
 * @param items - The run's calls, in order, with their latest status.
 */
export function toolRunSummary(
	items: readonly { name: string; status: MissionToolCallStatus | 'stopped' }[]
): ToolRunSummary {
	const counts = new Map<string, number>();
	let running: string | undefined;
	let failed = 0;
	let stopped = 0;
	for (const item of items) {
		counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
		if (item.status === 'running') running = item.name;
		else if (item.status === 'failed') failed += 1;
		else if (item.status === 'stopped') stopped += 1;
	}
	// Map keeps insertion order and sort is stable, so ties stay in first use.
	const sorted = [...counts].map(([name, count]) => ({ name, count }));
	sorted.sort((a, b) => b.count - a.count);
	return { counts: sorted, ...(running === undefined ? {} : { running }), failed, stopped };
}

/**
 * How long a dropped live stream may take to come back before the chat says
 * so. The server asks EventSource to reconnect after 3 seconds, and closes
 * the stream whenever the runner's side ends, so most drops heal unseen.
 */
export const STREAM_GRACE_MS = 8_000;

/**
 * How long a reopened stream must stay up before the chat counts it as
 * recovered. A runner failure opens the stream and closes it again at once;
 * clearing the notice on every open would make it flicker.
 */
export const STREAM_SETTLE_MS = 3_000;

/** Waits before each of Beadsmith's own reconnects, after EventSource gave up. */
const STREAM_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/**
 * How long to wait before reconnecting a stream that EventSource closed for
 * good (an error status from the server or a proxy, which it does not retry).
 *
 * @param attempt - Reconnects already tried since the stream was last up.
 * @returns The delay, or undefined when recovery should stop and ask.
 */
export function streamRetryDelay(attempt: number): number | undefined {
	return STREAM_RETRY_MS[attempt];
}

/**
 * Indent JSON text for reading; text that is not whole JSON (a result cut
 * to fit, an error sentence) is returned as it is.
 *
 * @param text - Crew call arguments or result, as kept.
 */
export function prettyJson(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

/**
 * Whether new events mean Beadsmith has answered crew calls the chat has not
 * read yet: a crew tool call finished, either way.
 *
 * @param events - Events just added to the open chat.
 * @param known - Call ids whose records the chat already holds.
 */
export function touchesCrewCalls(
	events: readonly MateEvent[],
	known: Readonly<Record<string, unknown>>
): boolean {
	return events.some(
		(event) =>
			event.type === 'tool_call' &&
			event.status !== 'running' &&
			known[event.call_id] === undefined &&
			toolActivity(event.name, event.status).crew
	);
}

/**
 * Where each mission the chat launched shows: under the agent's message that
 * was being written when it was created, the latest of the agent's bubbles
 * that began at or before it. A mission older than every agent bubble (a
 * clock skew, or its message fell out of the loaded page) goes under the
 * first; with no agent bubbles at all it goes in `unplaced`. Each list is
 * oldest first, the order they were started in.
 *
 * @param bubbles - The chat's bubbles, oldest first.
 * @param missions - The chat's missions, in any order.
 */
export function placeChatMissions<M extends { id: string; created_at: string }>(
	bubbles: readonly Pick<MateBubble, 'id' | 'role' | 'at'>[],
	missions: readonly M[]
): { by_bubble: Map<string, M[]>; unplaced: M[] } {
	const agent = bubbles.filter((bubble) => bubble.role === 'mate');
	const by_bubble = new Map<string, M[]>();
	const unplaced: M[] = [];
	const ordered = [...missions].sort(
		(a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id)
	);
	for (const mission of ordered) {
		const created = Date.parse(mission.created_at);
		const owner = agent.findLast((bubble) => Date.parse(bubble.at) <= created) ?? agent[0];
		if (owner === undefined) {
			unplaced.push(mission);
			continue;
		}
		by_bubble.set(owner.id, [...(by_bubble.get(owner.id) ?? []), mission]);
	}
	return { by_bubble, unplaced };
}
