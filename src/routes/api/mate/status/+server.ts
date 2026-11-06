import type { RequestHandler } from './$types';
import { configuredMateRunners, getMateRunner } from '#lib/server/mate/runner.js';
import { mateStatus } from '#lib/server/mate/service.js';
import { jsonResponse } from '#lib/server/security.js';

/**
 * `GET /api/mate/status` → `{ connected, reason?, reachable? }`. Any signed-in
 * viewer may ask, so a member's First Mate can say why it is not answering.
 * `reachable` (admins only) is the default runner's cached health; `runners`
 * (admins only) lists every chat runner a new chat may use.
 */
export const GET: RequestHandler = async ({ locals }) => {
	return jsonResponse(
		await mateStatus(getMateRunner(), locals.role, Date.now, configuredMateRunners())
	);
};
