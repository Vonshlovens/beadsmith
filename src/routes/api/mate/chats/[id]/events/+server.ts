import type { RequestHandler } from './$types';
import { getMateRunner } from '#lib/server/mate/runner.js';
import { ownedChat } from '#lib/server/mate/route.js';
import { mateEventStream, SSE_HEADERS } from '#lib/server/mate/service.js';
import { errorFromException, errorResponse } from '#lib/server/security.js';
import { mate_event_id_schema, parseValue } from '#lib/server/validation.js';

/**
 * `GET /api/mate/chats/:id/events[?after=]` → `text/event-stream`.
 *
 * Replays the stored events after `Last-Event-ID` (or `?after=`), then
 * follows the runner live, storing each new event before forwarding it as
 * `id: <event id>` + `data: <MissionEvent JSON with at>`. A runner failure is
 * an `event: runner_error` frame, then the stream closes and EventSource
 * reconnects. Closing the browser closes only this relay: the session keeps
 * running on the runner. `503` when no runner is configured.
 */
export const GET: RequestHandler = async ({ params, locals, request, url }) => {
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
	const raw_after = request.headers.get('last-event-id') ?? url.searchParams.get('after');
	let after: string | undefined;
	if (raw_after !== null && raw_after !== '') {
		const parsed = parseValue(mate_event_id_schema, raw_after);
		if (!parsed.ok) {
			return parsed.response;
		}
		after = parsed.data;
	}
	const stream = mateEventStream({
		store: owned.store,
		runner,
		chat: owned.chat,
		after,
		signal: request.signal
	});
	return new Response(stream, { headers: SSE_HEADERS });
};
