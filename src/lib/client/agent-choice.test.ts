import { describe, expect, it } from 'vitest';
import {
	agentChoiceFields,
	agentChoiceLine,
	agentChoiceOffer,
	choiceItems,
	DEFAULT_CHOICE,
	launchTakesChoice,
	offersChoice
} from './agent-choice.js';
import type { DispatchCapabilities, StatusSnapshot } from '#lib/types.js';

const caps = (models: boolean): DispatchCapabilities => ({
	live_events: true,
	follow_up: true,
	cancel: true,
	loop: models,
	terminal: false,
	models
});

function status(
	dispatch: Partial<StatusSnapshot['dispatch']> = {}
): Pick<StatusSnapshot, 'dispatch'> {
	return {
		dispatch: {
			enabled: true,
			key_configured: true,
			armed: true,
			provider: 'e2b',
			capabilities: caps(true),
			providers: [
				{ id: 'e2b', label: 'Sand', capabilities: caps(true) },
				{ id: 'webhook', label: 'forge', capabilities: caps(false) }
			],
			models: ['opus', 'sonnet'],
			efforts: ['medium', 'high'],
			...dispatch
		}
	};
}

describe('offer', () => {
	it('reads the lists from the snapshot and treats absent as empty', () => {
		expect(agentChoiceOffer(status().dispatch)).toEqual({
			models: ['opus', 'sonnet'],
			efforts: ['medium', 'high']
		});
		expect(agentChoiceOffer(undefined)).toEqual({ models: [], efforts: [] });
	});

	it('hides the picker when nothing is listed, shows it for one model', () => {
		expect(offersChoice({ models: [], efforts: [] })).toBe(false);
		// One listed model is still a choice: it or the runner default.
		expect(offersChoice({ models: ['opus'], efforts: [] })).toBe(true);
		expect(offersChoice({ models: [], efforts: ['high'] })).toBe(true);
	});

	it('lists "Runner default" first', () => {
		expect(choiceItems(['opus'])).toEqual([
			{ value: DEFAULT_CHOICE, label: 'Runner default' },
			{ value: 'opus', label: 'opus' }
		]);
	});
});

describe('launchTakesChoice', () => {
	it('follows the runner the launch goes to', () => {
		expect(launchTakesChoice(status())).toBe(true);
		expect(launchTakesChoice(status(), 'e2b')).toBe(true);
		// The server refuses a choice on a runner without the capability.
		expect(launchTakesChoice(status(), 'webhook')).toBe(false);
		expect(launchTakesChoice(status({ provider: 'webhook' }))).toBe(false);
	});

	it('is off without a snapshot or a runner', () => {
		expect(launchTakesChoice(null)).toBe(false);
		expect(launchTakesChoice(status({ provider: 'none', providers: [] }))).toBe(false);
	});
});

describe('agentChoiceFields', () => {
	const offer = { models: ['opus', 'sonnet'], efforts: ['medium', 'high'] };

	it('sends the pick when offered', () => {
		expect(agentChoiceFields({ model: 'opus', effort: 'high' }, offer)).toEqual({
			model: 'opus',
			effort: 'high'
		});
		expect(agentChoiceFields({ effort: 'medium' }, offer)).toEqual({ effort: 'medium' });
	});

	it('leaves the default out', () => {
		expect(agentChoiceFields({}, offer)).toEqual({});
	});

	it('drops a remembered pick the server no longer offers', () => {
		expect(agentChoiceFields({ model: 'haiku', effort: 'high' }, offer)).toEqual({
			effort: 'high'
		});
		expect(agentChoiceFields({ model: 'opus' }, { models: [], efforts: [] })).toEqual({});
	});
});

describe('agentChoiceLine', () => {
	it('names what was set', () => {
		expect(agentChoiceLine({ model: 'opus', effort: 'high' })).toBe('opus · high');
		expect(agentChoiceLine({ model: 'opus' })).toBe('opus');
		expect(agentChoiceLine({ effort: 'high' })).toBe('high effort');
		expect(agentChoiceLine({})).toBeUndefined();
	});
});
