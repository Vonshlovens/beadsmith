/**
 * Where new agent work runs, picked once in First Mate ("Runs on"): on the
 * operator's own runner (the HTTP mate runner and the webhook dispatch runner,
 * for example the forge host) or on Sand (E2B sandboxes). The choice applies to
 * new First Mate chats and to every new agent launch (File, Tackle, board drop,
 * comment, discuss). Chats and missions keep where they started.
 *
 * The browser only chooses among what the server lists (`dispatch.providers`
 * in the status snapshot, `runners` in the First Mate status), and the server
 * checks again (ADR-0018). The pick is a per-viewer convenience in
 * localStorage; without one, each side uses its server default.
 */
import { browser } from '$app/env';
import { setLaunchFieldSource } from '#lib/client/api.js';
import type { MateRunnerId, MateRunnerInfo } from '#lib/mate.js';
import type { DispatchProviderId, DispatchProviderInfo } from '#lib/types.js';

const RUNNER_KEY = 'bdui:runs-on';

/** `own`: the operator's runners; `sand`: E2B. */
export type RunPlace = 'own' | 'sand';

export interface RunPlaceOption {
	place: RunPlace;
	label: string;
}

const DISPATCH_FOR: Record<RunPlace, DispatchProviderId> = { own: 'webhook', sand: 'e2b' };
const CHAT_FOR: Record<RunPlace, MateRunnerId> = { own: 'remote', sand: 'e2b' };

function placeOfProvider(id: DispatchProviderId): RunPlace {
	return id === 'e2b' ? 'sand' : 'own';
}

function placeOfRunner(id: MateRunnerId): RunPlace {
	return id === 'e2b' ? 'sand' : 'own';
}

class RunPlaceChoice {
	/** The viewer's pick; null means each side's server default. */
	chosen = $state<RunPlace | null>(null);
	/** Dispatch providers the server last listed, default first. */
	providers = $state<DispatchProviderInfo[]>([]);
	/** First Mate chat runners the server last listed, default first. */
	runners = $state<MateRunnerInfo[]>([]);
	private loaded = false;

	private load() {
		if (this.loaded || !browser) return;
		this.loaded = true;
		try {
			const stored = window.localStorage.getItem(RUNNER_KEY);
			if (stored === 'own' || stored === 'sand') this.chosen = stored;
		} catch {
			/* storage disabled: keep the defaults */
		}
	}

	/** Every place either side offers, chats' default first. */
	get options(): RunPlaceOption[] {
		const out: RunPlaceOption[] = [];
		const add = (place: RunPlace, label: string) => {
			if (!out.some((option) => option.place === place)) out.push({ place, label });
		};
		for (const runner of this.runners) add(placeOfRunner(runner.id), runner.label);
		for (const provider of this.providers) add(placeOfProvider(provider.id), provider.label);
		return out;
	}

	/** Where new work goes: the viewer's pick when offered, else the default. */
	get current(): RunPlaceOption | undefined {
		this.load();
		const options = this.options;
		return options.find((option) => option.place === this.chosen) ?? options[0];
	}

	/**
	 * Adopt the dispatch providers from a status snapshot.
	 *
	 * @param providers - `dispatch.providers` from the latest snapshot.
	 */
	syncProviders(providers: DispatchProviderInfo[] | undefined) {
		this.load();
		this.providers = providers ?? [];
	}

	/**
	 * Adopt the chat runners from the First Mate status.
	 *
	 * @param runners - `runners` from `GET /api/mate/status`.
	 */
	syncRunners(runners: MateRunnerInfo[] | undefined) {
		this.load();
		this.runners = runners ?? [];
	}

	/**
	 * Pick where new work runs.
	 *
	 * @param place - One of {@link options}.
	 */
	choose(place: RunPlace) {
		this.load();
		this.chosen = place;
		if (!browser) return;
		try {
			window.localStorage.setItem(RUNNER_KEY, place);
		} catch {
			/* best-effort preference */
		}
	}

	/** The `provider` field for a launch body, when the pick names a listed one. */
	launchField(): { provider?: DispatchProviderId } {
		this.load();
		if (this.chosen === null) return {};
		const id = DISPATCH_FOR[this.chosen];
		return this.providers.some((entry) => entry.id === id) ? { provider: id } : {};
	}

	/** The `runner` for a new chat, when the pick names a listed one. */
	chatRunner(): MateRunnerId | undefined {
		this.load();
		if (this.chosen === null) return undefined;
		const id = CHAT_FOR[this.chosen];
		return this.runners.some((entry) => entry.id === id) ? id : undefined;
	}
}

export const run_place = new RunPlaceChoice();
setLaunchFieldSource(() => run_place.launchField());
