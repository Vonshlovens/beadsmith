import { z } from 'zod';
import type { RequestHandler } from './$types';
import { getEnv } from '#lib/server/env.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';
import {
	getUnderclassClient,
	UNDERCLASS_ACCOUNT_ID,
	UNDERCLASS_ACTIONS,
	UnderclassAccountNotFound
} from '#lib/server/underclass/client.js';
import { parseValue } from '#lib/server/validation.js';
import type { ModelPoolAction, ModelPoolActionResponse } from '#lib/types.js';

const params_schema = z.object({
	id: z.string().regex(UNDERCLASS_ACCOUNT_ID, 'invalid account id'),
	action: z.enum(UNDERCLASS_ACTIONS as [ModelPoolAction, ...ModelPoolAction[]])
});

/** An empty body is no options; `force` only means something to a reset. */
const body_schema = z.object({ force: z.boolean().optional() }).strict();

let log: (line: string) => void = (line) => console.info(line);

/** Replace the audit line sink (tests only). */
export function _setActionLog(sink: ((line: string) => void) | undefined): void {
	log = sink ?? ((line) => console.info(line));
}

/**
 * `POST /api/console/model-pool/accounts/:id/:action`: refresh, enable,
 * disable or reset one Underclass account (ADR-0022 rule 4). Admin-only and
 * CSRF-checked as every `/api/console` mutation is. The account id is the
 * only browser input that reaches Underclass, and only after
 * `UNDERCLASS_ACCOUNT_ID` admits it.
 *
 * Each call writes one server log line with the acting user's id, the
 * action, the account id and the result, never the account's label (an
 * email address). A refusal answers 200 with `outcome: 'refused'`; an
 * unknown account 404; Underclass being off 409; upstream failures 503.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (locals.user === undefined) {
		return errorResponse('unauthorized', 'session required');
	}
	const target = parseValue(params_schema, params);
	if (!target.ok) return target.response;

	const text = await request.text();
	let payload: unknown = {};
	if (text.trim() !== '') {
		try {
			payload = JSON.parse(text);
		} catch {
			return errorResponse('bad_request', 'invalid JSON body');
		}
	}
	const body = parseValue(body_schema, payload);
	if (!body.ok) return body.response;
	if (body.data.force !== undefined && target.data.action !== 'reset') {
		return errorResponse('bad_request', 'force applies only to a reset');
	}

	const env = getEnv();
	if (env.underclass === undefined) {
		return errorResponse('conflict', 'The model pool is not connected.');
	}
	const { id, action } = target.data;
	const force = body.data.force === true;
	const audit = (result: string) =>
		log(
			`model pool: user ${locals.user!.id} ${action}${force ? ' (forced)' : ''} account ${id}: ${result}`
		);
	try {
		const result = await getUnderclassClient(env.underclass).act(id, action, { force });
		audit(result.outcome === 'done' ? 'done' : `refused (${result.refusal})`);
		return jsonResponse(result satisfies ModelPoolActionResponse);
	} catch (error) {
		if (error instanceof UnderclassAccountNotFound) {
			audit('unknown account');
			return errorResponse('not_found', error.message);
		}
		audit('failed');
		return errorFromException(error, 'unavailable');
	}
};
