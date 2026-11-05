import type { RequestHandler } from './$types';
import { getMateRunner } from '#lib/server/mate/runner.js';
import { mateStatus } from '#lib/server/mate/service.js';
import { jsonResponse } from '#lib/server/security.js';

/**
 * `GET /api/mate/status` → `{ connected, reason?, reachable? }`. Any signed-in
 * viewer may ask, so a member's First Mate can say why it is not answering.
 * `reachable` (admins only) is the runner's cached `/v1/health`.
 */
export const GET: RequestHandler = async ({ locals }) => {
	return jsonResponse(await mateStatus(getMateRunner(), locals.role));
};
