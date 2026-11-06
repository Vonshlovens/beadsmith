import type { RequestHandler } from './$types';
import { MAX_CHATS } from '#lib/mate.js';
import { ownerOf } from '#lib/server/mate/route.js';
import { getEnv } from '#lib/server/env.js';
import { getMateStore } from '#lib/server/state/db.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';
import { create_mate_chat_schema, parseJsonBody } from '#lib/server/validation.js';

/** `GET /api/mate/chats` → `{ chats }`, the caller's own, newest first. Admin-only. */
export const GET: RequestHandler = async ({ locals }) => {
	const owner = ownerOf(locals);
	if (!owner.ok) {
		return owner.response;
	}
	try {
		const store = await getMateStore();
		return jsonResponse({ chats: await store.listChats(owner.id, MAX_CHATS) });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

/**
 * `POST /api/mate/chats` `{ title?, scope?, runner? }` → 201 `{ chat }`. The
 * runner session starts with the first message. `runner` picks one of the
 * configured chat runners (`400` otherwise) and stays with the chat; omitted,
 * the default one. `409` once the caller has {@link MAX_CHATS} chats.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const owner = ownerOf(locals);
	if (!owner.ok) {
		return owner.response;
	}
	const body = await parseJsonBody(request, create_mate_chat_schema);
	if (!body.ok) {
		return body.response;
	}
	const runners = getEnv().mate_runners;
	if (body.data.runner !== undefined && !runners.includes(body.data.runner)) {
		return errorResponse('bad_request', 'That chat runner is not configured on this service.');
	}
	try {
		const store = await getMateStore();
		if ((await store.countChats(owner.id)) >= MAX_CHATS) {
			return errorResponse('conflict', `You have ${MAX_CHATS} chats; delete one first.`);
		}
		const chat = await store.createChat(owner.id, {
			title: body.data.title ?? 'New chat',
			scope: body.data.scope,
			runner: body.data.runner ?? runners[0] ?? 'remote'
		});
		return jsonResponse({ chat }, 201);
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
