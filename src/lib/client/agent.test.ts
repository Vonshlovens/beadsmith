import { describe, expect, it } from 'vitest';
import {
	agentAvailability,
	composerState,
	formatElapsed,
	intentAllowed,
	isFollowedMission,
	isSafeRunUrl,
	missionVerb
} from './agent.js';
import type { DispatchHealth } from '$lib/types.js';

function health(patch: Partial<DispatchHealth> = {}): { dispatch: DispatchHealth } {
	return {
		dispatch: {
			enabled: true,
			key_configured: true,
			armed: true,
			provider: 'webhook',
			capabilities: { live_events: false, follow_up: true, cancel: true },
			...patch
		}
	};
}

describe('agentAvailability', () => {
	it('hides agent controls entirely when no provider is configured', () => {
		expect(agentAvailability(null)).toEqual({ visible: false, enabled: false });
		expect(
			agentAvailability(health({ key_configured: false, enabled: false, provider: 'none' }))
		).toEqual({ visible: false, enabled: false });
	});

	it('hides agent controls for a viewer who may not launch (a member)', () => {
		expect(agentAvailability(health({ viewer_can_launch: false, enabled: false }))).toEqual({
			visible: false,
			enabled: false
		});
		expect(agentAvailability(health({ viewer_can_launch: true })).visible).toBe(true);
	});

	it('shows them disabled with a reason when disarmed or denied', () => {
		expect(agentAvailability(health({ armed: false, enabled: false }))).toMatchObject({
			visible: true,
			enabled: false,
			reason: expect.stringContaining('disarmed')
		});
		expect(agentAvailability(health(), { file: false, tackle: false })).toMatchObject({
			visible: true,
			enabled: false
		});
		expect(agentAvailability(health(), { file: true, tackle: false })).toEqual({
			visible: true,
			enabled: true
		});
	});
});

describe('intentAllowed', () => {
	it('mirrors the server policy', () => {
		const file_only = { file: true, tackle: false };
		expect(intentAllowed('discuss', file_only)).toBe(true);
		expect(intentAllowed('elaborate', file_only)).toBe(false);
		expect(intentAllowed('close', file_only)).toBe(false);
		expect(intentAllowed('tackle', file_only)).toBe(false);
		expect(intentAllowed('tackle')).toBe(true);
	});
});

describe('isFollowedMission', () => {
	it('drops a launched mission whose provider is no longer configured', () => {
		const dispatch = health().dispatch;
		expect(isFollowedMission({ agent_id: 'ag-1', provider: 'webhook' }, dispatch)).toBe(true);
		expect(isFollowedMission({ agent_id: 'ag-1', provider: undefined }, dispatch)).toBe(false);
		expect(
			isFollowedMission(
				{ agent_id: 'ag-1', provider: 'webhook' },
				health({ provider: 'none' }).dispatch
			)
		).toBe(false);
	});

	it('still follows missions that have not launched, and when status is unknown', () => {
		expect(isFollowedMission({ agent_id: undefined, provider: undefined }, health().dispatch)).toBe(
			true
		);
		expect(isFollowedMission({ agent_id: 'ag-1', provider: undefined }, null)).toBe(true);
	});
});

describe('composerState', () => {
	const done = {
		status: 'succeeded' as const,
		agent_id: 'ag-1',
		provider: 'webhook' as const
	};

	it('lets the operator reply to a finished run on a runner that takes follow-ups', () => {
		expect(composerState(done, health().dispatch)).toEqual({ can_send: true });
	});

	it('says why the composer is disabled, most actionable reason first', () => {
		expect(composerState({ ...done, status: 'running' }, health().dispatch).reason).toContain(
			'working'
		);
		expect(
			composerState({ ...done, agent_id: undefined, status: 'failed' }, health().dispatch).reason
		).toBe('This run never started.');
		expect(composerState({ ...done, provider: undefined }, health().dispatch).reason).toContain(
			'no longer configured'
		);
		expect(
			composerState({ ...done, provider: undefined, status: 'running' }, health().dispatch).reason
		).toContain('no longer configured');
		expect(
			composerState(
				done,
				health({ capabilities: { live_events: false, follow_up: false, cancel: false } }).dispatch
			).reason
		).toContain('follow-up');
		expect(composerState(done, health({ armed: false }).dispatch).reason).toContain('disarmed');
		expect(composerState(done, null).can_send).toBe(false);
	});
});

describe('missionVerb and isSafeRunUrl', () => {
	it('names missions without provider wording', () => {
		expect(missionVerb({ operation: 'discuss', intent: 'elaborate' })).toBe('Elaborate');
		expect(missionVerb({ operation: 'discuss' })).toBe('Discuss');
		expect(missionVerb({ operation: 'tackle' })).toBe('Tackle');
	});

	it('only links https run pages without credentials', () => {
		expect(isSafeRunUrl('https://runner.example.com/runs/1')).toBe(true);
		expect(isSafeRunUrl('https://runner.example.com/agents/bc-1')).toBe(true);
		expect(isSafeRunUrl('http://runner.example.com/runs/1')).toBe(false);
		expect(isSafeRunUrl('https://user:pw@runner.example.com/')).toBe(false);
		expect(isSafeRunUrl('javascript:alert(1)')).toBe(false);
		expect(isSafeRunUrl(undefined)).toBe(false);
	});
});

describe('formatElapsed', () => {
	it('stays short at every scale', () => {
		expect(formatElapsed(0)).toBe('0s');
		expect(formatElapsed(42_400)).toBe('42s');
		expect(formatElapsed(187_000)).toBe('3:07');
		expect(formatElapsed(3_900_000)).toBe('1h 05m');
		expect(formatElapsed(-5)).toBe('0s');
	});
});
