import type { RequestHandler } from './$types';
import { jsonResponse } from '#lib/server/security.js';
import { relayErrorResponse } from '#lib/server/terminal-relay/route.js';
import { sendTerminalRelayInput } from '#lib/server/terminal-relay/service.js';
import {
	parseJsonBody,
	parseValue,
	terminal_relay_id_schema,
	terminal_relay_input_schema
} from '#lib/server/validation.js';

/**
 * `POST /api/console/terminals/:relay` → 202. Keystrokes (`data`, base64) and
 * a new size (`cols` and `rows`) for a relay this browser opened with
 * `take_over`. A watching relay answers 409; one that is closed, unknown or
 * another session's answers 404. Nothing sent is logged or stored.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const relay = parseValue(terminal_relay_id_schema, params.relay);
	if (!relay.ok) return relay.response;
	const body = await parseJsonBody(request, terminal_relay_input_schema);
	if (!body.ok) return body.response;
	try {
		const { data, cols, rows } = body.data;
		sendTerminalRelayInput(relay.data, locals.session_id, {
			data: data === undefined ? undefined : new Uint8Array(Buffer.from(data, 'base64')),
			size: cols === undefined || rows === undefined ? undefined : { cols, rows }
		});
		return jsonResponse({ sent: true }, 202);
	} catch (error) {
		return relayErrorResponse(error);
	}
};
