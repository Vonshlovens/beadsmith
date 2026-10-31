/**
 * The First Mate chats in this browser, kept in localStorage. No model is
 * connected: each message gets {@link UNWIRED_REPLY} after a short pause, so
 * the conversation reads the way it will once one is.
 */
import { browser } from '$app/environment';
import {
	MAX_MESSAGE_CHARS,
	UNWIRED_REPLY,
	chatTitle,
	newChatId,
	parseStoredChats,
	sortChats,
	type Chat,
	type ChatRole
} from '$lib/client/mate-chat';

const STORAGE_KEY = 'bdui:first-mate-chats';
const REPLY_DELAY_MS = 900;

class MateChats {
	chats = $state<Chat[]>([]);
	/** Chat ids waiting on a reply. */
	waiting = $state<string[]>([]);
	#loaded = false;

	/** Read storage once, on first use in the browser. */
	load() {
		if (!browser || this.#loaded) {
			return;
		}
		this.#loaded = true;
		let raw: string | null = null;
		try {
			raw = window.localStorage.getItem(STORAGE_KEY);
		} catch {
			raw = null;
		}
		this.chats = parseStoredChats(raw);
	}

	get(id: string | null | undefined): Chat | undefined {
		return id ? this.chats.find((chat) => chat.id === id) : undefined;
	}

	isWaiting(id: string): boolean {
		return this.waiting.includes(id);
	}

	/**
	 * Start a chat with its first message.
	 *
	 * @param text - The message.
	 * @param scope - Project id, or null for every project.
	 * @returns The new chat's id.
	 */
	start(text: string, scope: string | null): string {
		const now = new Date().toISOString();
		const chat: Chat = {
			id: newChatId(),
			title: chatTitle(text),
			scope,
			created_at: now,
			updated_at: now,
			messages: []
		};
		this.chats = sortChats([chat, ...this.chats]);
		this.send(chat.id, text);
		return chat.id;
	}

	/**
	 * Add a message to a chat and queue the reply.
	 *
	 * @param id - Chat id.
	 * @param text - The message.
	 */
	send(id: string, text: string) {
		const message = text.trim().slice(0, MAX_MESSAGE_CHARS);
		if (message.length === 0 || this.isWaiting(id)) {
			return;
		}
		this.#append(id, 'you', message);
		this.waiting = [...this.waiting, id];
		setTimeout(() => {
			this.waiting = this.waiting.filter((item) => item !== id);
			this.#append(id, 'mate', UNWIRED_REPLY);
		}, REPLY_DELAY_MS);
	}

	/**
	 * Change what a chat is about.
	 *
	 * @param id - Chat id.
	 * @param scope - Project id, or null for every project.
	 */
	setScope(id: string, scope: string | null) {
		this.chats = this.chats.map((chat) => (chat.id === id ? { ...chat, scope } : chat));
		this.#save();
	}

	remove(id: string) {
		this.chats = this.chats.filter((chat) => chat.id !== id);
		this.waiting = this.waiting.filter((item) => item !== id);
		this.#save();
	}

	#append(id: string, role: ChatRole, text: string) {
		const at = new Date().toISOString();
		const chat = this.get(id);
		if (!chat) {
			return;
		}
		const next: Chat = {
			...chat,
			updated_at: at,
			messages: [...chat.messages, { id: newChatId(), role, text, at }]
		};
		this.chats = sortChats([next, ...this.chats.filter((item) => item.id !== id)]);
		this.#save();
	}

	#save() {
		if (!browser) {
			return;
		}
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.chats));
		} catch {
			// Storage full or blocked: the chat still works for this visit.
		}
	}
}

export const mate_chats = new MateChats();
