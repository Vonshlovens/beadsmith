<script lang="ts">
	/**
	 * Subscribe to the beads-web SSE proxy and render MissionEvent frames.
	 * EventSource is same-origin; provider credentials never enter the browser.
	 *
	 * Recovery follows the First Mate chat's stream (mate-chat.svelte.ts): a
	 * drop is only reported once it has lasted the grace period, EventSource
	 * retries first (sending the last event id, which the proxy resumes
	 * after), then Beadsmith reconnects with backoff, at once when the
	 * browser comes back online, and asks for a manual Reconnect only when
	 * the retries run out. A reconnect of our own cannot send that header, so
	 * the proxy replays the run and frames already held are skipped by id.
	 *
	 * The proxy ends every stream with `done`. That is the end of the run
	 * only when a result or the proxy's own stored answer came first;
	 * otherwise the runner's side dropped mid-run and it is reconnected.
	 */
	import { untrack } from 'svelte';
	import MissionEventStream from '#lib/components/mission-event-stream.svelte';
	import { STREAM_GRACE_MS, STREAM_SETTLE_MS, streamRetryDelay } from '#lib/client/mate-chat.js';
	import {
		MISSION_EVENT_TYPES,
		missionStreamEnded,
		missionStreamPath,
		parseMissionEventJson,
		type MissionEvent
	} from '#lib/mission-events.js';

	interface Props {
		project_id: string;
		request_id: string;
	}

	let { project_id, request_id }: Props = $props();

	let events = $state<MissionEvent[]>([]);
	let pending = $state(true);
	let reconnecting = $state(false);
	let error = $state<string | null>(null);
	/** Bumped by Reconnect, to start over with fresh retries. */
	let attempt = $state(0);

	$effect(() => {
		void attempt;
		const url = missionStreamPath(project_id, request_id);
		pending = true;
		reconnecting = false;
		error = null;
		const seen = new Set(untrack(() => events.map((event) => event.id)));
		let source: EventSource | null = null;
		let retries = 0;
		let ended = false;
		let grace: ReturnType<typeof setTimeout> | null = null;
		let settle: ReturnType<typeof setTimeout> | null = null;
		let retry: ReturnType<typeof setTimeout> | null = null;

		const clear = (timer: ReturnType<typeof setTimeout> | null) => {
			if (timer !== null) clearTimeout(timer);
			return null;
		};

		const up = () => {
			grace = clear(grace);
			settle = clear(settle);
			retries = 0;
			reconnecting = false;
			error = null;
		};

		const down = () => {
			settle = clear(settle);
			grace ??= setTimeout(() => {
				grace = null;
				if (!ended && error === null) reconnecting = true;
			}, STREAM_GRACE_MS);
		};

		const giveUp = () => {
			grace = clear(grace);
			pending = false;
			reconnecting = false;
			error = 'Lost the live output. The thread still refreshes on its own.';
		};

		const scheduleRetry = () => {
			const delay = streamRetryDelay(retries);
			if (delay === undefined) {
				giveUp();
				return;
			}
			retries += 1;
			retry = setTimeout(() => {
				retry = null;
				follow();
			}, delay);
		};

		const follow = () => {
			retry = clear(retry);
			source?.close();
			let got_result = false;
			let got_answer = false;
			const current = new EventSource(url);
			source = current;

			const on_frame = (type: string) => (message: Event) => {
				if (source !== current) return;
				const parsed = parseMissionEventJson((message as MessageEvent<string>).data);
				if (parsed === undefined || parsed.type !== type) return;
				// The proxy could not reach the run just now. Not output and not an
				// end: the `done` that follows reconnects, and a lasting failure
				// surfaces through the retry budget instead of this line.
				if (parsed.type === 'error' && parsed.id === 'stream-unavailable') return;
				// An event is proof the stream works, whatever the settle timer says.
				up();
				if (parsed.type === 'result') got_result = true;
				// The proxy's own answers (not launched, expired) carry this id.
				if (parsed.type === 'error' && parsed.id === 'stored-error') got_answer = true;
				if (seen.has(parsed.id)) return;
				seen.add(parsed.id);
				events.push(parsed);
			};
			for (const type of MISSION_EVENT_TYPES) {
				current.addEventListener(type, on_frame(type));
			}
			current.addEventListener('done', () => {
				if (source !== current) return;
				current.close();
				if (missionStreamEnded({ got_result, got_answer })) {
					ended = true;
					up();
					pending = false;
					return;
				}
				down();
				scheduleRetry();
			});
			current.onopen = () => {
				if (source !== current) return;
				settle = clear(settle);
				// A stream that opens and drops at once has not recovered.
				settle = setTimeout(() => {
					settle = null;
					if (source === current) up();
				}, STREAM_SETTLE_MS);
			};
			current.onerror = () => {
				if (source !== current || ended) return;
				down();
				if (current.readyState !== EventSource.CLOSED) return; // EventSource retries itself.
				current.close();
				scheduleRetry();
			};
		};

		const online = () => {
			if (ended || (retry === null && error === null)) return;
			retries = 0;
			error = null;
			pending = true;
			follow();
		};

		follow();
		window.addEventListener('online', online);
		return () => {
			window.removeEventListener('online', online);
			source?.close();
			for (const timer of [grace, settle, retry]) clear(timer);
		};
	});

	// A different mission starts from nothing; Reconnect keeps what it holds.
	$effect.pre(() => {
		void project_id;
		void request_id;
		events = [];
	});
</script>

<MissionEventStream {events} {pending} {error} {reconnecting} onreconnect={() => (attempt += 1)} />
