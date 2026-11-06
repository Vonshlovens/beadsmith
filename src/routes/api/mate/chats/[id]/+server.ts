import type { RequestHandler } from './$types';
import { getMateRunner, MateRunnerError } from '#lib/server/mate/runner.js';
import { ownedChat } from '#lib/server/mate/route.js';
import { MAX_REPLAY_EVENTS, mateErrorResponse } from '#lib/server/mate/service.js';
import { publicChat } from '#lib/server/mate/store.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';
import { parseJsonBody, update_mate_chat_schema } from '#lib/server/validation.js';

/** `GET /api/mate/chats/:id` → `{ chat, events }`: the stored log, oldest first. */
export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		const owned = await ownedChat(locals, params.id);
		if (!owned.ok) {
			return owned.response;
		}
		const events = await owned.store.listEvents(owned.chat.id, { limit: MAX_REPLAY_EVENTS });
		return jsonResponse({ chat: publicChat(owned.chat), events });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

/** `PATCH /api/mate/chats/:id` `{ title?, scope? }` → `{ chat }`. Scope applies from the next message. */
export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	try {
		const owned = await ownedChat(locals, params.id);
		if (!owned.ok) {
			return owned.response;
		}
		const body = await parseJsonBody(request, update_mate_chat_schema);
		if (!body.ok) {
			return body.response;
		}
		const chat = await owned.store.updateChat(owned.owner_id, owned.chat.id, body.data);
		return chat === undefined
			? errorResponse('not_found', 'chat not found')
			: jsonResponse({ chat });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

/**
 * `DELETE /api/mate/chats/:id` → `{ deleted: true }`. Stops the runner
 * session first; if the runner cannot, the chat stays so the delete can be
 * retried rather than leave a session running with no chat behind it.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	try {
		const owned = await ownedChat(locals, params.id);
		if (!owned.ok) {
			return owned.response;
		}
		const runner = getMateRunner(owned.chat.runner);
		if (runner !== undefined) {
			await runner.deleteChat(owned.chat.id);
		}
		await owned.store.deleteChat(owned.owner_id, owned.chat.id);
		return jsonResponse({ deleted: true });
	} catch (error) {
		return error instanceof MateRunnerError
			? mateErrorResponse(error)
			: errorFromException(error, 'unavailable');
	}
};
