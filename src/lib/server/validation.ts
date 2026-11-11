import { z } from 'zod';
import { errorResponse } from './security.js';
import { DISPATCH_PROVIDER_IDS, type ThemePreference } from '#lib/types.js';
import type { FileCheckoutMapping } from './dispatch/file-maps.js';
import { parseGitHubRepositoryUrl, parseGitRef } from './dispatch/repositories.js';
import type { TackleRepositoryMapping } from './dispatch/repositories.js';
import { normalizeEndpoint } from './backup/s3.js';
import {
	LOOP_MAX_ITERATIONS,
	RALPH_HARNESSES,
	RALPH_MODES,
	RALPH_STEER_MAX_LENGTH
} from '#lib/ralph.js';
import { AUTOMATION_NAME_MAX, AUTOMATION_OVERLAPS } from '#lib/automations.js';
import { CRON_MAX_LENGTH } from './automations/cron.js';
import { EFFORT_PATTERN, MODEL_PATTERN } from '#lib/agent-session/claude-code.js';
import {
	CHAT_ID_PATTERN,
	CREW_NOTICE_PREFIX,
	MATE_RUNNER_IDS,
	MAX_MESSAGE_CHARS,
	MESSAGE_ID_PATTERN
} from '#lib/mate.js';

/** Zod validation shared by the active, read-only HTTP surface. */

/**
 * bd ids: a prefix (bd allows `_` in custom prefixes) and hash, then any depth
 * of `.N` children (`proj-9nu.5.4`). Always a bound SQL parameter.
 */
export const ISSUE_ID_PATTERN = /^(?=.{1,128}$)[a-z0-9][a-z0-9_-]{0,63}(\.[0-9]+)*$/i;
export const PROJECT_ID_PATTERN = /^d_[a-z0-9_]{1,64}$/;
export const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
export const MAX_LIST_LIMIT = 1000;

export const issue_id_schema = z.string().regex(ISSUE_ID_PATTERN, 'invalid issue id');
export const project_id_schema = z.string().regex(PROJECT_ID_PATTERN, 'invalid project id');
export const label_schema = z.string().regex(LABEL_PATTERN, 'invalid label');
export const status_schema = z.string().max(200);
export const type_schema = z.string().max(64);

export const list_query_schema = z.object({
	status: status_schema.optional(),
	type: type_schema.optional(),
	priority: z
		.string()
		.regex(/^[0-4](,[0-4])*$/)
		.optional(),
	q: z.string().max(200).optional(),
	label: label_schema.optional(),
	limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(200),
	include_closed: z
		.union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
		.optional()
		.transform((value) => {
			return value === '1' || value === 'true';
		})
});

export const activity_query_schema = z.object({
	limit: z.coerce.number().int().min(1).max(500).default(50)
});

/** Query of `GET /api/missions`. */
export const missions_query_schema = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(50),
	project_id: project_id_schema.optional(),
	issue_id: issue_id_schema.optional()
});

/** Body of `POST /api/settings/theme`; tracks `ThemePreference`. */
export const theme_schema: z.ZodType<{ theme: ThemePreference }> = z.object({
	theme: z.enum(['system', 'light', 'dark'])
});

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Follow-up and discuss messages share one cap; they are the free-form steer fields. */
export const FOLLOW_UP_TEXT_MAX = 4000;

/** Optional launch target: one of the configured providers (checked by the service). */
const dispatch_provider_schema = z.enum(DISPATCH_PROVIDER_IDS).optional();

/**
 * Model and effort any launch or new First Mate chat may ask for. The shape
 * only keeps them from being flags; whether the operator offers them is
 * checked against BDX_AGENT_MODELS / BDX_AGENT_EFFORTS (`agentChoiceProblem`).
 */
const agent_choice_shape = {
	model: z.string().regex(MODEL_PATTERN, 'invalid model').optional(),
	effort: z.string().regex(EFFORT_PATTERN, 'invalid effort').optional()
};

/**
 * The fields of each launch operation, without the launch envelope (the
 * idempotency key and runner). A launch request adds the envelope; an
 * automation stores the fields alone as its template (ADR-0019 rule 7) and
 * keeps the runner in its own column, so both validate one shape.
 */
