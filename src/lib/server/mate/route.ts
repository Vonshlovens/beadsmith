/**
 * Shared checks for the `/api/mate/chats` routes. The request gate already
 * made them admin-only (`requiredPermission`); these add ownership: a chat
 * that is not the caller's is "not found", never "forbidden".
 */
import { getMateStore } from '../state/db.js';
import { errorResponse } from '../security.js';
import { mate_chat_id_schema, parseValue } from '../validation.js';
import type { MateStore, StoredMateChat } from './store.js';

export type OwnedChat =
	| { ok: true; owner_id: string; store: MateStore; chat: StoredMateChat }
	| { ok: false; response: Response };

/** The signed-in account's id, or the 401 to return. */
export function ownerOf(
	locals: App.Locals
): { ok: true; id: string } | { ok: false; response: Response } {
	if (locals.user === undefined) {
		return { ok: false, response: errorResponse('unauthorized', 'session required') };
	}
	return { ok: true, id: locals.user.id };
}

/** Resolve `:id` to one of the caller's chats. */
export async function ownedChat(
	locals: App.Locals,
	raw_id: string | undefined
): Promise<OwnedChat> {
	const owner = ownerOf(locals);
	if (!owner.ok) {
		return owner;
	}
	const id = parseValue(mate_chat_id_schema, raw_id);
	if (!id.ok) {
		return id;
	}
	const store = await getMateStore();
	const chat = await store.getChat(owner.id, id.data);
	if (chat === undefined) {
		return { ok: false, response: errorResponse('not_found', 'chat not found') };
	}
	return { ok: true, owner_id: owner.id, store, chat };
}
