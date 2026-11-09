/**
 * MCP over JSON-RPC 2.0 for crew tools (ADR-0020 rule 1): `initialize`,
 * `notifications/initialized`, `ping`, `tools/list` and `tools/call`, one
 * message in, at most one message out. It never throws for anything a client
 * sends: bad frames become JSON-RPC errors, failed tools become tool results
 * with `isError`, so a confused or hostile chat agent cannot break the bridge
 * that carries it. Framing and transport belong to the caller.
 */
import { z } from 'zod';
import { roleCan } from '../auth/roles.js';
import { safeError } from '../security.js';
import { READ_TOOLS } from './read-tools.js';
import {
	boundedJson,
	CrewToolError,
	type CrewContext,
	type CrewDeps,
	type CrewTool
} from './registry.js';

/** Every crew tool, in the order `tools/list` returns them. */
export const CREW_TOOLS: CrewTool[] = [...READ_TOOLS];

/** Newest first; an `initialize` asking for another version gets the newest. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const CREW_SERVER_INFO = { name: 'beadsmith-crew', version: '1.0.0' } as const;

const INSTRUCTIONS =
	'Beadsmith crew tools act as the owner of this chat. Read tools return compact JSON; ' +
	'long text is cut and says so. Use list_projects for project ids.';

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
	arguments: z.record(z.string(), z.unknown()).optional()
});

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
 * @param options `tools` defaults to every crew tool; `deps` to production modules.
 */
export function createCrewMcpHandler(
	options: { tools?: CrewTool[]; deps?: CrewDeps; log?: (message: string) => void } = {}
): CrewMcpHandler {
	const tools = options.tools ?? CREW_TOOLS;
	const deps = options.deps ?? {};
	const log = options.log ?? ((message: string) => console.warn(message));
	const by_name = new Map(tools.map((tool) => [tool.name, tool]));

	async function callTool(ctx: CrewContext, id: JsonRpcId, params: unknown) {
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
			return ok(id, toolText(boundedJson(await tool.handler(ctx, input.data, deps)), false));
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