const file_launch_shape = {
	operation: z.literal('file'),
	notes: z.string().trim().min(1).max(8000),
	title: z.string().trim().min(1).max(200).optional(),
	issue_type: z.enum(['bug', 'feature', 'task', 'epic', 'chore']).optional(),
	priority: z.number().int().min(0).max(4).optional(),
	labels: z.array(label_schema).max(8).optional(),
	status: z
		.enum(['open', 'in_progress', 'blocked', 'deferred', 'closed', 'pinned', 'hooked'])
		.optional()
};

const tackle_launch_shape = {
	operation: z.literal('tackle'),
	issue_id: issue_id_schema,
	destination_status: z.enum(['open', 'in_progress', 'blocked', 'deferred', 'closed']).optional()
};

const comment_launch_shape = {
	operation: z.literal('comment'),
	issue_id: issue_id_schema,
	text: z.string().trim().min(1).max(8000)
};

const discuss_launch_shape = {
	operation: z.literal('discuss'),
	issue_id: issue_id_schema,
	intent: z.enum(['discuss', 'elaborate', 'close']),
	message: z.string().trim().min(1).max(FOLLOW_UP_TEXT_MAX).optional()
};

/** Bounds on a loop besides its iteration limit (LOOP_MAX_ITERATIONS in ralph.ts). */
export const LOOP_MAX_ITERATION_TIMEOUT_MINUTES = 240;
export const LOOP_PROMPT_MAX = 8000;

const loop_launch_shape = {
	operation: z.literal('loop'),
	mode: z.enum(RALPH_MODES),
	prompt: z.string().trim().min(1).max(LOOP_PROMPT_MAX).optional(),
	issue_id: issue_id_schema.optional(),
	harness: z.enum(RALPH_HARNESSES).optional(),
	max_iterations: z.number().int().min(1).max(LOOP_MAX_ITERATIONS),
	iteration_timeout_minutes: z
		.number()
		.int()
		.min(1)
		.max(LOOP_MAX_ITERATION_TIMEOUT_MINUTES)
		.optional()
};

interface LoopRuleFields {
	mode: string;
	prompt?: string;
	issue_id?: string;
}

function loopRules(loop: LoopRuleFields, ctx: z.RefinementCtx): void {
	// ralph run takes its task as a prompt; the other modes use the
	// checkout's own prompts, so a prompt there would be silently ignored.
	if (loop.mode === 'run' && loop.prompt === undefined) {
		ctx.addIssue({ code: 'custom', path: ['prompt'], message: 'a run loop needs a prompt' });
	}
	if (loop.mode !== 'run' && loop.prompt !== undefined) {
		ctx.addIssue({ code: 'custom', path: ['prompt'], message: 'only a run loop takes a prompt' });
	}
	// ralph narrows build (and records run) to one bead; plan and reverse
	// work on the whole project (ADR-0019 rule 6).
	if (loop.issue_id !== undefined && loop.mode !== 'build' && loop.mode !== 'run') {
		ctx.addIssue({
			code: 'custom',
			path: ['issue_id'],
			message: 'only a build or run loop works on one bead'
		});
	}
}

/** Every launch operation's fields plus `envelope`, extra keys refused. */
function launchSchema<E extends z.ZodRawShape>(envelope: E) {
	return z.discriminatedUnion('operation', [
		z.object({ ...file_launch_shape, ...agent_choice_shape, ...envelope }).strict(),
		z.object({ ...tackle_launch_shape, ...agent_choice_shape, ...envelope }).strict(),
		z.object({ ...comment_launch_shape, ...agent_choice_shape, ...envelope }).strict(),
		z.object({ ...discuss_launch_shape, ...agent_choice_shape, ...envelope }).strict(),
		z
			.object({ ...loop_launch_shape, ...agent_choice_shape, ...envelope })
			.strict()
			.superRefine((loop, ctx) => loopRules(loop as LoopRuleFields, ctx))
	]);
}

/** Body of `POST /api/projects/:id/dispatch`. */
export const dispatch_schema = launchSchema({
	provider: dispatch_provider_schema,
	idempotency_key: z.string().regex(IDEMPOTENCY_KEY_PATTERN, 'invalid idempotency key')
});

/** One launch's fields without its envelope: what an automation fires. */
export const launch_schema = launchSchema({});
export type LaunchBody = z.infer<typeof launch_schema>;

export const automation_id_schema = z.string().regex(/^au_[a-f0-9]{32}$/, 'invalid automation id');

const automation_schedule_shape = {
	cron: z.string().trim().min(1).max(CRON_MAX_LENGTH),
	time_zone: z.string().trim().min(1).max(64)
};

