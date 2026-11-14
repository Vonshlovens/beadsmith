/**
 * MCP over JSON-RPC 2.0 for crew tools (ADR-0020 rule 1): `initialize`,
 * `notifications/initialized`, `ping`, `tools/list` and `tools/call`, one
 * message in, at most one message out. It never throws for anything a client
 * sends: bad frames become JSON-RPC errors, failed tools become tool results
 * with `isError`, so a confused or hostile chat agent cannot break the bridge
 * that carries it. Framing and transport belong to the caller.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CREW_CALL_ID_PATTERN } from '#lib/mate.js';
import { roleCan } from '../auth/roles.js';
import { safeError } from '../security.js';
import { READ_TOOLS } from './read-tools.js';
import { WRITE_TOOLS } from './write-tools.js';
import { MEMORY_TOOLS } from './memory-tools.js';
import {
	boundedJson,
	CrewToolError,
	type CrewContext,
	type CrewDeps,
	type CrewTool
} from './registry.js';

/** Every crew tool, in the order `tools/list` returns them. */
export const CREW_TOOLS: CrewTool[] = [...READ_TOOLS, ...WRITE_TOOLS, ...MEMORY_TOOLS];

/** Newest first; an `initialize` asking for another version gets the newest. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const CREW_SERVER_INFO = { name: 'beadsmith-crew', version: '1.0.0' } as const;

const INSTRUCTIONS =
	'Beadsmith crew tools act as the owner of this chat. Read tools return compact JSON; ' +
	'long text is cut and says so. Use list_projects for project ids. Todo tools change the ' +
	"owner's todo list directly. Beads changes go through missions: file_issue, comment_issue, " +
	'tackle_issue and discuss_issue each start an agent with its own thread; say what you ' +
	'started (operation, project, issue, mission id). Launches per chat are rate limited.';

/** JSON-RPC 2.0 error codes used here. */
export const JSONRPC_ERRORS = {
	parse: -32700,
	invalid_request: -32600,
	method_not_found: -32601,
	invalid_params: -32602,
	internal: -32603
} as const;

type JsonRpcId = string | number | null;

export type JsonRpcResponse =
	| { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
	| { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string } };

const request_schema = z.object({
	jsonrpc: z.literal('2.0'),
	id: z.union([z.string().max(200), z.number().int()]).optional(),
	method: z.string().max(200),
	params: z.record(z.string(), z.unknown()).optional()
});

const call_params_schema = z.object({
	name: z.string().max(200),
	arguments: z.record(z.string(), z.unknown()).optional(),
	_meta: z.record(z.string(), z.unknown()).optional()
});

/** Claude Code names each MCP call with its tool use id in `_meta`. */
const TOOL_USE_ID_KEY = 'claudecode/toolUseId';

/** The client's tool use id, when it sent a well-formed one. */
function toolUseId(meta: Record<string, unknown> | undefined): string | undefined {
	const tool_use_id = meta?.[TOOL_USE_ID_KEY];
	return typeof tool_use_id === 'string' && CREW_CALL_ID_PATTERN.test(tool_use_id)
		? tool_use_id
		: undefined;
}

/**
 * The call's identity across retries: the client's tool use id, or a hash of
 * the tool and its validated arguments when the client sends none.
 */
function callId(tool: CrewTool, meta: Record<string, unknown> | undefined, input: unknown): string {
	const tool_use_id = toolUseId(meta);
	if (tool_use_id !== undefined) {
		return `use:${tool_use_id}`;
	}
	const digest = createHash('sha256')
		.update(`${tool.name}\0${JSON.stringify(input)}`)
		.digest('hex');
	return `args:${digest}`;
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
	return { jsonrpc: '2.0', id, result };
}

function fail(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
	return { jsonrpc: '2.0', id, error: { code, message } };
}

