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
import type { MateEvent } from '#lib/mate.js';
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

export interface MateBubble {
	/** The first event's id. */
	id: string;
	role: 'you' | 'mate';
	/** When the bubble's first event arrived. */
	at: string;
	parts: MatePart[];
	/** How the agent's turn ended, once it has. */
	result?: { status: MissionResultStatus; git_pr_url?: string; duration_ms?: number };
}

/**
 * Group a chat's events into bubbles. Each `user` event is one bubble of
 * yours. The agent's events gather into one bubble until its turn's `result`;
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
					role: 'you',
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
	items: readonly { role: 'you' | 'mate'; at: string }[],
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