/** Body of `POST /api/automations` (ADR-0019 rule 7). Extra keys fail closed. */
export const automation_create_schema = z
	.object({
		project_id: project_id_schema,
		name: z.string().trim().min(1).max(AUTOMATION_NAME_MAX),
		...automation_schedule_shape,
		overlap: z.enum(AUTOMATION_OVERLAPS).default('skip'),
		provider: dispatch_provider_schema,
		launch: launch_schema
	})
	.strict();

/** Body of `PATCH /api/automations/:id`: pause or resume. */
export const automation_patch_schema = z.object({ enabled: z.boolean() }).strict();

/** Query of `GET /api/automations`. */
export const automations_query_schema = z.object({ project: project_id_schema.optional() });

/** Query of `GET /api/automations/preview`. */
export const automation_preview_schema = z.object(automation_schedule_shape);

export const dispatch_request_id_schema = z
	.string()
	.regex(/^dq_[a-f0-9]{32}$/, 'invalid dispatch request id');

/** Body of `POST /api/projects/:id/dispatch/:requestId/follow-up`. Extra keys fail closed. */
export const follow_up_schema = z
	.object({
		text: z.string().trim().min(1).max(FOLLOW_UP_TEXT_MAX)
	})
	.strict();

/** Body of `POST /api/projects/:id/dispatch/:requestId/steer`. Extra keys fail closed. */
export const steer_schema = z
	.object({
		text: z.string().trim().min(1).max(RALPH_STEER_MAX_LENGTH)
	})
	.strict();

/**
 * Body of `POST /api/projects/:id/dispatch/:requestId/restart`: an optional
 * iteration limit for the new run only. Extra keys fail closed.
 */
export const restart_schema = z
	.object({
		max_iterations: z.number().int().min(1).max(LOOP_MAX_ITERATIONS).optional()
	})
	.strict();

/** Body of `PUT /api/console/projects/:id/tackle-map`. Extra keys fail closed. */
export const tackle_map_schema = z
	.object({
		url: z.string().trim().min(1).max(500),
		ref: z.string().trim().min(1).max(255).optional(),
		auto_create_pr: z.boolean().optional()
	})
	.strict();

/** Body of `PUT /api/console/projects/:id/file-map`. Extra keys fail closed. */
export const file_map_schema = z
	.object({
		url: z.string().trim().min(1).max(500),
		ref: z.string().trim().min(1).max(255).optional()
	})
	.strict();

/** Body of `PUT /api/console/dispatch`. Extra keys fail closed. */
export const dispatch_arm_schema = z.object({ armed: z.boolean() }).strict();

/**
 * Body of `PUT /api/console/backups` (ADR-0010). Settings are optional; a
 * secret string sets it, `null` clears it, absence keeps it. Extra keys fail
 * closed.
 */
export const backup_settings_schema = z
	.object({
		enabled: z.boolean().optional(),
		endpoint: z
			.string()
			.trim()
			.max(256)
			.transform((value, ctx) => {
				const normal = normalizeEndpoint(value);
				if (normal === undefined) {
					ctx.addIssue({ code: 'custom', message: 'endpoint must be http(s)://host with no path' });
					return z.NEVER;
				}
				return normal;
			})
			.optional(),
		bucket: z
			.string()
			.trim()
			.regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'invalid bucket name')
			.optional(),
		region: z
			.string()
			.trim()
			.regex(/^[a-z0-9-]{1,32}$/, 'invalid region')
			.optional(),
		url_style: z.enum(['virtual-host', 'path']).optional(),
		prefix: z
			.string()
			.trim()
			.max(128)
			.transform((value) => value.replace(/^\/+|\/+$/g, ''))
			.refine(
				(value) =>
					value === '' ||
					(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(value) &&
						!value.split('/').some((part) => part === '.' || part === '..')),
				'invalid prefix'
			)
			.optional(),
		interval_hours: z.number().int().min(1).max(168).optional(),
		keep_runs: z.number().int().min(1).max(365).optional(),
		access_key_id: z.string().trim().min(1).max(128).regex(/^\S+$/).nullable().optional(),
		secret_access_key: z.string().trim().min(1).max(256).regex(/^\S+$/).nullable().optional(),
		passphrase: z
			.string()
			.min(12, 'passphrase must be at least 12 characters')
			.max(1024)
			.nullable()
			.optional()
	})
	.strict();

