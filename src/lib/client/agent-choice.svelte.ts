/**
 * The viewer's model and effort pick, shared by every launch dialog and the
 * new-chat composer so a choice made in one is the starting point in the next.
 * It is a per-viewer convenience in localStorage, like "Runs on"; the server
 * checks the value again on every launch. Only dialogs that show the picker
 * send it (see `agent-choice-select.svelte`): a launch without a visible
 * picker, such as a comment, runs on the runner's default.
 */
import { browser } from '$app/env';
import type { DispatchProviderId, StatusSnapshot } from '#lib/types.js';
import {
	agentChoiceFields,
	agentChoiceOffer,
	launchTakesChoice,
	type AgentChoice,
	type AgentChoiceOffer
} from './agent-choice.js';

const CHOICE_KEY = 'bdui:agent-choice';

class AgentChoicePick {
	model = $state<string | undefined>(undefined);
	effort = $state<string | undefined>(undefined);
	private loaded = false;

	private load() {
		if (this.loaded || !browser) return;
		this.loaded = true;
		try {
			const stored = JSON.parse(window.localStorage.getItem(CHOICE_KEY) ?? '{}') as unknown;
			if (stored !== null && typeof stored === 'object') {
				const { model, effort } = stored as Record<string, unknown>;
				if (typeof model === 'string') this.model = model;
				if (typeof effort === 'string') this.effort = effort;
			}
		} catch {
			/* storage disabled or unreadable: keep the defaults */
		}
	}

	/** The pick as it stands; a field the server no longer offers still shows here. */
	get current(): AgentChoice {
		this.load();
		return {
			...(this.model === undefined ? {} : { model: this.model }),
			...(this.effort === undefined ? {} : { effort: this.effort })
		};
	}

	/**
	 * Change one half of the pick; undefined goes back to the runner default.
	 *
	 * @param field - `model` or `effort`.
	 * @param value - An offered name, or undefined.
	 */
	choose(field: keyof AgentChoice, value: string | undefined) {
		this.load();
		this[field] = value;
		if (!browser) return;
		try {
			window.localStorage.setItem(CHOICE_KEY, JSON.stringify(this.current));
		} catch {
			/* best-effort preference */
		}
	}

	/**
	 * The `model` / `effort` fields for a request body.
	 *
	 * @param offer - What the server offers now.
	 */
	fields(offer: AgentChoiceOffer): AgentChoice {
		return agentChoiceFields(this.current, offer);
	}

	/**
	 * The fields for a mission launch: none when the runner it goes to cannot
	 * choose a model, since the server would refuse the launch.
	 *
	 * @param status - Latest health snapshot.
	 * @param picked - The viewer's "Runs on" provider, when they picked one.
	 */
	forLaunch(status: StatusSnapshot | null, picked?: DispatchProviderId): AgentChoice {
		if (!launchTakesChoice(status, picked)) return {};
		return this.fields(agentChoiceOffer(status?.dispatch));
	}

	/**
	 * The fields for a new First Mate chat. Every chat runner takes them (both
	 * share the runner core), so only the offer matters.
	 *
	 * @param status - Latest health snapshot.
	 */
	forChat(status: StatusSnapshot | null): AgentChoice {
		return this.fields(agentChoiceOffer(status?.dispatch));
	}
}

export const agent_choice = new AgentChoicePick();
