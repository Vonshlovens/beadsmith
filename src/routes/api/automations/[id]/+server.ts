/** One automation: its schedule, next fire times and run history; pause, resume, delete. */
import type { RequestHandler } from './$types';
import { AUTOMATION_HISTORY_LIMIT, AUTOMATION_PREVIEW_COUNT } from '#lib/automations.js';
import { missionProjectNames } from '#lib/server/mission-names.js';
import {
	automationRunView,
	automationUpcoming,
	automationView
} from '#lib/server/automations/service.js';
import { getAutomationStore } from '#lib/server/state/db.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';
import {
	automation_id_schema,
	automation_patch_schema,
	parseJsonBody,
	parseValue
} from '#lib/server/validation.js';

export const GET: RequestHandler = async ({ params }) => {
	const id = parseValue(automation_id_schema, params.id);
	if (!id.ok) return id.response;
	try {
		const store = await getAutomationStore();
		const automation = await store.get(id.data);
		if (automation === undefined) return errorResponse('not_found', 'automation not found');
		const runs = await store.listRuns(automation.id, AUTOMATION_HISTORY_LIMIT);
		const names = await missionProjectNames();
		const now = new Date();
		return jsonResponse({
			automation: automationView(automation, {
				project_name: names.get(automation.project_id),
				...(runs[0] === undefined ? {} : { last_run: runs[0] }),
				now
			}),
			upcoming: automationUpcoming(automation, now, AUTOMATION_PREVIEW_COUNT),
			runs: runs.map(automationRunView)
		});
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

/** Pause or resume. Resuming never fires the slots missed while paused. */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const id = parseValue(automation_id_schema, params.id);
	if (!id.ok) return id.response;
	const body = await parseJsonBody(request, automation_patch_schema);
	if (!body.ok) return body.response;
	try {
		const store = await getAutomationStore();
		const automation = await store.setEnabled(id.data, body.data.enabled);
		if (automation === undefined) return errorResponse('not_found', 'automation not found');
		const [last_run] = await store.listRuns(automation.id, 1);
		const names = await missionProjectNames();
		return jsonResponse({
			automation: automationView(automation, {
				project_name: names.get(automation.project_id),
				...(last_run === undefined ? {} : { last_run }),
				now: new Date()
			})
		});
	} catch (error) {
		return errorFromException(error);
	}
};

/** Delete it and its history; the missions it launched stay. */
export const DELETE: RequestHandler = async ({ params }) => {
	const id = parseValue(automation_id_schema, params.id);
	if (!id.ok) return id.response;
	try {
		const removed = await (await getAutomationStore()).remove(id.data);
		if (!removed) return errorResponse('not_found', 'automation not found');
		return new Response(null, { status: 204 });
	} catch (error) {
		return errorFromException(error);
	}
};
