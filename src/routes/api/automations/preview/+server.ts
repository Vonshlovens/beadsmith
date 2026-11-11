/** The next fire times of a schedule being typed, or why it would be refused. */
import type { RequestHandler } from './$types';
import { checkSchedule } from '#lib/server/automations/service.js';
import { errorResponse, jsonResponse } from '#lib/server/security.js';
import { automation_preview_schema, parseQuery } from '#lib/server/validation.js';

export const GET: RequestHandler = ({ url }) => {
	const query = parseQuery(url.searchParams, automation_preview_schema);
	if (!query.ok) return query.response;
	const check = checkSchedule(query.data.cron, query.data.time_zone, new Date());
	if (!check.ok) return errorResponse('bad_request', check.message);
	return jsonResponse({ upcoming: check.upcoming.map((slot) => slot.toISOString()) });
};
