import { z } from 'zod';
import { errorResponse } from './security.js';
import type { ThemePreference } from '$lib/types.js';
import type { FileCheckoutMapping } from './dispatch/file-maps.js';
import { parseGitHubRepositoryUrl, parseGitRef } from './dispatch/repositories.js';
import type { TackleRepositoryMapping } from './dispatch/repositories.js';
import { normalizeEndpoint } from './backup/s3.js';

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

const file_dispatch_schema = z
	.object({
		operation: z.literal('file'),
		idempotency_key: z.string().regex(IDEMPOTENCY_KEY_PATTERN, 'invalid idempotency key'),
		notes: z.string().trim().min(1).max(8000),
		title: z.string().trim().min(1).max(200).optional(),
		issue_type: z.enum(['bug', 'feature', 'task', 'epic', 'chore']).optional(),
		priority: z.number().int().min(0).max(4).optional(),
		labels: z.array(label_schema).max(8).optional(),
		status: z
			.enum(['open', 'in_progress', 'blocked', 'deferred', 'closed', 'pinned', 'hooked'])
			.optional()
	})
	.strict();

const tackle_dispatch_schema = z
	.object({
		operation: z.literal('tackle'),
		idempotency_key: z.string().regex(IDEMPOTENCY_KEY_PATTERN, 'invalid idempotency key'),
		issue_id: issue_id_schema,
		destination_status: z.enum(['open', 'in_progress', 'blocked', 'deferred', 'closed']).optional()
	})
	.strict();

const comment_dispatch_schema = z
	.object({
		operation: z.literal('comment'),
		idempotency_key: z.string().regex(IDEMPOTENCY_KEY_PATTERN, 'invalid idempotency key'),
		issue_id: issue_id_schema,
		text: z.string().trim().min(1).max(8000)
	})
	.strict();

const discuss_dispatch_schema = z
	.object({
		operation: z.literal('discuss'),
		idempotency_key: z.string().regex(IDEMPOTENCY_KEY_PATTERN, 'invalid idempotency key'),
		issue_id: issue_id_schema,
		intent: z.enum(['discuss', 'elaborate', 'close']),
		message: z.string().trim().min(1).max(FOLLOW_UP_TEXT_MAX).optional()
	})
	.strict();

/** Body of `POST /api/projects/:id/dispatch`. */
export const dispatch_schema = z.discriminatedUnion('operation', [
	file_dispatch_schema,
	tackle_dispatch_schema,
	comment_dispatch_schema,
	discuss_dispatch_schema
]);

export const dispatch_request_id_schema = z
	.string()
	.regex(/^dq_[a-f0-9]{32}$/, 'invalid dispatch request id');

/** Body of `POST /api/projects/:id/dispatch/:requestId/follow-up`. Extra keys fail closed. */
export const follow_up_schema = z
	.object({
		text: z.string().trim().min(1).max(FOLLOW_UP_TEXT_MAX)
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
const todo_tag_schema = z
	.string()
	.trim()
	.regex(/^[+@]?[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/, 'invalid tag');
const todo_due_schema = z
	.string()
	.refine(
		(value) =>
			/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(value) &&
			!Number.isNaN(Date.parse(value)),
		'due_at must be an ISO date or datetime'
	);
const todo_priority_schema = z.number().int().min(0).max(4);
const todo_tags_schema = z.array(todo_tag_schema).max(16);

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
