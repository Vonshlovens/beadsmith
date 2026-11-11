import type { RequestHandler } from './$types';
import { MAX_CHATS } from '#lib/mate.js';
import { ownerOf } from '#lib/server/mate/route.js';
import { getEnv } from '#lib/server/env.js';
import { agentChoiceProblem, configuredAgentChoices } from '#lib/server/dispatch/agent-choice.js';
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
 * `POST /api/mate/chats` `{ title?, scope?, runner?, model?, effort? }` → 201
 * `{ chat }`. The runner session starts with the first message. `runner`
 * picks one of the configured chat runners (`400` otherwise) and stays with
 * the chat; omitted, the default one. `model` and `effort` must be on the
 * operator's list (`400` otherwise), as a mission launch's are, because they
 * reach the agent CLI and decide what the chat spends; they too stay with the
 * chat. `409` once the caller has {@link MAX_CHATS} chats.
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
	const choice_problem = agentChoiceProblem(body.data, configuredAgentChoices());
	if (choice_problem !== undefined) {
		return errorResponse('bad_request', choice_problem);
	}
	try {
		const store = await getMateStore();
		if ((await store.countChats(owner.id)) >= MAX_CHATS) {
			return errorResponse('conflict', `You have ${MAX_CHATS} chats; delete one first.`);
		}
		const chat = await store.createChat(owner.id, {
			title: body.data.title ?? 'New chat',
			scope: body.data.scope,
			runner: body.data.runner ?? runners[0] ?? 'remote',
			model: body.data.model,
			effort: body.data.effort
		});
		return jsonResponse({ chat }, 201);
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
