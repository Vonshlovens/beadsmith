import type { RequestHandler } from './$types';
import { getEnv } from '#lib/server/env.js';
import { errorFromException, jsonResponse } from '#lib/server/security.js';
import { getUnderclassClient } from '#lib/server/underclass/client.js';
import type { ModelPoolResponse } from '#lib/types.js';

/**
 * The Underclass model pool, admin only (`/api/console` is admin-only in
 * `roles.ts`). Takes no parameters: the client calls a fixed list of read
 * routes, so nothing in this request reaches Underclass (ADR-0022 rule 4).
 * Upstream failures answer 503 with one of four `failure_kind` classes.
 */
export const GET: RequestHandler = async () => {
	const env = getEnv();
	if (env.underclass === undefined) {
		const body: ModelPoolResponse =
			env.underclass_error === undefined
				? { configured: false }
				: { configured: false, config_error: env.underclass_error };
		return jsonResponse(body);
	}
	try {
		const pool = await getUnderclassClient(env.underclass).snapshot();
		return jsonResponse({ configured: true, pool } satisfies ModelPoolResponse);
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
