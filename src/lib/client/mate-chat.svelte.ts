/**
 * The signed-in admin's First Mate chats, kept on the server
 * (`/api/mate/chats`, docs/first-mate.md). The open chat follows its event
 * stream with EventSource, which resumes from the last event id on its own
 * after a drop. Without a runner the server answers with a placeholder, and
 * members get no chats at all: First Mate is admin-only for now.
 *
 * Chats from the localStorage era (`bdui:first-mate-chats`) are not imported;
 * they stay in that browser, unread.
 */
import { run_place } from '#lib/client/agent-runner.svelte.js';
import { browser } from '$app/env';
import { api, errorMessage } from '#lib/client/api.js';
import { isMissionEvent } from '#lib/mission-events.js';
import { chatTitle, isWorking, mergeEvents } from '#lib/client/mate-chat.js';
import type { MateChat, MateEvent, MateStatus } from '#lib/mate.js';

/** A message on its way, until its `user` event comes back. */
export interface PendingMessage {
	message_id: string;
	text: string;
	at: string;
	/** The runner's id for it, once the POST answered. */
	event_id?: string;
	error?: string;
}

function sortChats(chats: MateChat[]): MateChat[] {
	return [...chats].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function newMessageId(): string {
	return globalThis.crypto.randomUUID();
}

function lastTerminalId(events: MateEvent[]): string | undefined {
	return events.findLast((event) => event.type === 'result' || event.type === 'error')?.id;
}

class MateChats {
	status = $state<MateStatus | null>(null);
	chats = $state<MateChat[]>([]);
	loaded = $state(false);
	list_error = $state<string | null>(null);

	/** The chat whose events are loaded. */
	open_id = $state<string | null>(null);
	events = $state<MateEvent[]>([]);
	// Ephemeral page-session input only; never persisted in browser storage.
	drafts = $state<Record<string, string>>({});
	pending_by_chat = $state<Record<string, PendingMessage[]>>({});
	opening = $state(false);
	scope_saving = $state(false);
	action_error = $state<string | null>(null);
	interrupt_requested = $state(false);

	get pending(): PendingMessage[] {
		return this.open_id ? (this.pending_by_chat[this.open_id] ?? []) : [];
	}
	set pending(items: PendingMessage[]) {
		if (this.open_id) this.pending_by_chat[this.open_id] = items;
	}
	open_error = $state<string | null>(null);
	/** The live stream is down; EventSource keeps retrying. */
	stream_error = $state<string | null>(null);
	interrupting = $state(false);

	#generation = 0;
	#source: EventSource | null = null;
	#loading: Promise<void> | null = null;

	get connected(): boolean {
		return this.status?.connected === true;
	}

	/** Members cannot keep chats; admins can, runner or not. */
	get can_chat(): boolean {
		return this.status !== null && this.status.reason !== 'admin_only';
	}

	/** The agent is mid-turn, or a message of yours is on its way. */
	get working(): boolean {
		return isWorking(this.events) || this.pending.some((item) => item.error === undefined);
	}

	/** Read status and the chat list once, on first use in the browser. */
	load(): Promise<void> {
		if (!browser) {
			return Promise.resolve();
		}
		this.#loading ??= (async () => {
			try {
				this.status = await api.mateStatus();
				run_place.syncRunners(this.status.runners);
				if (this.can_chat) {
					this.chats = sortChats((await api.mateChats()).chats);
				}
				this.list_error = null;
			} catch (error) {
				this.list_error = errorMessage(error);
				this.#loading = null;
			} finally {
				this.loaded = true;
			}
		})();
		return this.#loading;
	}

	get(id: string | null | undefined): MateChat | undefined {
		return id ? this.chats.find((chat) => chat.id === id) : undefined;
	}

	/**
	 * Load a chat's stored events and, with a runner, follow it live.
	 *
	 * @param id - Chat id.
	 */
	async open(id: string) {
		if (
			this.open_id === id &&
			!this.open_error &&
			!this.stream_error &&
			this.#source?.readyState !== EventSource.CLOSED
		) {
			return;
		}
		const events = this.open_id === id ? this.events : [];
		this.close();
		this.events = events;
		const generation = this.#generation;
		this.open_id = id;
		this.opening = true;
		this.open_error = null;
		try {
			const detail = await api.mateChat(id);
			if (this.#generation !== generation) {
				return;
			}
			this.#add(detail.events);
			this.#upsertChat(detail.chat);
			if (this.connected) {
				this.#follow(id);
			}
		} catch (error) {
			if (this.#generation === generation) {
				this.open_error = errorMessage(error);
			}
		} finally {
			if (this.#generation === generation) this.opening = false;
		}
	}

	/** Stop following the open chat. The agent keeps working on the runner. */
	close() {
		this.#generation += 1;
		this.#source?.close();
		this.#source = null;
		this.open_id = null;
		this.events = [];
		this.open_error = null;
		this.stream_error = null;
		this.interrupting = false;
		this.interrupt_requested = false;
		this.action_error = null;
		this.scope_saving = false;
		this.opening = false;
	}

	/**
	 * Start a chat and send its first message.
	 *
	 * @param text - The message.
	 * @param scope - Project id, or null for every project.
	 * @returns The new chat's id.
	 */
	async start(text: string, scope: string | null): Promise<string> {
		const runner = run_place.chatRunner();
		const { chat } = await api.createMateChat({
			title: chatTitle(text),
			scope,
			...(runner === undefined ? {} : { runner })
		});
		this.#upsertChat(chat);
		await this.open(chat.id);
		void this.send(chat.id, text);
		return chat.id;
	}

	/**
	 * Send a message. With a runner it comes back through the stream; until
	 * then it shows as pending, and a failed one can be retried as the same
	 * message (the runner drops a repeat of its `message_id`).
	 *
	 * @param id - Chat id.
	 * @param text - The message.
	 * @param message_id - Reused on a retry.
	 */
	async send(id: string, text: string, message_id = newMessageId()) {
		const message = text.trim();
		if (message.length === 0 || this.open_id !== id) {
			return;
		}
		const item: PendingMessage = { message_id, text: message, at: new Date().toISOString() };
		this.pending_by_chat[id] = [
			...(this.pending_by_chat[id] ?? []).filter((p) => p.message_id !== message_id),
			item
		];
		try {
			const result = await api.sendMateMessage(id, { text: message, message_id });
			if (result.events !== undefined) {
				if (this.open_id === id) this.#add(result.events);
				this.pending_by_chat[id] = (this.pending_by_chat[id] ?? []).filter(
					(p) => p.message_id !== message_id
				);
			} else if (result.event_id !== undefined) {
				const event_id = result.event_id;
				if (this.open_id === id && this.events.some((event) => event.id === event_id)) {
					this.pending_by_chat[id] = (this.pending_by_chat[id] ?? []).filter(
						(p) => p.message_id !== message_id
					);
				} else {
					this.pending_by_chat[id] = (this.pending_by_chat[id] ?? []).map((p) =>
						p.message_id === message_id ? { ...p, event_id } : p
					);
				}
			}
		} catch (error) {
			this.pending_by_chat[id] = (this.pending_by_chat[id] ?? []).map((p) =>
				p.message_id === message_id ? { ...p, error: errorMessage(error) } : p
			);
		}
	}

	retry(id: string, item: PendingMessage) {
		void this.send(id, item.text, item.message_id);
	}

	discard(item: PendingMessage) {
		this.pending = this.pending.filter((p) => p.message_id !== item.message_id);
	}

	/** Stop the agent's current turn. */
	async interrupt(id: string) {
		if (this.interrupting || this.interrupt_requested) return;
		const generation = this.#generation;
		const terminal_id = lastTerminalId(this.events);
		const had_active_turn = isWorking(this.events);
		this.action_error = null;
		this.interrupting = true;
		try {
			await api.interruptMate(id);
			// Pending sends may fail without a terminal event, and a turn may
			// finish before this POST replies. Only latch the observed active turn.
			if (
				generation === this.#generation &&
				had_active_turn &&
				isWorking(this.events) &&
				lastTerminalId(this.events) === terminal_id
			)
				this.interrupt_requested = true;
		} catch (error) {
			if (generation === this.#generation)
				this.action_error = 'Could not stop the turn. ' + errorMessage(error);
		} finally {
			if (generation === this.#generation) this.interrupting = false;
		}
	}

	/**
	 * Change what a chat is about, from its next message on.
	 *
	 * @param id - Chat id.
	 * @param scope - Project id, or null for every project.
	 */
	async setScope(id: string, scope: string | null) {
		if (this.scope_saving) return;
		const generation = this.#generation;
		this.scope_saving = true;
		this.action_error = null;
		try {
			this.#upsertChat((await api.updateMateChat(id, { scope })).chat);
		} catch (error) {
			if (generation === this.#generation)
				this.action_error = 'Scope was not changed. ' + errorMessage(error);
		} finally {
			if (generation === this.#generation) this.scope_saving = false;
		}
	}

	/** Delete a chat; with a runner, its session stops too. Throws when it could not. */
	async remove(id: string) {
		await api.deleteMateChat(id);
		delete this.drafts[id];
		delete this.pending_by_chat[id];
		this.chats = this.chats.filter((chat) => chat.id !== id);
		if (this.open_id === id) {
			this.close();
		}
	}

	#follow(id: string) {
		const last = this.events.at(-1)?.id;
		const query = last === undefined ? '' : `?${new URLSearchParams({ after: last })}`;
		const source = new EventSource(`/api/mate/chats/${encodeURIComponent(id)}/events${query}`);
		this.#source?.close();
		this.#source = source;
		source.onopen = () => {
			if (this.#source !== source) return;
			this.stream_error = null;
		};
		source.onmessage = (message: MessageEvent<string>) => {
			if (this.#source !== source) return;
			let data: unknown;
			try {
				data = JSON.parse(message.data);
			} catch {
				return;
			}
			if (!isMissionEvent(data)) {
				return;
			}
			const at = (data as { at?: unknown }).at;
			this.#add([{ ...data, at: typeof at === 'string' ? at : new Date().toISOString() }]);
		};
		source.addEventListener('runner_error', (message) => {
			if (this.#source !== source) return;
			let text = 'The mate runner is unavailable.';
			try {
				const parsed = JSON.parse((message as MessageEvent<string>).data) as { message?: unknown };
				if (typeof parsed.message === 'string') text = parsed.message;
			} catch {
				// Keep the generic message.
			}
			this.stream_error = `${text} Retrying…`;
		});
		source.onerror = () => {
			if (this.#source !== source) return;
			if (source.readyState === EventSource.CLOSED) {
				this.stream_error = 'The live chat stream closed. Reconnect to catch up.';
			} else {
				this.stream_error = 'Connection lost. Reconnecting automatically…';
			}
		};
	}

	#add(incoming: MateEvent[]) {
		if (incoming.some((event) => event.type === 'result' || event.type === 'error'))
			this.interrupt_requested = false;
		const before = this.events.length;
		this.events = mergeEvents(this.events, incoming);
		const ids = new Set(this.events.map((event) => event.id));
		const messages = new Set(
			[...this.events, ...incoming].flatMap((event) =>
				event.type === 'user' && event.message_id !== undefined ? [event.message_id] : []
			)
		);
		this.pending = this.pending.filter(
			(p) => !messages.has(p.message_id) && (p.event_id === undefined || !ids.has(p.event_id))
		);
		if (this.events.length === before) {
			return;
		}
		const chat = this.get(this.open_id);
		const last = this.events.at(-1);
		if (chat && last && last.at > chat.updated_at) {
			this.#upsertChat({ ...chat, updated_at: last.at });
		}
	}

	#upsertChat(chat: MateChat) {
		this.chats = sortChats([chat, ...this.chats.filter((item) => item.id !== chat.id)]);
	}
}

export const mate_chats = new MateChats();
