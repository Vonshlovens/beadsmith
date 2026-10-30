import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Service-local schema. Beads projects, workspace paths, and Dolt or agent
 * runner credentials never enter this database. Dispatch rows are control-plane
 * metadata only. Backup credentials live sealed inside the `backup.config`
 * setting (ADR-0010). Account passwords exist only as one-way scrypt hashes
 * in `auth_account.password` (ADR-0011).
 */
export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

/**
 * Operator-edited Tackle GitHub checkouts. Env/file maps remain an override.
 * Never store credentials here.
 */
export const tackleRepositoryMaps = sqliteTable('tackle_repository_maps', {
	projectId: text('project_id').primaryKey(),
	url: text('url').notNull(),
	ref: text('ref').notNull(),
	autoCreatePr: integer('auto_create_pr', { mode: 'boolean' }).notNull(),
	updatedAt: text('updated_at').notNull()
});

/**
 * Optional per-project File GitHub checkouts. Distinct from Tackle maps: no
 * PR flag and no env overlay. Never store credentials here.
 */
export const fileCheckoutMaps = sqliteTable('file_checkout_maps', {
	projectId: text('project_id').primaryKey(),
	url: text('url').notNull(),
	ref: text('ref').notNull(),
	updatedAt: text('updated_at').notNull()
});

/**
 * Per-project File vs Tackle allow. Global arm lives in settings
 * (`dispatch.armed`). Never store credentials here.
 */
export const dispatchProjectAllows = sqliteTable('dispatch_project_allows', {
	projectId: text('project_id').primaryKey(),
	fileAllowed: integer('file_allowed', { mode: 'boolean' }).notNull(),
	tackleAllowed: integer('tackle_allowed', { mode: 'boolean' }).notNull(),
	updatedAt: text('updated_at').notNull()
});

export const dispatchRequests = sqliteTable('dispatch_requests', {
	id: text('id').primaryKey(),
	idempotencyKey: text('idempotency_key').notNull().unique(),
	projectId: text('project_id').notNull(),
	doltDatabase: text('dolt_database').notNull(),
	operation: text('operation').notNull(),
	actor: text('actor').notNull(),
	payloadJson: text('payload_json').notNull(),
	status: text('status').notNull(),
	provider: text('provider'),
	agentId: text('agent_id'),
	agentUrl: text('agent_url'),
	runId: text('run_id'),
	errorMessage: text('error_message'),
	resultSummary: text('result_summary'),
	durationMs: integer('duration_ms'),
	gitPrUrl: text('git_pr_url'),
	createdAt: text('created_at').notNull(),
	updatedAt: text('updated_at').notNull()
});

/**
 * Conversation turns per mission: operator messages and each finished run's
 * reply. Never the launch prompt or raw worker logs. Indexes live in
 * `DISPATCH_TURNS_SCHEMA_SQL` (one agent turn per run).
 */
export const dispatchTurns = sqliteTable('dispatch_turns', {
	seq: integer('seq').primaryKey(),
	requestId: text('request_id').notNull(),
	role: text('role').notNull(),
	text: text('text').notNull(),
	runId: text('run_id'),
	status: text('status'),
	createdAt: text('created_at').notNull()
});

/** One scheduled or manual backup run (ADR-0010). No credentials. */
export const backupRuns = sqliteTable('backup_runs', {
	id: text('id').primaryKey(),
	trigger: text('trigger').notNull(),
	status: text('status').notNull(),
	startedAt: text('started_at').notNull(),
	finishedAt: text('finished_at'),
	databases: integer('databases').notNull().default(0),
	bytes: integer('bytes').notNull().default(0),
	location: text('location'),
	pruned: integer('pruned').notNull().default(0),
	error: text('error')
});

/**
 * Admin todo list. Application-owned rows, never Beads issue
 * documents: a routed todo keeps only project, dispatch and issue id
 * references. `tags` is a JSON array of strings; urgency is derived, not
 * stored. Keep in step with `TODO_SCHEMA_SQL` in `todos/store.ts`.
 */
