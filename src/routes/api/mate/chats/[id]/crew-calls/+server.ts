import type { RequestHandler } from './$types';
import { ownedChat } from '#lib/server/mate/route.js';
import { errorFromException, jsonResponse } from '#lib/server/security.js';

/**
 * `GET /api/mate/chats/:id/crew-calls` → `{ calls }`: the crew tool calls
 * Beadsmith answered for this chat (ADR-0020), oldest first, without their
 * arguments or results. A refused call carries the start of its reason, so
 * the chat can say why next to the activity line. Owner-only like the chat.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		const owned = await ownedChat(locals, params.id);
		if (!owned.ok) {
			return owned.response;
		}
		return jsonResponse({ calls: await owned.store.listCrewCalls(owned.chat.id) });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
