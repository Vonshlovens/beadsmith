/**
 * First Mate chats: the conversation model behind `/first-mate`.
 *
 * The chat is an interface without a model behind it yet. A message gets the
 * placeholder reply below, nothing leaves the browser, and chats are kept in
 * localStorage (see mate-chat.svelte.ts). The read-only contract still
 * holds when a model arrives: First Mate reads Beads, agents change it.
 */

import { FIRST_MATE_PATH } from '$lib/client/first-mate';

export type ChatRole = 'you' | 'mate';

export interface ChatMessage {
	id: string;
	role: ChatRole;
	text: string;
	/** ISO timestamp. */
	at: string;
}

export interface Chat {
	id: string;
	title: string;
	/** Project id the chat is about; null for every project. */
	scope: string | null;
	created_at: string;
	updated_at: string;
	messages: ChatMessage[];
}

/** Chats kept per browser; the oldest drop off first. */
export const MAX_CHATS = 50;

/** A message is capped where the agent composer caps it. */
export const MAX_MESSAGE_CHARS = 4000;

const TITLE_CHARS = 60;

/** What First Mate says until a model is connected. */
export const UNWIRED_REPLY =
	"I'm not connected to a model yet, so I can't answer this one. This chat is the interface only: what you type stays in this browser.\n\n" +
	'Until then, ⌘K has the commands: what is ready, file an issue, tackle one, or jump to a project.';

/** Starting points offered on a new chat. */
export const STARTERS: readonly string[] = [
	"What's ready to work on across every project?",
	'Which issues are stalled, and what is blocking them?',
	'Summarise what changed this week.',
	'Draft an issue for a bug I describe.'
];

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

/**
 * Link to one chat on the First Mate page.
 *
 * @param id - Chat id.
 */
export function chatHref(id: string): string {
	return `${FIRST_MATE_PATH}?${new URLSearchParams({ chat: id }).toString()}`;
}

/** A short random id; chats never leave the browser, so it need not be global. */
export function newChatId(): string {
	return globalThis.crypto.randomUUID().slice(0, 12);
}

function isMessage(value: unknown): value is ChatMessage {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const item = value as Record<string, unknown>;
	return (
		typeof item.id === 'string' &&
		(item.role === 'you' || item.role === 'mate') &&
		typeof item.text === 'string' &&
		typeof item.at === 'string'
	);
}

function toChat(value: unknown): Chat | null {
	if (typeof value !== 'object' || value === null) {
		return null;
	}
	const item = value as Record<string, unknown>;
	if (
		typeof item.id !== 'string' ||
		typeof item.title !== 'string' ||
		typeof item.created_at !== 'string' ||
		typeof item.updated_at !== 'string' ||
		!Array.isArray(item.messages)
	) {
		return null;
	}
	return {
		id: item.id,
		title: item.title,
		scope: typeof item.scope === 'string' ? item.scope : null,
		created_at: item.created_at,
		updated_at: item.updated_at,
		messages: item.messages.filter(isMessage)
	};
}

/**
 * Newest first, capped at {@link MAX_CHATS}.
 *
 * @param chats - Chats in any order.
 */
export function sortChats(chats: Chat[]): Chat[] {
	return [...chats].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, MAX_CHATS);
}

/**
 * Read stored chats, dropping anything malformed rather than failing.
 *
 * @param raw - The localStorage value, or null when absent.
 */
export function parseStoredChats(raw: string | null): Chat[] {
	if (raw === null || raw.length === 0) {
		return [];
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(data)) {
		return [];
	}
	return sortChats(data.map(toChat).filter((chat): chat is Chat => chat !== null));
}
