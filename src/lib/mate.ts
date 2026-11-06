/**
 * First Mate chats, shared by the server routes and the browser.
 *
 * A chat is one long-lived agent session on the mate runner
 * (docs/first-mate.md). Its history is the log of MissionEvents Beadsmith has
 * seen for that session, in the runner's order: what the user said, what the
 * agent said and did, and where each of its turns ended. The agent may speak
 * without being asked, so the log is not a list of question/answer pairs.
 */
import type { MissionEvent } from '#lib/mission-events.js';

/** One chat as listed. */
export interface MateChat {
	id: string;
	title: string;
	/** Project id the chat is about; null for every project. */
	scope: string | null;
	/** ISO timestamps. */
	created_at: string;
	updated_at: string;
}

/** A stored event, with the time Beadsmith first saw it. */
export type MateEvent = MissionEvent & { at: string };

export interface MateChatDetail {
	chat: MateChat;
	/** Oldest first. */
	events: MateEvent[];
}

/**
 * Whether this viewer's messages reach a model. `admin_only`: the viewer is
 * not an admin (chats are admin-only for now); `unconfigured`: an admin, but
 * no runner is set up, so chats are stored and get a placeholder reply.
 * `reachable` is the runner's cached health, for admins.
 */
export interface MateStatus {
	connected: boolean;
	reason?: 'unconfigured' | 'admin_only';
	reachable?: boolean;
}

/** What `POST /api/mate/chats/:id/messages` answers. */
export interface MateSendResult {
	/** The runner's id for the user event, when a runner took the message. */
	event_id?: string;
	/** Events stored without a runner (the placeholder reply). */
	events?: MateEvent[];
}

/** Chats one account may keep. */
export const MAX_CHATS = 100;

/** A message is capped where the agent composer caps it. */
export const MAX_MESSAGE_CHARS = 4000;

/** `message_id`: generated once per message, reused on a retry. */
export const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Server-generated chat ids. */
export const CHAT_ID_PATTERN = /^mc_[a-f0-9]{24}$/;

const TITLE_CHARS = 60;

/** What First Mate says while no model is connected. */
export const UNWIRED_REPLY =
	"I'm not connected to a model yet, so I can't answer this one. This chat is the interface only.\n\n" +
	'Until then, ⌘K has the commands: what is ready, file an issue, tackle one, or jump to a project.';

/**
 * A chat's title: its first message's first line, collapsed and cut short.
 *
 * @param text - The first message.
 */
export function chatTitle(text: string): string {
	const line = text.trim().split('\n', 1)[0]?.replace(/\s+/g, ' ').trim() ?? '';
	if (line.length === 0) {
		return 'New chat';
	}
	return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…` : line;
}