/** One line per zod issue, short enough for a model to act on. */
function describeIssues(error: z.ZodError): string {
	return error.issues
		.slice(0, 5)
		.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'input'}: ${issue.message}`)
		.join('; ');
}

/** JSON Schema for a tool's input, as the client sees it (defaults optional). */
export function toolInputSchema(tool: CrewTool): Record<string, unknown> {
	const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.input, { io: 'input' }) as Record<
		string,
		unknown
	>;
	return schema;
}

function permitted(ctx: CrewContext, tool: CrewTool): boolean {
	return tool.permission === undefined || roleCan(ctx.role, tool.permission);
}

function toolText(text: string, is_error: boolean) {
	return { content: [{ type: 'text', text }], ...(is_error ? { isError: true } : {}) };
}

/**
 * One answered `tools/call`, for the chat's record of what Beadsmith did
 * (`MateStore.recordCrewCall`). Only calls Claude Code named with a tool use
 * id are reported, because that id is what ties the record to the chat's
 * activity line.
 */
export interface CrewCallReport {
	call_id: string;
	tool: string;
	/** The arguments as sent, as JSON text. */
	arguments: string;
	/** Exactly the text the agent was given. */
	result: string;
	is_error: boolean;
	mission_id?: string;
}

/** The mission a launch tool's result names, if any. */
function missionIdOf(result: unknown): string | undefined {
	if (result === null || typeof result !== 'object' || !('mission_id' in result)) return undefined;
	return typeof result.mission_id === 'string' ? result.mission_id : undefined;
}

export interface CrewMcpHandler {
	/**
	 * Handle one parsed JSON-RPC message. Undefined means no reply is due (a
	 * notification). Never rejects.
	 */
	handle(ctx: CrewContext, message: unknown): Promise<JsonRpcResponse | undefined>;
	/** Same, for one raw frame of JSON text (`-32700` when it is not JSON). */
	handleText(ctx: CrewContext, text: string): Promise<JsonRpcResponse | undefined>;
}

/**
 * Build the handler over a tool list.
 * @param options `tools` defaults to every crew tool; `deps` to production
 *   modules. `record` keeps each answered call for the chat's owner; a
 *   failure there is logged and never changes what the agent is told.
 */
export function createCrewMcpHandler(
	options: {
		tools?: CrewTool[];
		deps?: CrewDeps;
		log?: (message: string) => void;
		record?: (ctx: CrewContext, call: CrewCallReport) => Promise<void>;
	} = {}
): CrewMcpHandler {
	const tools = options.tools ?? CREW_TOOLS;
	const deps = options.deps ?? {};
	const log = options.log ?? ((message: string) => console.warn(message));
	const record = options.record;
	const by_name = new Map(tools.map((tool) => [tool.name, tool]));

	async function callTool(
		ctx: CrewContext,
		id: JsonRpcId,
		params: unknown
	): Promise<JsonRpcResponse> {
		const response = await answerCall(ctx, id, params);
		if (record !== undefined) await report(record, ctx, params, response);
		return response;
	}

	/** Hand an answered call to `record`, when it can be tied to the chat's activity line. */
	async function report(
		keep: NonNullable<typeof record>,
		ctx: CrewContext,
		params: unknown,
		response: JsonRpcResponse
	) {
		const call = call_params_schema.safeParse(params ?? {});
		if (!call.success || !by_name.has(call.data.name)) return;
		const call_id = toolUseId(call.data._meta);
		if (call_id === undefined) return;
		let text: string;
		let is_error: boolean;
		let mission_id: string | undefined;
		if ('error' in response) {
			text = response.error.message;
			is_error = true;
		} else {
			const result = response.result as ReturnType<typeof toolText>;
			text = result.content[0]?.text ?? '';
			is_error = result.isError === true;
			if (!is_error) {
				try {
					mission_id = missionIdOf(JSON.parse(text));
				} catch {
					// A result cut to fit is not JSON; it simply names no mission.
				}
			}
		}
		try {
			await keep(ctx, {
				call_id,
				tool: call.data.name,
				arguments: JSON.stringify(call.data.arguments ?? {}),
				result: text,
				is_error,
				...(mission_id === undefined ? {} : { mission_id })
			});
		} catch (error) {
			log(`crew call record failed for chat ${ctx.chat_id}: ${String(error)}`);
		}
	}

	async function answerCall(
		ctx: CrewContext,
		id: JsonRpcId,
		params: unknown
	): Promise<JsonRpcResponse> {
		const call = call_params_schema.safeParse(params ?? {});
		if (!call.success) {
			return fail(
				id,
				JSONRPC_ERRORS.invalid_params,
				`Invalid tools/call: ${describeIssues(call.error)}`
			);
		}
		const tool = by_name.get(call.data.name);
		if (tool === undefined) {
			return fail(
				id,
				JSONRPC_ERRORS.invalid_params,
				`Unknown tool: ${call.data.name.slice(0, 80)}`
			);
		}
		const input = tool.input.safeParse(call.data.arguments ?? {});
		if (!input.success) {
			return fail(
				id,
				JSONRPC_ERRORS.invalid_params,
				`Invalid arguments for ${tool.name}: ${describeIssues(input.error)}`
			);
		}
		if (!permitted(ctx, tool)) {
			return ok(
				id,
				toolText(`${tool.name} needs an admin account; this chat's owner is not one.`, true)
			);
		}
		try {
			const call_ref = { id: callId(tool, call.data._meta, input.data) };
			const result = await tool.handler(ctx, input.data, deps, call_ref);
			return ok(id, toolText(boundedJson(result), false));
		} catch (error) {
			if (error instanceof CrewToolError) {
				return ok(id, toolText(error.message, true));
			}
			// Same reduction as the HTTP API: driver detail never reaches the agent.
			log(`crew tool ${tool.name} failed for chat ${ctx.chat_id}: ${String(error)}`);
			return ok(id, toolText(safeError(error).message, true));
		}
	}

	async function dispatch(
		ctx: CrewContext,
		message: unknown
	): Promise<JsonRpcResponse | undefined> {
		const raw_id =
			message !== null && typeof message === 'object' && 'id' in message ? message.id : undefined;
		const echo_id: JsonRpcId =
			typeof raw_id === 'string' || typeof raw_id === 'number' ? raw_id : null;
		if (Array.isArray(message)) {
			return fail(null, JSONRPC_ERRORS.invalid_request, 'Batches are not supported.');
		}
		const parsed = request_schema.safeParse(message);
		if (!parsed.success) {
			return fail(echo_id, JSONRPC_ERRORS.invalid_request, 'Invalid JSON-RPC request.');
		}
		const { id, method, params } = parsed.data;
		if (id === undefined) {
			// Notifications (`notifications/initialized`, cancellations) need no reply.
			return undefined;
		}
		switch (method) {
			case 'initialize': {
				const requested = params?.protocolVersion;
				const version =
					MCP_PROTOCOL_VERSIONS.find((v) => v === requested) ?? MCP_PROTOCOL_VERSIONS[0];
				return ok(id, {
					protocolVersion: version,
					capabilities: { tools: { listChanged: false } },
					serverInfo: CREW_SERVER_INFO,
					instructions: INSTRUCTIONS
				});
			}
			case 'ping':
				return ok(id, {});
			case 'tools/list':
				return ok(id, {
					tools: tools
						.filter((tool) => permitted(ctx, tool))
						.map((tool) => ({
							name: tool.name,
							description: tool.description,
							inputSchema: toolInputSchema(tool)
						}))
				});
			case 'tools/call':
				return callTool(ctx, id, params);
			default:
				return fail(
					id,
					JSONRPC_ERRORS.method_not_found,
					`Method not found: ${method.slice(0, 80)}`
				);
		}
	}

	async function handle(ctx: CrewContext, message: unknown) {
		try {
			return await dispatch(ctx, message);
		} catch (error) {
			log(`crew MCP handler failed for chat ${ctx.chat_id}: ${String(error)}`);
			return fail(null, JSONRPC_ERRORS.internal, 'Internal error.');
		}
	}

	return {
		handle,
		async handleText(ctx, text) {
			let message: unknown;
			try {
				message = JSON.parse(text);
			} catch {
				return fail(null, JSONRPC_ERRORS.parse, 'Parse error.');
			}
			return handle(ctx, message);
		}
	};
}
