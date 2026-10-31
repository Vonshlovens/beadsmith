import { describe, expect, it } from 'vitest';
import { buildDispatchAgentName, buildDispatchPrompt } from './prompts.js';
import type { DispatchRecord } from './types.js';

const fileRecord: DispatchRecord = {
	id: 'dq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	idempotency_key: 'idem-file',
	project_id: 'd_beads_web',
	dolt_database: 'beads_web',
	operation: 'file',
	actor: 'web',
	payload: {
		operation: 'file',
		notes: 'Users cannot sign in with Google.',
		title: 'Fix Google login'
	},
	status: 'queued',
	created_at: '2026-08-16T00:00:00.000Z',
	updated_at: '2026-08-16T00:00:00.000Z'
};

const tackleRecord: DispatchRecord = {
	id: 'dq_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
	idempotency_key: 'idem-tackle',
	project_id: 'd_beads_web',
	dolt_database: 'beads_web',
	operation: 'tackle',
	actor: 'web',
	payload: {
		operation: 'tackle',
		issue_id: 'beads-web-12',
		title: 'Fix Google login',
		description: 'Access login fails on the public host.'
	},
	status: 'queued',
	created_at: '2026-08-16T00:00:00.000Z',
	updated_at: '2026-08-16T00:00:00.000Z'
};

const commentRecord: DispatchRecord = {
	id: 'dq_cccccccccccccccccccccccccccccccc',
	idempotency_key: 'idem-comment',
	project_id: 'd_beads_web',
	dolt_database: 'beads_web',
	operation: 'comment',
	actor: 'owner@example.com',
	payload: {
		operation: 'comment',
		issue_id: 'beads-web-12',
		text: 'Please keep the composer.',
		author: 'owner@example.com',
		title: 'Let humans add comments'
	},
	status: 'queued',
	created_at: '2026-08-16T00:00:00.000Z',
	updated_at: '2026-08-16T00:00:00.000Z'
};

describe('buildDispatchPrompt', () => {
	it('tells a file agent to create beads and not implement', () => {
		const prompt = buildDispatchPrompt(fileRecord);

		expect(prompt).toContain('/file');
		expect(prompt).toContain('Users cannot sign in with Google.');
		expect(prompt).toContain('.agents/skills/file/SKILL.md');
		expect(prompt).toContain('bd create');
		expect(prompt).toContain('Do not implement code');
		expect(prompt).toContain('beads_web');
		expect(prompt).not.toContain('Target status after create');
		expect(prompt).not.toContain('bd update <id> --status=');
	});

	it('tells a file agent to set a non-open status after create', () => {
		const prompt = buildDispatchPrompt({
			...fileRecord,
			payload: {
				...fileRecord.payload,
				operation: 'file',
				notes: 'Keep this moving.',
				status: 'in_progress'
			}
		});

		expect(prompt).toContain('Target status after create: in_progress');
		expect(prompt).toContain('bd update <id> --status=in_progress');
		expect(prompt).toContain('report the new issue id and that it remains open');
	});

	it('tells a tackle agent to claim and implement the named issue', () => {
		const prompt = buildDispatchPrompt(tackleRecord);

		expect(prompt).toContain('/tackle');
		expect(prompt).toContain('.agents/skills/tackle/SKILL.md');
		expect(prompt).toContain('beads-web-12');
		expect(prompt).toContain('bd update beads-web-12 --claim');
		expect(prompt).toContain('Access login fails on the public host.');
	});

	it('asks a closed-destination agent to check whether work is finished', () => {
		const prompt = buildDispatchPrompt({
			...tackleRecord,
			payload: {
				operation: 'tackle',
				issue_id: 'beads-web-12',
				title: 'Fix Google login',
				description: 'Access login fails on the public host.',
				destination_status: 'closed'
			}
		});

		expect(prompt).toContain('actually finished');
		expect(prompt).toContain('bd close beads-web-12');
		expect(prompt).not.toContain('bd update beads-web-12 --claim');
	});

	it('tells a comment agent to add the verbatim body and nothing else', () => {
		const prompt = buildDispatchPrompt(commentRecord);

		expect(prompt).toContain('/comment');
		expect(prompt).toContain('.agents/skills/comment/SKILL.md');
		expect(prompt).toContain('beads-web-12');
		expect(prompt).toContain('Please keep the composer.');
		expect(prompt).toContain('bd comments add beads-web-12');
		expect(prompt).toContain('Do not claim, close, edit, implement');
		expect(prompt).not.toContain('bd create');
	});
});

