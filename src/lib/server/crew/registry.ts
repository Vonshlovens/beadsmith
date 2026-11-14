/**
 * Crew tools (ADR-0020): what a First Mate chat agent may ask Beadsmith to do,
 * defined once. Each tool is a name, a description the model reads, a zod
 * input schema (validated here and published as JSON Schema by `mcp.ts`) and
 * a handler over the existing server modules. Nothing in this directory knows
 * about a transport, so a Sand relay, the forge guest or a hosted MCP endpoint
 * can all serve the same list.
 */
import type { z } from 'zod';
import type { AccountRole, Permission } from '../auth/roles.js';
import type { ReadDeps } from '../read-model.js';
import type { DispatchDeps } from '../dispatch/service.js';
import type { TodoStore } from '../todos/store.js';
import type { MemoryStore } from '../mate/memory-store.js';
import type { Project } from '#lib/types.js';
import type { LaunchLimiter } from './launch-limit.js';

/**
 * Who is calling. Tools act as the chat's owner (rule 3), so authority comes
 * from `role` through the same permission checks the HTTP gate uses, never
 * from anything the sandbox sends.
 */
export interface CrewContext {
	/** The account that owns the chat. */
	account_id: string;
	/**
	 * The owner's email, recorded as the actor on missions a tool launches,
	 * as the browser records the signed-in user's email.
	 */
	actor: string;
	role: AccountRole;
	chat_id: string;
	/**
	 * The chat's project id, or null for every project. Project-scoped tools
	 * default to it when the model names no project; it does not narrow what
	 * the owner may read, because the browser does not narrow it either.
	 */
	scope: string | null;
}

/** Server modules the tools call; tests inject fakes, production the defaults. */
export interface CrewDeps {
	/** Discovered projects; `force` bypasses the discovery cache. */
	projects?: (options: { force?: boolean }) => Promise<Project[]>;
	read?: ReadDeps;
	dispatch?: DispatchDeps;
	todos?: () => Promise<TodoStore>;
	/** The owner's First Mate memories (ADR-0024). */
	memories?: () => Promise<MemoryStore>;
	/** Per-chat cap on mission launches; defaults to the env-configured one. */
	launch_limiter?: LaunchLimiter;
}

/**
 * One `tools/call`. `id` names the call across retries: Claude Code's tool
 * use id (`_meta["claudecode/toolUseId"]`) when the client sends one, else a
 * hash of the tool name and validated arguments, so a client that retries a
 * call without an id still replays it.
 */
export interface CrewCall {
	id: string;
}

export interface CrewTool<Input = unknown> {
	name: string;
	description: string;
	/** Object schema with no transforms, so its JSON Schema is exact. */
	input: z.ZodType<Input>;
	/** Permission the owner's role needs, as the matching HTTP route requires. */
	permission?: Permission;
	/** Returns a JSON value; `mcp.ts` bounds and serialises it. */
	handler(ctx: CrewContext, input: Input, deps: CrewDeps, call: CrewCall): Promise<unknown>;
}

/**
 * Keep a tool's input type while storing it in a list of tools.
 * @param tool Tool definition.
 */
export function defineTool<Input>(tool: CrewTool<Input>): CrewTool {
	return tool as unknown as CrewTool;
}

/**
 * A failure the model should read and can act on (a missing project, an
 * unknown issue). Its message is written for the model and is always safe.
 */
export class CrewToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CrewToolError';
	}
}

/** Longest single string field a tool returns before it is cut. */
export const FIELD_MAX_CHARS = 2_000;
/** Longest serialised tool result; past this, fields are cut harder. */
export const RESULT_MAX_CHARS = 24_000;

/**
 * Cut a string to `max` characters, saying how much was dropped so the model
 * knows the text is incomplete rather than assuming it is whole.
 * @param text Text to bound.
 * @param max Character budget.
 */
export function truncateText(text: string, max: number = FIELD_MAX_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

function boundStrings(value: unknown, max: number): unknown {
	if (typeof value === 'string') return truncateText(value, max);
	if (Array.isArray(value)) return value.map((entry) => boundStrings(entry, max));
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, boundStrings(entry, max)])
		);
	}
	return value;
}

/**
 * Serialise a tool result as compact JSON within `RESULT_MAX_CHARS`. Long
 * fields are cut first, at shrinking budgets; only if that is not enough is
 * the text itself cut, with a note, because a model can still use most of a
 * list it is told is incomplete.
 * @param value JSON value from a handler.
 */
export function boundedJson(value: unknown): string {
	for (const max of [FIELD_MAX_CHARS, 500, 160]) {
		const text = JSON.stringify(boundStrings(value, max)) ?? 'null';
		if (text.length <= RESULT_MAX_CHARS) return text;
	}
	const text = JSON.stringify(boundStrings(value, 160)) ?? 'null';
	return `${text.slice(0, RESULT_MAX_CHARS)}… [result truncated: ${
		text.length - RESULT_MAX_CHARS
	} more chars; ask for fewer items]`;
}
