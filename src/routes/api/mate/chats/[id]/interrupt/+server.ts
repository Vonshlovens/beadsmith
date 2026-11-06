import type { RequestHandler } from './$types';
import { getMateRunner } from '#lib/server/mate/runner.js';
import { ownedChat } from '#lib/server/mate/route.js';
import { mateErrorResponse } from '#lib/server/mate/service.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';

/**
 * `POST /api/mate/chats/:id/interrupt` → 202 `{ interrupted: true }`. Stops
 * the agent's current turn; the session and its crew keep running.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	let owned;
	try {
		owned = await ownedChat(locals, params.id);
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
	if (!owned.ok) {
		return owned.response;
	}
	const runner = getMateRunner(owned.chat.runner);
	if (runner === undefined) {
		return errorResponse('unavailable', 'First Mate is not connected to a runner.');
	}
	try {
		await runner.interrupt(owned.chat.id);
		return jsonResponse({ interrupted: true }, 202);
	} catch (error) {
		return mateErrorResponse(error);
	}
};
