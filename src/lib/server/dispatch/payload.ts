/**
 * The payload a launch stores on its mission, from its validated fields. One
 * function for a person's launch and an automation's template (ADR-0019
 * rule 7), so a scheduled launch carries exactly what the same launch by
 * hand would.
 */
import type { LaunchBody } from '../validation.js';
import type { AgentChoice, DispatchPayload } from './types.js';

/**
 * @param body - The launch fields, already validated (no idempotency key or runner).
 * @param actor - Who the comment is written as; a comment's author is its launcher.
 */
export function launchPayload(body: LaunchBody, actor: string): DispatchPayload {
	return { ...operationPayload(body, actor), ...agentChoice(body) };
}

/** The model and effort a launch asked for, leaving out the ones it did not. */
function agentChoice(body: LaunchBody): AgentChoice {
	return {
		...(body.model === undefined ? {} : { model: body.model }),
		...(body.effort === undefined ? {} : { effort: body.effort })
	};
}

function operationPayload(body: LaunchBody, actor: string): DispatchPayload {
	switch (body.operation) {
		case 'file':
			return {
				operation: 'file',
				notes: body.notes,
				...(body.title === undefined ? {} : { title: body.title }),
				...(body.issue_type === undefined ? {} : { issue_type: body.issue_type }),
				...(body.priority === undefined ? {} : { priority: body.priority }),
				...(body.labels === undefined ? {} : { labels: body.labels }),
				// Open is bd's default, so only another status is recorded.
				...(body.status !== undefined && body.status !== 'open' ? { status: body.status } : {})
			};
		case 'tackle':
			return {
				operation: 'tackle',
				issue_id: body.issue_id,
				...(body.destination_status === undefined
					? {}
					: { destination_status: body.destination_status })
			};
		case 'comment':
			return { operation: 'comment', issue_id: body.issue_id, text: body.text, author: actor };
		case 'discuss':
			return {
				operation: 'discuss',
				issue_id: body.issue_id,
				intent: body.intent,
				...(body.message === undefined ? {} : { message: body.message })
			};
		case 'loop': {
			const { operation, issue_id, model: _model, effort: _effort, ...settings } = body;
			const flags = Object.fromEntries(
				Object.entries(settings).filter(([, value]) => value !== undefined)
			) as typeof settings;
			return { operation, ...flags, ...(issue_id === undefined ? {} : { issue_id }) };
		}
	}
}

/** The bead a payload acts on, when it names one. */
export function payloadIssueId(payload: DispatchPayload): string | undefined {
	return 'issue_id' in payload ? payload.issue_id : undefined;
}
