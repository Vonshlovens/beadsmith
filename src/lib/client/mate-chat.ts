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
	| { kind: 'tool'; id: string; call_id: string; name: string; status: MissionToolCallStatus }
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
 * paragraphs. A tool call shows once, with its latest status.
 *
 * @param events - The chat's events, oldest first.
 */
export function groupMateEvents(events: readonly MateEvent[]): MateBubble[] {
	const bubbles: MateBubble[] = [];
	let open: MateBubble | null = null;

	const mate = (event: MateEvent): MateBubble => {
		if (open === null) {
			open = { id: event.id, role: 'mate', at: event.at, parts: [] };
			bubbles.push(open);
		}
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
				const bubble = mate(event);
				const index = bubble.parts.findIndex(
					(part) => part.kind === 'tool' && part.call_id === event.call_id
				);
				const part: MatePart = {
					kind: 'tool',
					id: event.id,
					call_id: event.call_id,
					name: event.name,
					status: event.status
				};
				if (index === -1) {
					bubble.parts.push(part);
				} else {
					bubble.parts[index] = { ...part, id: bubble.parts[index]!.id };
				}
				break;
			}
			case 'error':
				mate(event).parts.push({ kind: 'error', id: event.id, message: event.message });
				break;
			case 'result': {
				const bubble = mate(event);
				bubble.result = {
					status: event.status,
					...(event.git_pr_url === undefined ? {} : { git_pr_url: event.git_pr_url }),
					...(event.duration_ms === undefined ? {} : { duration_ms: event.duration_ms })
				};
				if (event.text !== undefined && !bubble.parts.some((part) => part.kind === 'text')) {
					bubble.parts.push({ kind: 'text', id: event.id, text: event.text });
				}
				open = null;
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