describe('buildDispatchAgentName', () => {
	it('stays within a 100-character agent name', () => {
		expect(buildDispatchAgentName(fileRecord).length).toBeLessThanOrEqual(100);
		expect(buildDispatchAgentName(tackleRecord)).toBe('Tackle beads-web-12');
		expect(
			buildDispatchAgentName({
				...tackleRecord,
				payload: {
					operation: 'tackle',
					issue_id: 'beads-web-12',
					destination_status: 'deferred'
				}
			})
		).toBe('Defer beads-web-12');
		expect(buildDispatchAgentName(commentRecord)).toBe('Comment on beads-web-12');
	});
});

function discussRecord(
	intent: 'discuss' | 'elaborate' | 'close',
	message?: string
): DispatchRecord {
	return {
		id: 'dq_dddddddddddddddddddddddddddddddd',
		idempotency_key: 'idem-discuss',
		project_id: 'd_beads_web',
		dolt_database: 'beads_web',
		operation: 'discuss',
		actor: 'owner@example.com',
		payload: {
			operation: 'discuss',
			issue_id: 'beads-web-12',
			intent,
			title: 'Fix Google login',
			description: 'Access login fails on the public host.',
			...(message === undefined ? {} : { message })
		},
		status: 'queued',
		created_at: '2026-10-17T00:00:00.000Z',
		updated_at: '2026-10-17T00:00:00.000Z'
	};
}

describe('discuss prompts', () => {
	it('talks the issue through without changing it', () => {
		const prompt = buildDispatchPrompt(discussRecord('discuss', 'Is this still needed?'));
		expect(prompt).toContain('.agents/skills/discuss/SKILL.md');
		expect(prompt).toContain('bd show beads-web-12');
		expect(prompt).toContain('Dolt database `beads_web`');
		expect(prompt).toContain('Do not claim, close, edit, or implement');
		expect(prompt).toContain(
			'<<<beads-web-discuss-dq_dddddddddddddddddddddddddddddddd>>>\nIs this still needed?\n<<<end-'
		);
		expect(prompt).toContain('Intent: discuss');
		expect(prompt).toContain('shown to the operator in Beadsmith');
	});

	it('elaborates with bd update and leaves status alone', () => {
		const prompt = buildDispatchPrompt(discussRecord('elaborate'));
		expect(prompt).toContain('bd update beads-web-12 --description=');
		expect(prompt).toContain('bd update beads-web-12 --acceptance=');
		expect(prompt).toContain('Do not change status');
		expect(prompt).not.toContain('<<<beads-web-discuss-');
	});

	it('closes with a reason taken from the operator', () => {
		const prompt = buildDispatchPrompt(discussRecord('close', 'Shipped in eec9e6a.'));
		expect(prompt).toContain('bd close beads-web-12 --reason=');
		expect(prompt).toContain('Use the operator message as the reason');
		expect(prompt).toContain('Shipped in eec9e6a.');
	});

	it('names the agent by intent', () => {
		expect(buildDispatchAgentName(discussRecord('discuss'))).toBe('Discuss beads-web-12');
		expect(buildDispatchAgentName(discussRecord('elaborate'))).toBe('Elaborate beads-web-12');
		expect(buildDispatchAgentName(discussRecord('close'))).toBe('Close beads-web-12');
	});
});
