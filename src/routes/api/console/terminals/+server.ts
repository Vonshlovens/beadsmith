import type { RequestHandler } from './$types';
import { ownerOf } from '#lib/server/mate/route.js';
import { relayErrorResponse, resolveRelayTarget } from '#lib/server/terminal-relay/route.js';
import { openTerminalRelay } from '#lib/server/terminal-relay/service.js';
import { open_terminal_relay_schema, parseJsonBody } from '#lib/server/validation.js';

/** Who an attach is recorded as: the account's email, as dispatch records its actor. */
function actorOf(locals: App.Locals, owner_id: string): string {
	const email = locals.user?.email?.trim();
	return email !== undefined && email.length > 0 ? email : owner_id;
}

/**
 * `POST /api/console/terminals` → a `text/event-stream` of a mission's or
 * chat's agent terminal (ADR-0021 rule 4; frames in
 * `$lib/server/terminal-relay/service.ts`). `mode: watch` only looks and
 * never wakes a paused sandbox; `take_over` lets this browser type through
 * `POST /api/console/terminals/:relay`. 404 for an unknown mission or chat,
 * 409 when there is no live terminal to open.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const owner = ownerOf(locals);
	if (!owner.ok) return owner.response;
	const body = await parseJsonBody(request, open_terminal_relay_schema);
	if (!body.ok) return body.response;
	try {
		const target = await resolveRelayTarget(owner.id, body.data);
		const { body: stream } = await openTerminalRelay({
			owner: locals.session_id,
			actor: actorOf(locals, owner.id),
			target: { kind: target.kind, id: target.id },
			mode: body.data.mode,
			cols: body.data.cols,
			rows: body.data.rows,
			attach: target.attach,
			signal: request.signal
		});
		return new Response(stream, {
			headers: {
				'content-type': 'text/event-stream',
				'cache-control': 'no-store',
				connection: 'keep-alive',
				// Tell a buffering reverse proxy to pass bytes through as they come.
				'x-accel-buffering': 'no'
			}
		});
	} catch (error) {
		return relayErrorResponse(error);
	}
};
