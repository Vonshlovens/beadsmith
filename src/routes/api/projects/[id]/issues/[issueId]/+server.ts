import type { RequestHandler } from './$types';
import { resolveProject } from '$lib/server/discovery.js';
import { getProjectIssue } from '$lib/server/read-model.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import { issue_id_schema, parseValue, project_id_schema } from '$lib/server/validation.js';

export const GET: RequestHandler = async ({ params }) => {
	const id = parseValue(project_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	const issue_id = parseValue(issue_id_schema, params.issueId);
	if (!issue_id.ok) {
		return issue_id.response;
	}
	try {
		const project = await resolveProject(id.data);
		if (project === undefined) {
			return errorResponse('not_found', 'project not found');
		}
		const result = await getProjectIssue(project, issue_id.data);
		if (result === undefined) {
			return errorResponse('not_found', 'issue not found');
		}
		return jsonResponse(result);
	} catch (error) {
		return errorFromException(error);
	}
};