export const todos = sqliteTable(
	'todos',
	{
		id: text('id').primaryKey(),
		title: text('title').notNull(),
		body: text('body'),
		priority: integer('priority').notNull().default(2),
		dueAt: text('due_at'),
		tags: text('tags').notNull().default('[]'),
		status: text('status').notNull().default('open'),
		completedAt: text('completed_at'),
		sortKey: real('sort_key').notNull().default(0),
		routedProjectId: text('routed_project_id'),
		routedDispatchId: text('routed_dispatch_id'),
		routedIssueId: text('routed_issue_id'),
		createdBy: text('created_by').notNull(),
		createdAt: text('created_at').notNull(),
		updatedAt: text('updated_at').notNull()
	},
	(table) => [index('todos_status_due').on(table.status, table.dueAt)]
);

/** One comment in a todo's thread. */
export const todoComments = sqliteTable(
	'todo_comments',
	{
		id: text('id').primaryKey(),
		todoId: text('todo_id').notNull(),
		author: text('author').notNull(),
		text: text('text').notNull(),
		createdAt: text('created_at').notNull()
	},
	(table) => [index('todo_comments_todo').on(table.todoId, table.createdAt)]
);

/** Bead ids runners reported per routing dispatch. */
export const todoRouteIssues = sqliteTable('todo_route_issues', {
	dispatchId: text('dispatch_id').primaryKey(),
	issueId: text('issue_id').notNull(),
	reportedAt: text('reported_at').notNull()
});

// --- Accounts (Better Auth, ADR-0011) ----------------------------------------
// Property names are Better Auth's field names (the Drizzle adapter addresses
// columns by them); SQL names follow this file's snake_case convention. Keep
// in step with `AUTH_SCHEMA_SQL` in `auth/store.ts`.

/** One Beadsmith account. `role` is `admin` or `member` (admin plugin). */
export const authUser = sqliteTable('auth_user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
	image: text('image'),
	role: text('role'),
	banned: integer('banned', { mode: 'boolean' }).default(false),
	banReason: text('ban_reason'),
	banExpires: integer('ban_expires', { mode: 'timestamp_ms' }),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
});

/** A signed-in browser. The cookie carries `token`, HMAC-signed. */
export const authSession = sqliteTable(
	'auth_session',
	{
		id: text('id').primaryKey(),
		token: text('token').notNull().unique(),
		userId: text('user_id')
			.notNull()
			.references(() => authUser.id, { onDelete: 'cascade' }),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),
		impersonatedBy: text('impersonated_by'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	(table) => [index('auth_session_user_id_idx').on(table.userId)]
);

/**
 * Sign-in methods per account. Email+password rows use provider
 * `credential` and keep only a scrypt hash in `password`; the token columns
 * stay empty until a social provider is configured.
 */
export const authAccount = sqliteTable(
	'auth_account',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id').notNull(),
		providerId: text('provider_id').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => authUser.id, { onDelete: 'cascade' }),
		accessToken: text('access_token'),
		refreshToken: text('refresh_token'),
		idToken: text('id_token'),
		accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
		refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
		scope: text('scope'),
		password: text('password'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	(table) => [index('auth_account_user_id_idx').on(table.userId)]
);

/** Short-lived Better Auth verification values. */
export const authVerification = sqliteTable(
	'auth_verification',
	{
		id: text('id').primaryKey(),
		identifier: text('identifier').notNull(),
		value: text('value').notNull(),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	(table) => [index('auth_verification_identifier_idx').on(table.identifier)]
);

/** The schema object handed to Better Auth's Drizzle adapter, keyed by model. */
export const authSchema = {
	user: authUser,
	session: authSession,
	account: authAccount,
	verification: authVerification
};
// --- end accounts ------------------------------------------------------------

export type SettingRow = typeof settings.$inferSelect;
export type TackleRepositoryMapRow = typeof tackleRepositoryMaps.$inferSelect;
export type FileCheckoutMapRow = typeof fileCheckoutMaps.$inferSelect;
export type DispatchProjectAllowRow = typeof dispatchProjectAllows.$inferSelect;
export type DispatchRequestRow = typeof dispatchRequests.$inferSelect;
export type BackupRunRow = typeof backupRuns.$inferSelect;
