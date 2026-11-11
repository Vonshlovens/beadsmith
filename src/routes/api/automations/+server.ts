/**
 * Automations (ADR-0019 rule 7): list them, and create one for the signed-in
 * admin. Creating needs `dispatch:launch` (auth/roles.ts), like a launch.
 */
import type { RequestHandler } from './$types';
import { getProjectIssue } from '#lib/server/read-model.js';
import { resolveProject } from '#lib/server/discovery.js';
import { missionProjectNames } from '#lib/server/mission-names.js';
import { automationView, createAutomation } from '#lib/server/automations/service.js';
import { getAutomationStore } from '#lib/server/state/db.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';
import {
	automation_create_schema,
	automations_query_schema,
	parseJsonBody,
	parseQuery
} from '#lib/server/validation.js';

export const GET: RequestHandler = async ({ url }) => {
	const query = parseQuery(url.searchParams, automations_query_schema);
	if (!query.ok) return query.response;
	try {
		const store = await getAutomationStore();
		const names = await missionProjectNames();
		const now = new Date();
		const automations = await store.list(
			query.data.project === undefined ? {} : { project_id: query.data.project }
		);
		return jsonResponse({
			automations: await Promise.all(
				automations.map(async (automation) => {
					const [last_run] = await store.listRuns(automation.id, 1);
					return automationView(automation, {
						project_name: names.get(automation.project_id),
						...(last_run === undefined ? {} : { last_run }),
						now
					});
				})
			)
		});
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	const body = await parseJsonBody(request, automation_create_schema);
	if (!body.ok) return body.response;
	// The scheduler re-reads the creator's account at every fire, so an
	// automation needs one; an Access service token has none.
	const user = locals.user;
	if (user === undefined) {
		return errorResponse('forbidden', 'Automations need a signed-in admin account.');
	}
	try {
		const result = await createAutomation(
			body.data,
			{ id: user.id, email: user.email },
			{
				store: await getAutomationStore(),
				resolveProject,
				getIssue: async (project, issue_id) => (await getProjectIssue(project, issue_id))?.issue,
				now: () => new Date()
			}
		);
		if (!result.ok) return errorResponse(result.code, result.message);
		return jsonResponse(
			{
				automation: automationView(result.automation, {
					project_name: result.project.name,
					now: new Date()
				})
			},
			201
		);
	} catch (error) {
		return errorFromException(error);
	}
};
