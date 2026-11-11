/**
 * Run now: fire the automation once at this instant, through the same path
 * as a scheduled slot (creator check, dispatch policy, idempotency key), but
 * without waiting for or skipping behind a running mission and without
 * moving the schedule's cursor (ADR-0019 rule 7). A paused automation runs
 * too: pausing stops the schedule, not a person's explicit press.
 */
import type { RequestHandler } from './$types';
import { automationDeps } from '#lib/server/automations/runtime.js';
import { fireAutomationSlot } from '#lib/server/automations/scheduler.js';
import { automationRunView } from '#lib/server/automations/service.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';
import { automation_id_schema, parseValue } from '#lib/server/validation.js';

export const POST: RequestHandler = async ({ params }) => {
	const id = parseValue(automation_id_schema, params.id);
	if (!id.ok) return id.response;
	try {
		const deps = await automationDeps();
		const automation = await deps.store.get(id.data);
		if (automation === undefined) return errorResponse('not_found', 'automation not found');
		const run = await fireAutomationSlot(automation, deps.now().toISOString(), 'manual', deps);
		if (run === undefined) return errorResponse('conflict', 'That run was already started.');
		return jsonResponse({ run: automationRunView(run) }, 201);
	} catch (error) {
		return errorFromException(error);
	}
};
