import type { RequestHandler } from './$types';
import { getMateRunner, MateRunnerError } from '#lib/server/mate/runner.js';
import { ownedChat } from '#lib/server/mate/route.js';
import { mateErrorResponse, sendMateMessage } from '#lib/server/mate/service.js';
import { errorFromException, jsonResponse } from '#lib/server/security.js';
import { mate_message_schema, parseJsonBody } from '#lib/server/validation.js';

/**
 * `POST /api/mate/chats/:id/messages` `{ text, message_id? }` → 202.
 *
 * With a runner: `{ event_id }`, the id of the `user` event the runner
 * recorded; that event and the agent's reply arrive on the chat's event
 * stream. The agent queues messages sent while it works, so there is no
 * "busy". `message_id` (generated once per message, reused on a retry) lets
 * the runner drop a repeat; the server makes one up when it is absent.
 *
 * Without a runner: `{ events }`, the stored message and placeholder reply.
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	try {
		const owned = await ownedChat(locals, params.id);
		if (!owned.ok) {
			return owned.response;
		}
		const body = await parseJsonBody(request, mate_message_schema);
		if (!body.ok) {
			return body.response;
		}
		const result = await sendMateMessage(owned.store, getMateRunner(), owned.chat, body.data);
		return jsonResponse(result, 202);
	} catch (error) {
		return error instanceof MateRunnerError
			? mateErrorResponse(error)
			: errorFromException(error, 'unavailable');
	}
};
