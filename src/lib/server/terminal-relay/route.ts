/**
 * Shared pieces of the `/api/console/terminals` routes: resolving what the
 * browser named (a mission or one of the caller's chats) to an attach, and
 * mapping relay refusals onto the API's error shape. The request gate has
 * already made these routes admin-only and CSRF-checked.
 */
import { attachDispatchTerminal } from '../dispatch/service.js';
import { getMateRunner } from '../mate/runner.js';
import { getMateStore } from '../state/db.js';
import { errorFromException, errorResponse } from '../security.js';
import type { RelayTargetKind } from './audit.js';
import { TerminalRelayError, type TerminalAttachRequest, type TerminalRelay } from './relay.js';

export const NO_CHAT_RELAY_MESSAGE = "This chat's runner has no terminal to open.";

export interface ResolvedTarget {
	kind: RelayTargetKind;
	id: string;
	attach: (request: TerminalAttachRequest) => Promise<TerminalRelay>;
}

/**
 * The attach for a mission, or for a chat the caller owns (someone else's
 * chat is "not found", as on the chat routes).
 */
export async function resolveRelayTarget(
	owner_id: string,
	target: { mission?: string; chat?: string }
): Promise<ResolvedTarget> {
	if (target.mission !== undefined) {
		const mission = target.mission;
		return {
			kind: 'mission',
			id: mission,
			attach: (request) => attachDispatchTerminal(mission, request)
		};
	}
	const chat_id = target.chat!;
	const chat = await (await getMateStore()).getChat(owner_id, chat_id);
	if (chat === undefined) throw new TerminalRelayError('not_found', 'chat not found');
	const runner = getMateRunner(chat.runner);
	if (runner?.attachTerminal === undefined) {
		throw new TerminalRelayError('conflict', NO_CHAT_RELAY_MESSAGE);
	}
	return {
		kind: 'chat',
		id: chat.id,
		attach: (request) => runner.attachTerminal!(chat.id, request)
	};
}

/** A refusal's own code and message; anything else is a generic failure. */
export function relayErrorResponse(error: unknown): Response {
	if (error instanceof TerminalRelayError) return errorResponse(error.code, error.message);
	return errorFromException(error, 'unavailable');
}
