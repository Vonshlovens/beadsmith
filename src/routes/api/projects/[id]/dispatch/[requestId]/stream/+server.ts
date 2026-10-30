import type { RequestHandler } from './$types';
import { resolveProject } from '$lib/server/discovery.js';
import { dispatchExists, streamDispatchMissionEvents } from '$lib/server/dispatch/service.js';
import { encodeMissionEvent, type MissionEvent } from '$lib/mission-events.js';
import { errorFromException, errorResponse } from '$lib/server/security.js';
import {
	dispatch_request_id_schema,
	parseValue,
	project_id_schema
} from '$lib/server/validation.js';

function encodeSse(event: MissionEvent): string {
	const payload = encodeMissionEvent(event);
	return `id: ${payload.id}\nevent: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Proxy a provider's live events as canonical MissionEvent frames. The
 * browser never sees raw runner payloads or provider credentials.
 */
export const GET: RequestHandler = async ({ params, request }) => {
	const id = parseValue(project_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	const request_id = parseValue(dispatch_request_id_schema, params.requestId);
	if (!request_id.ok) {
		return request_id.response;
	}

	try {
		const project = await resolveProject(id.data);
		if (project === undefined) {
			return errorResponse('not_found', 'project not found');
		}
		const exists = await dispatchExists(project.id, request_id.data);
		if (!exists) {
			return errorResponse('not_found', 'dispatch request not found');
		}

		const encoder = new TextEncoder();
		const last_event_id = request.headers.get('last-event-id');
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const push = (chunk: string) => {
					controller.enqueue(encoder.encode(chunk));
				};
				void (async () => {
					try {
						const outcome = await streamDispatchMissionEvents(
							project.id,
							request_id.data,
							async (event) => {
								push(encodeSse(event));
							},
							{ last_event_id: last_event_id ?? undefined, signal: request.signal }
						);
						if (outcome === 'not_launched') {
							push(
								encodeSse({
									type: 'error',
									id: 'stored-error',
									message: 'This mission has not launched an agent yet.'
								})
							);
						} else if (outcome === 'stream_expired') {
							push(
								encodeSse({
									type: 'error',
									id: 'stored-error',
									message: 'The live agent stream has expired.'
								})
							);
						}
						push('event: done\ndata: {}\n\n');
						controller.close();
					} catch {
						if (request.signal.aborted) {
							controller.close();
							return;
						}
						push(
							encodeSse({
								type: 'error',
								id: 'stored-error',
								message: 'The mission stream is temporarily unavailable.'
							})
						);
						push('event: done\ndata: {}\n\n');
						controller.close();
					}
				})();
			}
		});

		return new Response(stream, {
			headers: {
				'content-type': 'text/event-stream; charset=utf-8',
				'cache-control': 'no-store',
				connection: 'keep-alive',
				'x-accel-buffering': 'no'
			}
		});
	} catch (error) {
		return errorFromException(error);
	}
};
