<script lang="ts">
	/**
	 * Subscribe to the beads-web SSE proxy and render MissionEvent frames.
	 * EventSource is same-origin; provider credentials never enter the browser.
	 */
	import MissionEventStream from '$lib/components/mission-event-stream.svelte';
	import {
		MISSION_EVENT_TYPES,
		missionStreamPath,
		parseMissionEventJson,
		type MissionEvent
	} from '$lib/mission-events';

	interface Props {
		project_id: string;
		request_id: string;
	}

	let { project_id, request_id }: Props = $props();

	let events = $state<MissionEvent[]>([]);
	let pending = $state(true);
	let error = $state<string | null>(null);

	$effect(() => {
		const url = missionStreamPath(project_id, request_id);
		events = [];
		pending = true;
		error = null;
		let finished = false;
		const source = new EventSource(url);

		const on_frame = (type: string) => (message: Event) => {
			const data = (message as MessageEvent<string>).data;
			const parsed = parseMissionEventJson(data);
			if (parsed === undefined || parsed.type !== type) {
				return;
			}
			events = [...events, parsed];
		};

		for (const type of MISSION_EVENT_TYPES) {
			source.addEventListener(type, on_frame(type));
		}
		source.addEventListener('done', () => {
			finished = true;
			pending = false;
			source.close();
		});
		source.onerror = () => {
			if (finished) {
				return;
			}
			pending = false;
			if (source.readyState === EventSource.CLOSED) {
				error = error ?? 'The mission stream closed unexpectedly.';
			}
		};

		return () => {
			source.close();
		};
	});
</script>

<MissionEventStream {events} {pending} {error} />
