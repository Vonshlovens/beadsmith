/**
 * The model and reasoning effort a launch or a new First Mate chat asks for.
 *
 * The operator lists the choices (`BDX_AGENT_MODELS`, `BDX_AGENT_EFFORTS`,
 * shown as `dispatch.models` / `dispatch.efforts` in the status snapshot) and
 * the server refuses anything else, because a model name reaches the agent
 * CLI and decides what a run spends. Not asking is always allowed and means
 * the runner's default, so each list is offered with "Runner default" first:
 * one configured model is already a choice (it or the default), none is not.
 *
 * Pure functions, so the dialogs share one reading and tests cover every state
 * without a DOM. The viewer's pick lives in `agent-choice.svelte.ts`.
 */
import { launchRunner } from '#lib/client/loop.js';
import type { DispatchProviderId, StatusSnapshot } from '#lib/types.js';

/** What the server offers; empty lists mean "not offered". */
export interface AgentChoiceOffer {
	models: readonly string[];
	efforts: readonly string[];
}

/** A viewer's pick; an absent field means the runner's default. */
export interface AgentChoice {
	model?: string;
	effort?: string;
}

/**
 * The select value for "Runner default". Neither a model nor an effort can
 * start with `-` (the server's patterns, `agent-session/claude-code.ts`), so
 * it never collides with an offered name.
 */
export const DEFAULT_CHOICE = '-';

/** The offer in a status snapshot; nothing when dispatch is unknown. */
export function agentChoiceOffer(
	dispatch: Pick<StatusSnapshot['dispatch'], 'models' | 'efforts'> | undefined
): AgentChoiceOffer {
	return { models: dispatch?.models ?? [], efforts: dispatch?.efforts ?? [] };
}

/** Whether there is anything to pick: at least one model or effort listed. */
export function offersChoice(offer: AgentChoiceOffer): boolean {
	return offer.models.length > 0 || offer.efforts.length > 0;
}

/**
 * Whether a mission launch may ask for a model: the runner it goes to (the
 * viewer's "Runs on" pick, else the server default) has the `models`
 * capability. The server refuses a choice on any other runner (`403`), so the
 * picker is hidden rather than offered and refused.
 *
 * @param status - Latest health snapshot.
 * @param picked - The viewer's "Runs on" provider, when they picked one.
 */
export function launchTakesChoice(
	status: Pick<StatusSnapshot, 'dispatch'> | null,
	picked?: DispatchProviderId
): boolean {
	if (status === null) return false;
	return launchRunner(status.dispatch, picked)?.capabilities.models === true;
}

/** Select items for one list, "Runner default" first. */
export function choiceItems(list: readonly string[]): { value: string; label: string }[] {
	return [
		{ value: DEFAULT_CHOICE, label: 'Runner default' },
		...list.map((name) => ({ value: name, label: name }))
	];
}

/**
 * The `model` / `effort` fields for a request body: only picks the server
 * still offers, so a remembered pick the operator has since withdrawn falls
 * back to the default instead of being refused. Absent fields are left out.
 */
export function agentChoiceFields(pick: AgentChoice, offer: AgentChoiceOffer): AgentChoice {
	const out: AgentChoice = {};
	if (pick.model !== undefined && offer.models.includes(pick.model)) out.model = pick.model;
	if (pick.effort !== undefined && offer.efforts.includes(pick.effort)) out.effort = pick.effort;
	return out;
}

/** `opus · high`, `opus`, `high effort`; undefined when both are the default. */
export function agentChoiceLine(choice: AgentChoice): string | undefined {
	if (choice.model !== undefined && choice.effort !== undefined) {
		return `${choice.model} · ${choice.effort}`;
	}
	if (choice.model !== undefined) return choice.model;
	if (choice.effort !== undefined) return `${choice.effort} effort`;
	return undefined;
}
