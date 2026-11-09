import type { RequestHandler } from './$types';
import { CREW_CALL_ID_PATTERN } from '#lib/mate.js';
import { ownedChat } from '#lib/server/mate/route.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';

/**
 * `GET /api/mate/chats/:id/crew-calls/:call_id` → `{ call }`: one crew tool
 * call with the arguments the agent sent and the text Beadsmith answered,
 * each as kept (bounded). Read when the owner opens a call's details, so the
 * chat never loads every body up front. Owner-only like the chat.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		const owned = await ownedChat(locals, params.id);
		if (!owned.ok) {
			return owned.response;
		}
		const call_id = params.call_id ?? '';
		const call = CREW_CALL_ID_PATTERN.test(call_id)
			? await owned.store.getCrewCall(owned.chat.id, call_id)
			: undefined;
		if (call === undefined) {
			return errorResponse('not_found', 'crew call not found');
		}
		return jsonResponse({ call });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