/** Body of `PUT /api/console/projects/:id/allow`. Extra keys fail closed. */
export const dispatch_allow_schema = z
	.object({
		file: z.boolean(),
		tackle: z.boolean()
	})
	.strict();

/**
 * Apply the same GitHub URL / ref rules as env maps. Returns undefined
 * instead of throwing so callers can persist nothing.
 * @param body Validated console map body.
 */
export function parseTackleMapBody(
	body: z.infer<typeof tackle_map_schema>
): TackleRepositoryMapping | undefined {
	const url = parseGitHubRepositoryUrl(body.url);
	if (url === undefined) {
		return undefined;
	}
	let ref = 'main';
	if (body.ref !== undefined) {
		const parsed_ref = parseGitRef(body.ref);
		if (parsed_ref === undefined) {
			return undefined;
		}
		ref = parsed_ref;
	}
	return {
		url,
		ref,
		auto_create_pr: body.auto_create_pr ?? true
	};
}

/**
 * Apply the same GitHub URL / ref rules as Tackle maps. File maps never
 * store auto_create_pr.
 * @param body Validated File checkout body.
 */
export function parseFileMapBody(
	body: z.infer<typeof file_map_schema>
): FileCheckoutMapping | undefined {
	const url = parseGitHubRepositoryUrl(body.url);
	if (url === undefined) {
		return undefined;
	}
	let ref = 'main';
	if (body.ref !== undefined) {
		const parsed_ref = parseGitRef(body.ref);
		if (parsed_ref === undefined) {
			return undefined;
		}
		ref = parsed_ref;
	}
	return { url, ref };
}

/** Result of a validation attempt: either data, or a response to return. */
export type ParseResult<T> = { ok: true; data: T } | { ok: false; response: Response };

/** Summarise a zod failure without leaking input values. */
export function describeIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.join('.');
			return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
		})
		.join('; ');
}

/** Validate an already-parsed value. */
export function parseValue<T>(schema: z.ZodType<T>, value: unknown): ParseResult<T> {
	const result = schema.safeParse(value);
	if (!result.success) {
		return { ok: false, response: errorResponse('bad_request', describeIssues(result.error)) };
	}
	return { ok: true, data: result.data };
}

/** Read and validate a JSON request body. */
export async function parseJsonBody<T>(
	request: Request,
	schema: z.ZodType<T>
): Promise<ParseResult<T>> {
	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return { ok: false, response: errorResponse('bad_request', 'invalid JSON body') };
	}
	return parseValue(schema, payload);
}

/** Validate query-string parameters. */
export function parseQuery<T>(params: URLSearchParams, schema: z.ZodType<T>): ParseResult<T> {
	const record: Record<string, string> = {};
	for (const [key, value] of params) {
		record[key] = value;
	}
	return parseValue(schema, record);
}

// --- Admin todos ---------------------------------------------

