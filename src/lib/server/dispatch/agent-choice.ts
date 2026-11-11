/**
 * Which model and reasoning effort a launch may ask for.
 *
 * The operator lists the choices (`BDX_AGENT_MODELS`, `BDX_AGENT_EFFORTS`);
 * the browser can only pick one of them, because a model name reaches the
 * agent CLI's argv and decides what the launch spends. Not asking is always
 * allowed and leaves the runner's default.
 */
import { getEnv, type ServerEnv } from '../env.js';
import type { AgentChoice } from './types.js';

export interface AgentChoices {
	models: readonly string[];
	efforts: readonly string[];
}

export const MODEL_NOT_OFFERED_MESSAGE = 'That model is not one this service offers.';
export const EFFORT_NOT_OFFERED_MESSAGE = 'That effort is not one this service offers.';
export const MODELS_NOT_SUPPORTED_MESSAGE = 'That agent runner cannot choose a model or effort.';

/** The operator's choices from the server environment. */
export function configuredAgentChoices(env: ServerEnv = getEnv()): AgentChoices {
	return { models: env.agent_models, efforts: env.agent_efforts };
}

/** True when the launch asks for a model or an effort rather than the default. */
export function asksForAgentChoice(choice: AgentChoice): boolean {
	return choice.model !== undefined || choice.effort !== undefined;
}

/** Why the launch's model or effort is refused, or undefined when it is offered. */
export function agentChoiceProblem(choice: AgentChoice, choices: AgentChoices): string | undefined {
	if (choice.model !== undefined && !choices.models.includes(choice.model)) {
		return MODEL_NOT_OFFERED_MESSAGE;
	}
	if (choice.effort !== undefined && !choices.efforts.includes(choice.effort)) {
		return EFFORT_NOT_OFFERED_MESSAGE;
	}
	return undefined;
}
