import type { RequestHandler } from './$types';
import { listMissions } from '#lib/server/dispatch/service.js';
import { ownedChat } from '#lib/server/mate/route.js';
import { missionProjectNames } from '#lib/server/mission-names.js';
import { errorFromException, jsonResponse } from '#lib/server/security.js';

/** The most a chat shows inline; older ones stay on the missions page. */
const CHAT_MISSIONS_LIMIT = 50;

/**
 * `GET /api/mate/chats/:id/missions` → `{ missions }`: the missions this
 * chat's crew tools launched (ADR-0020 rule 5), newest first, so the chat
 * can show each inline with its live status. Owner-only like the chat: the
 * same rows are on the missions page, but which chat launched them is not.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		const owned = await ownedChat(locals, params.id);
		if (!owned.ok) {
			return owned.response;
		}
		const missions = await listMissions(
			{ chat_id: owned.chat.id, limit: CHAT_MISSIONS_LIMIT },
			{ project_names: await missionProjectNames() }
		);
		return jsonResponse({ missions });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