/** `+project` / `@context` style tag, or a bare word. */
export const todo_tag_schema = z
	.string()
	.trim()
	.regex(/^[+@]?[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/, 'invalid tag');
export const todo_due_schema = z
	.string()
	.refine(
		(value) =>
			/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(value) &&
			!Number.isNaN(Date.parse(value)),
		'due_at must be an ISO date or datetime'
	);
export const todo_priority_schema = z.number().int().min(0).max(4);
export const todo_tags_schema = z.array(todo_tag_schema).max(16);

export const todo_id_schema = z.string().regex(/^td_[a-f0-9]{24}$/, 'invalid todo id');

export const todo_comment_id_schema = z.string().regex(/^tc_[a-f0-9]{24}$/, 'invalid comment id');

/** Query of `GET /api/todos`. `status` defaults to `open`; `all` lifts the filter. */
export const todos_query_schema = z.object({
	status: z.enum(['open', 'done', 'archived', 'all']).default('open'),
	tag: todo_tag_schema.optional(),
	q: z.string().max(200).optional(),
	limit: z.coerce.number().int().min(1).max(500).default(200)
});

/** Body of `POST /api/todos`. */
export const create_todo_schema = z
	.object({
		title: z.string().trim().min(1).max(300),
		body: z.string().max(20_000).nullable().optional(),
		priority: todo_priority_schema.optional(),
		due_at: todo_due_schema.nullable().optional(),
		tags: todo_tags_schema.optional(),
		sort_key: z.number().finite().optional()
	})
	.strict();

/** Body of `PATCH /api/todos/:id`; at least one field. */
export const update_todo_schema = z
	.object({
		title: z.string().trim().min(1).max(300).optional(),
		body: z.string().max(20_000).nullable().optional(),
		priority: todo_priority_schema.optional(),
		due_at: todo_due_schema.nullable().optional(),
		tags: todo_tags_schema.optional(),
		status: z.enum(['open', 'done', 'archived']).optional(),
		sort_key: z.number().finite().optional()
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, 'no fields to update');

/** Body of `POST /api/todos/:id/comments`. */
export const create_todo_comment_schema = z
	.object({ text: z.string().trim().min(1).max(4000) })
	.strict();

/** Body of `POST /api/todos/:id/route`. The payload itself is built server-side. */
export const route_todo_schema = z
	.object({ project_id: project_id_schema, notes: z.string().trim().max(2000).optional() })
	.strict();

/** Body of `PUT /api/todos/filters`: saved searches, name → query. */
export const todo_filters_schema = z
	.object({
		filters: z.record(z.string().trim().min(1).max(60), z.string().max(200))
	})
	.strict()
	.refine((value) => Object.keys(value.filters).length <= 50, 'at most 50 saved searches');

// --- First Mate chats ----------------------------------------

export const mate_chat_id_schema = z.string().regex(CHAT_ID_PATTERN, 'invalid chat id');

const mate_title_schema = z.string().trim().min(1).max(200);

/** Body of `POST /api/mate/chats`. */
export const create_mate_chat_schema = z
	.object({
		title: mate_title_schema.optional(),
		scope: project_id_schema.nullable().default(null),
		/** Where the chat runs; must be configured. Omitted: the default runner. */
		runner: z.enum(MATE_RUNNER_IDS).optional(),
		/** Checked against the operator's list by the route, as a launch's is. */
		...agent_choice_shape
	})
	.strict();

/** Body of `PATCH /api/mate/chats/:id`; at least one field. */
export const update_mate_chat_schema = z
	.object({
		title: mate_title_schema.optional(),
		scope: project_id_schema.nullable().optional()
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, 'no fields to update');

/** Body of `POST /api/mate/chats/:id/messages`. */
export const mate_message_schema = z
	.object({
		text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
		message_id: z
			.string()
			.regex(MESSAGE_ID_PATTERN, 'invalid message id')
			// Crew notices are Beadsmith's own messages; a browser may not pose as one.
			.refine((id) => !id.startsWith(CREW_NOTICE_PREFIX), 'invalid message id')
			.optional()
	})
	.strict();

/** A runner event id, as `?after=` or Last-Event-ID. */
export const mate_event_id_schema = z
	.string()
	.regex(/^[A-Za-z0-9._:-]{1,128}$/, 'invalid event id');

// --- Admin terminal relay (ADR-0021 rule 4) -------------------------------

const relay_cells_schema = z.number().int().min(1).max(1000);

/**
 * Body of `POST /api/console/terminals`: exactly one of a mission or a chat
 * (never a sandbox or terminal address), how to attach, and the viewer's grid.
 */
export const open_terminal_relay_schema = z
	.object({
		mission: dispatch_request_id_schema.optional(),
		chat: mate_chat_id_schema.optional(),
		mode: z.enum(['watch', 'take_over']),
		cols: relay_cells_schema,
		rows: relay_cells_schema
	})
	.strict()
	.refine(
		(value) => (value.mission === undefined) !== (value.chat === undefined),
		'name exactly one of mission or chat'
	);

export const terminal_relay_id_schema = z
	.string()
	.regex(/^tr_[a-f0-9]{32}$/, 'invalid terminal relay id');

/** Body of `POST /api/console/terminals/:relay`: base64 keystrokes, a new size, or both. */
export const terminal_relay_input_schema = z
	.object({
		data: z
			.string()
			.max(65_536)
			.regex(/^[A-Za-z0-9+/]*={0,2}$/, 'data must be base64')
			.optional(),
		cols: relay_cells_schema.optional(),
		rows: relay_cells_schema.optional()
	})
	.strict()
	.refine((value) => (value.cols === undefined) === (value.rows === undefined), {
		message: 'send cols and rows together'
	})
	.refine((value) => value.data !== undefined || value.cols !== undefined, {
		message: 'send data or a size'
	});
