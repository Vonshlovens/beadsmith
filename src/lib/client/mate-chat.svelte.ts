/**
 * The signed-in admin's First Mate chats, kept on the server
 * (`/api/mate/chats`, docs/first-mate.md). The open chat follows its event
 * stream with EventSource, which resumes from the last event id on its own
 * after a drop; when it gives up (an error status), the store reconnects
 * from the last event itself, with backoff. A drop is only reported once it
 * has lasted, and asks for a manual reconnect only after those retries ran
 * out. Without a runner the server answers with a placeholder, and
 * members get no chats at all: First Mate is admin-only for now.
 *
 * Chats from the localStorage era (`bdui:first-mate-chats`) are not imported;
 * they stay in that browser, unread.
 */
import { agent_choice } from '#lib/client/agent-choice.svelte.js';
import { run_place } from '#lib/client/agent-runner.svelte.js';
import { browser } from '$app/env';
import { isBusyStatus, isFollowedMission, THREAD_POLL_MS } from '#lib/client/agent.js';
import { api, errorMessage } from '#lib/client/api.js';
import { statusSnapshot } from '#lib/client/projects.svelte.js';
import { isMissionEvent } from '#lib/mission-events.js';
import {
	chatTitle,
	isWorking,
	mergeEvents,
	STREAM_GRACE_MS,
	STREAM_SETTLE_MS,
	streamRetryDelay,
	touchesCrewCalls,
	touchesMissions
} from '#lib/client/mate-chat.js';
import type {
	MateChat,
	MateCrewCall,
	MateCrewCallDetail,
	MateEvent,
	MateStatus
} from '#lib/mate.js';
import type { DispatchRequest, Mission } from '#lib/types.js';

/**
 * How often the open chat re-reads its missions that are still running.
 * Slower than a mission thread's own poll: these are glanceable cards, and
 * a finished mission also arrives as a crew notice, which refreshes at once.
 */
