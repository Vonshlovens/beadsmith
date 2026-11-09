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

/**
 * Where a chat's agent runs: `remote`, the HTTP mate runner
 * (`BDX_MATE_RUNNER_URL`, for example the maintainer's forge host), or `e2b`,
 * an E2B sandbox per chat ("Sand"; docs/sand-e2b.md).
 */
export const MATE_RUNNER_IDS = ['remote', 'e2b'] as const;
export type MateRunnerId = (typeof MATE_RUNNER_IDS)[number];

/** One configured chat runner, as the start screen offers it. */
export interface MateRunnerInfo {
	id: MateRunnerId;
	label: string;
}

/** One chat as listed. */
export interface MateChat {
	id: string;
	title: string;
	/** Project id the chat is about; null for every project. */
	scope: string | null;
	/** Where the chat's agent runs; fixed when the chat is created. */
	runner: MateRunnerId;
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
	/** Configured chat runners, default first (admins only). */
	runners?: MateRunnerInfo[];
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

/**
 * Message ids Beadsmith itself sends with: a crew notice, the short
 * system-authored message that tells a chat's agent a mission it launched has
 * finished (ADR-0020 rule 5). The runner contract has no author field, but it
 * carries the message id through to the stored `user` event, so the prefix is
 * what marks the event as Beadsmith's rather than the user's. The browser may
 * not send ids with this prefix.
 */
export const CREW_NOTICE_PREFIX = 'crew-';

/** Whether a stored event is a crew notice rather than something the user typed. */
export function isCrewNotice(event: MissionEvent): boolean {
	return event.type === 'user' && event.message_id?.startsWith(CREW_NOTICE_PREFIX) === true;
}

/**
 * One crew tool call Beadsmith answered for a chat (ADR-0020), as the chat
 * lists them: enough to word a refusal next to its activity line. Crew tools
 * run inside Beadsmith, so this is Beadsmith's own record of what it did for
 * the chat's owner, not the agent's tool output (which is never stored).
 */
export interface MateCrewCall {
	/** Claude Code's tool use id: the `call_id` of the chat's `tool_call` event. */
	call_id: string;
	/** Crew tool name without the MCP prefix, for example `tackle_issue`. */
	tool: string;
	/** The tool refused or failed; `reason` says why. */
	is_error: boolean;
	/** The start of the error the agent was given, when `is_error`. */
	reason?: string;
	/** The mission the call started or replayed, when it was a launch. */
	mission_id?: string;
	/** ISO time Beadsmith answered the call. */
	at: string;
}

/** A crew call with what went in and what came out, read on demand. */
export interface MateCrewCallDetail extends MateCrewCall {
	/** The arguments as the agent sent them, JSON, cut at `CREW_CALL_ARGUMENTS_MAX`. */
	arguments: string;
	/** The result or error text the agent was given, cut at `CREW_CALL_RESULT_MAX`. */
	result: string;
}

/** Bounds on what a crew call record keeps (the agent may have been sent more). */
export const CREW_CALL_ARGUMENTS_MAX = 4_000;
export const CREW_CALL_RESULT_MAX = 8_000;
export const CREW_CALL_REASON_MAX = 300;
/** Crew call records one chat keeps; older ones are pruned as new ones land. */
export const CREW_CALLS_PER_CHAT = 200;

/** Claude Code tool use ids: what a crew call record is keyed and looked up by. */
export const CREW_CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

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