export const CHAT_MISSION_POLL_MS = THREAD_POLL_MS * 3;

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
	/**
	 * The live stream has been down past the grace period: what to tell the
	 * reader. Null while it is up, or during a drop that may still heal.
	 */
	stream_error = $state<string | null>(null);
	/** Automatic reconnects ran out; only a manual reconnect will try again. */
	stream_lost = $state(false);
	interrupting = $state(false);

	/** Missions the open chat's crew tools launched (ADR-0020 rule 5). */
	missions = $state<Mission[]>([]);
	/** Their first read failed; the chat itself still works. */
	missions_error = $state<string | null>(null);
	/** Mission ids with a cancel request in flight. */
	cancelling = $state<Record<string, boolean>>({});
	/** Why a mission's cancel failed, by mission id, until the next try. */
	cancel_errors = $state<Record<string, string>>({});

	/**
	 * Beadsmith's record of the open chat's crew tool calls, by tool use id:
	 * why a refused one failed and which mission a launch started.
	 */
	crew_calls = $state<Record<string, MateCrewCall>>({});
	/** Arguments and results, read when the owner opens a call's details. */
	crew_details = $state<
		Record<string, { call?: MateCrewCallDetail; loading?: boolean; error?: string }>
	>({});

	#generation = 0;
	/** Bumped per missions read; a reply from an older read is dropped. */
	#missions_seq = 0;
	/** Same, for crew call reads. */
	#crew_seq = 0;
	#mission_poll: ReturnType<typeof setInterval> | null = null;
	#source: EventSource | null = null;
	#loading: Promise<void> | null = null;
	/** Shows the drop notice if the stream is not back in time. */
	#grace_timer: ReturnType<typeof setTimeout> | null = null;
	/** Confirms a reopened stream once it has stayed up. */
	#settle_timer: ReturnType<typeof setTimeout> | null = null;
	/** Beadsmith's own reconnect, after EventSource closed for good. */
	#retry_timer: ReturnType<typeof setTimeout> | null = null;
	#retry_attempt = 0;
	/** The runner's own explanation of the last drop, when it sent one. */
	#runner_message: string | null = null;

	constructor() {
		// Coming back online is the likeliest moment a wait can be skipped.
		if (typeof window !== 'undefined') {
			window.addEventListener('online', () => this.#reconnectNow());
		}
	}

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
			void this.loadMissions(id);
			void this.loadCrewCalls(id);
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
		this.#clearStreamTimers();
		this.#retry_attempt = 0;
		this.#runner_message = null;
		this.open_id = null;
		this.events = [];
		this.open_error = null;
		this.stream_error = null;
		this.stream_lost = false;
		this.interrupting = false;
		this.interrupt_requested = false;
		this.action_error = null;
		this.scope_saving = false;
		this.opening = false;
		this.missions = [];
		this.missions_error = null;
		this.cancelling = {};
		this.cancel_errors = {};
		this.crew_calls = {};
		this.crew_details = {};
		this.#syncMissionPoll();
	}

	/**
	 * Read the open chat's crew call records. A failure keeps what is shown:
	 * the activity lines still read without them.
	 *
	 * @param id - The open chat's id.
	 */
	async loadCrewCalls(id: string) {
		const generation = this.#generation;
		const seq = ++this.#crew_seq;
		try {
			const { calls } = await api.mateCrewCalls(id);
			if (this.#generation !== generation || seq !== this.#crew_seq) return;
			this.crew_calls = Object.fromEntries(calls.map((call) => [call.call_id, call]));
		} catch {
			// The next finished crew call reads them again.
		}
	}

	/**
	 * Read one crew call's arguments and result, once; a failed read can be
	 * retried by opening the details again.
	 *
	 * @param call_id - The call's tool use id.
	 */
	async loadCrewCall(call_id: string) {
		const id = this.open_id;
		const known = this.crew_details[call_id];
		if (id === null || known?.call !== undefined || known?.loading) return;
		const generation = this.#generation;
		this.crew_details[call_id] = { loading: true };
		try {
			const { call } = await api.mateCrewCall(id, call_id);
			if (this.#generation === generation) this.crew_details[call_id] = { call };
		} catch (error) {
			if (this.#generation === generation) {
				this.crew_details[call_id] = { error: errorMessage(error) };
			}
		}
	}

	/**
	 * Read the open chat's missions. A failure keeps the cards already shown
	 * (they are stale, not gone) and only says so when there are none.
	 *
	 * @param id - The open chat's id.
	 */
	async loadMissions(id: string) {
		const generation = this.#generation;
		// Opening, polling and crew events can overlap; only the newest read
		// may land, or an older answer could hide a card that just appeared.
		const seq = ++this.#missions_seq;
		try {
			const { missions } = await api.mateChatMissions(id);
			if (this.#generation !== generation || seq !== this.#missions_seq) return;
			this.missions = missions;
			this.missions_error = null;
		} catch (error) {
			if (this.#generation !== generation || seq !== this.#missions_seq) return;
			this.missions_error = errorMessage(error);
		}
		this.#syncMissionPoll();
	}

	/**
	 * Cancel a mission the chat launched, as its thread's Stop does. The card
	 * shows the status the server answers with; the crew notice follows.
	 *
	 * @param mission - One of `missions`.
	 */
	async cancelMission(mission: Mission) {
		if (this.cancelling[mission.id]) return;
		const generation = this.#generation;
		this.cancelling[mission.id] = true;
		delete this.cancel_errors[mission.id];
		try {
			const { request } = await api.cancelDispatch(mission.project_id, mission.id);
			if (this.#generation === generation) this.#updateMission(request);
		} catch (error) {
			if (this.#generation === generation) {
				this.cancel_errors[mission.id] = `Could not stop it. ${errorMessage(error)}`;
			}
		} finally {
			if (this.#generation === generation) delete this.cancelling[mission.id];
		}
	}

	#updateMission(request: DispatchRequest) {
		this.missions = this.missions.map((mission) =>
			mission.id === request.id ? { ...mission, ...request } : mission
		);
		this.#syncMissionPoll();
	}

	/**
	 * Poll while any mission the chat shows is still working and followed.
	 * Each read goes through the mission's own status route, which also
	 * records a finished run (the missions list only reads what is stored).
	 */
	#syncMissionPoll() {
		const dispatch = statusSnapshot()?.dispatch ?? null;
		const busy = this.missions.filter(
			(mission) => isBusyStatus(mission.status) && isFollowedMission(mission, dispatch)
		);
		if (busy.length === 0 || this.open_id === null) {
			if (this.#mission_poll !== null) clearInterval(this.#mission_poll);
			this.#mission_poll = null;
			return;
		}
		if (this.#mission_poll !== null) return;
		const generation = this.#generation;
		this.#mission_poll = setInterval(() => {
			if (this.#generation !== generation) return;
			for (const mission of this.missions) {
				if (!isBusyStatus(mission.status)) continue;
				void api
					.dispatch(mission.project_id, mission.id)
					.then(({ request }) => {
						if (this.#generation === generation) this.#updateMission(request);
					})
					.catch(() => {
						// A missed poll keeps the last status; the next one tries again.
					});
			}
		}, CHAT_MISSION_POLL_MS);
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
			...(runner === undefined ? {} : { runner }),
			...agent_choice.forChat(statusSnapshot())
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

	/**
	 * Take a failed message back into the composer to change it. It joins any
	 * draft already there rather than replacing it, and is sent as a new
	 * message: the runner never saw the old one.
	 *
	 * @param id - Chat id.
	 * @param item - A pending message whose send failed.
	 */
	recall(id: string, item: PendingMessage) {
		const draft = (this.drafts[id] ?? '').trimEnd();
		this.drafts[id] = draft === '' ? item.text : `${draft}\n\n${item.text}`;
		this.pending_by_chat[id] = (this.pending_by_chat[id] ?? []).filter(
			(p) => p.message_id !== item.message_id
		);
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
		if (this.#retry_timer !== null) clearTimeout(this.#retry_timer);
		this.#retry_timer = null;
		// Resume after the newest event this browser holds; the server replays
		// the rest, and mergeEvents drops anything seen twice.
		const last = this.events.at(-1)?.id;
		const query = last === undefined ? '' : `?${new URLSearchParams({ after: last })}`;
		const source = new EventSource(`/api/mate/chats/${encodeURIComponent(id)}/events${query}`);
		this.#source?.close();
		this.#source = source;
		source.onopen = () => {
			if (this.#source !== source) return;
			if (this.#settle_timer !== null) clearTimeout(this.#settle_timer);
			this.#settle_timer = setTimeout(() => {
				this.#settle_timer = null;
				if (this.#source === source) this.#streamUp();
			}, STREAM_SETTLE_MS);
		};
		source.onmessage = (message: MessageEvent<string>) => {
			if (this.#source !== source) return;
			// An event is proof the stream works, whatever the settle timer says.
			this.#streamUp();
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
			// The stream closes right after this frame; its error reports it.
			this.#runner_message = text;
		});
		source.onerror = () => {
			if (this.#source !== source) return;
			this.#streamDown();
			if (source.readyState !== EventSource.CLOSED) return; // EventSource retries itself.
			source.close();
			const delay = streamRetryDelay(this.#retry_attempt);
			if (delay === undefined) {
				this.#giveUp();
				return;
			}
			this.#retry_attempt += 1;
			this.#retry_timer = setTimeout(() => {
				this.#retry_timer = null;
				if (this.#source === source && this.open_id === id) this.#follow(id);
			}, delay);
		};
	}

	/** What the reader is told while the stream is down and still retrying. */
	#downText(): string {
		return this.#runner_message === null
			? 'Reconnecting to the live chat…'
			: `${this.#runner_message} Retrying…`;
	}

	/** The stream dropped: say so only if it stays down past the grace period. */
	#streamDown() {
		if (this.#settle_timer !== null) clearTimeout(this.#settle_timer);
		this.#settle_timer = null;
		if (this.stream_lost) return;
		if (this.stream_error !== null) {
			this.stream_error = this.#downText();
			return;
		}
		this.#grace_timer ??= setTimeout(() => {
			this.#grace_timer = null;
			if (!this.stream_lost) this.stream_error = this.#downText();
		}, STREAM_GRACE_MS);
	}

	#streamUp() {
		if (this.#settle_timer !== null) clearTimeout(this.#settle_timer);
		if (this.#grace_timer !== null) clearTimeout(this.#grace_timer);
		this.#settle_timer = null;
		this.#grace_timer = null;
		this.#retry_attempt = 0;
		this.#runner_message = null;
		this.stream_error = null;
		this.stream_lost = false;
	}

	#giveUp() {
		if (this.#grace_timer !== null) clearTimeout(this.#grace_timer);
		this.#grace_timer = null;
		this.stream_lost = true;
		this.stream_error = this.#runner_message ?? 'Lost the live connection to this chat.';
	}

	#clearStreamTimers() {
		for (const timer of [this.#grace_timer, this.#settle_timer, this.#retry_timer]) {
			if (timer !== null) clearTimeout(timer);
		}
		this.#grace_timer = null;
		this.#settle_timer = null;
		this.#retry_timer = null;
	}

	/** Skip a backoff wait, or try again after giving up, when the network returns. */
	#reconnectNow() {
		const id = this.open_id;
		if (id === null || !this.connected) return;
		if (this.#retry_timer === null && !this.stream_lost) return;
		this.#retry_attempt = 0;
		if (this.stream_lost) this.stream_error = this.#downText();
		this.stream_lost = false;
		this.#follow(id);
	}

	#add(incoming: MateEvent[]) {
		if (incoming.some((event) => event.type === 'result' || event.type === 'error'))
			this.interrupt_requested = false;
		const before = this.events.length;
		this.events = mergeEvents(this.events, incoming);
		// Opening reads the missions itself, once, after the stored history.
		if (this.open_id !== null && !this.opening && touchesMissions(incoming)) {
			void this.loadMissions(this.open_id);
		}
		if (this.open_id !== null && !this.opening && touchesCrewCalls(incoming, this.crew_calls)) {
			void this.loadCrewCalls(this.open_id);
		}
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
