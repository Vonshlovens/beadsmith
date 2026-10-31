/**
 * Wire types shared by server and client. Mirrors `docs/contract.md` §Wire types.
 * This file must stay free of runtime code.
 */

/** Every project exposed by the web service is a remote Dolt database. */
export type ProjectState = 'remote';

export type ProjectBackend = 'server-sql';

export interface ProjectCounts {
	open: number;
	in_progress: number;
	blocked: number;
	closed: number;
	total: number;
}

export interface Project {
	id: string;
	/** Remote Dolt database name. */
	name: string;
	state: ProjectState;
	dolt_database: string;
	backend: ProjectBackend;
	/** The web service never mutates Beads lifecycle state. */
	readonly: true;
	counts?: ProjectCounts;
	/** ISO timestamp */
	last_activity?: string;
	/** File/Tackle allow for this project. Omitted when policy could not be loaded. */
	allow?: DispatchProjectAllow;
}

export interface IssueSummary {
	id: string;
	title: string;
	status: string;
	priority: number;
	issue_type: string;
	assignee?: string;
	owner?: string;
	labels: string[];
	created_at: string;
	updated_at: string;
	dependency_count: number;
	dependent_count: number;
	comment_count: number;
}

export interface IssueRef {
	id: string;
	title?: string;
	status?: string;
	priority?: number;
	issue_type?: string;
	dep_type?: string;
}

export interface IssueComment {
	id: string;
	author: string;
	text: string;
	created_at?: string;
}

export interface IssueDetail extends IssueSummary {
	description?: string;
	acceptance_criteria?: string;
	notes?: string;
	design?: string;
	created_by?: string;
	due_at?: string;
	defer_until?: string;
	estimate?: number;
	external_ref?: string;
	/** this issue depends on… */
	dependencies: IssueRef[];
	/** …and blocks/relates to */
	dependents: IssueRef[];
	comments: IssueComment[];
	metadata?: Record<string, unknown>;
}

export interface ActivityEvent {
	project_id: string;
	project_name: string;
	issue_id: string;
	issue_title?: string;
	event_type: string;
	actor: string;
	created_at: string;
}

/** Fixed, safe classes for remote Dolt connection failures. */
export type DoltFailureKind =
	'credential_unavailable' | 'authentication_rejected' | 'unreachable' | 'unknown';

export interface StatusSnapshot {
	/** The web process is always a remote Dolt read/control plane. */
	mode: 'remote';
	dolt: {
		configured: boolean;
		reachable: boolean;
		/** Present only when the latest connection probe failed. */
		failure_kind?: DoltFailureKind;
		latency_ms?: number;
	};
	state_db: { ok: boolean };
	agents: { active: boolean; count: number; last_actor?: string; last_seen?: string };
	/**
	 * `enabled` is key configured AND globally armed. Split fields let the
	 * console show the kill switch separately from the credential file.
	 */
	dispatch: DispatchHealth;
}

export type ConsoleTackleMapSource = 'env' | 'sqlite';

/** Per-project File vs Tackle allow. Missing rows default to both allowed. */
export interface DispatchProjectAllow {
	file: boolean;
	tackle: boolean;
}

/**
 * Agent dispatch providers this build can run. A new provider (for example
 * Overalls) adds its id here.
 */
export type DispatchProviderId = 'webhook';

/** Public dispatch health. No key material. */
export interface DispatchHealth {
	enabled: boolean;
	/** A usable dispatch provider is configured. */
	key_configured: boolean;
	armed: boolean;
	/**
	 * Whether this viewer may launch agents (role has dispatch:launch). False
	 * hides every agent control; absent means the server did not say.
	 */
	viewer_can_launch?: boolean;
	/** Active provider; `none` keeps the app read-only. */
	provider?: DispatchProviderId | 'none';
	/** Why the requested provider is inactive; a class, never a value. */
	provider_error?: 'invalid' | 'webhook_url_invalid' | 'webhook_secret_missing';
	/** What the active provider can do; absent when dispatch is off. */
	capabilities?: DispatchCapabilities;
}

/**
 * Optional provider features the agent console adapts to.
 * Launch and status polling are always available.
 */
export interface DispatchCapabilities {
	/** Streams run events (assistant text, tool calls) while the run works. */
	live_events: boolean;
	/** Accepts a follow-up message on a finished run. */
	follow_up: boolean;
	/** Can stop a run in flight. */
	cancel: boolean;
}

/** Public GitHub checkout shown on the operator console. Not a secret. */
export interface ConsoleTackleMapping {
	url: string;
	ref: string;
	auto_create_pr: boolean;
	source: ConsoleTackleMapSource;
}

/** Optional File checkout. Distinct from Tackle; no PR flag and no env overlay. */
export interface ConsoleFileMapping {
	url: string;
	ref: string;
}

/** One discovered catalog project plus Tackle map, File checkout, and allow. */
export interface ConsoleProjectRow {
	id: string;
	name: string;
	last_activity?: string;
	counts?: ProjectCounts;
	tackle: { mapped: false } | ({ mapped: true } & ConsoleTackleMapping);
	file: { mapped: false } | ({ mapped: true } & ConsoleFileMapping);
	allow: DispatchProjectAllow;
	/** Beads schema compatibility; absent when not inspected. */
	schema?: {
		status: 'supported' | 'untested' | 'unsupported';
		bd_version?: string;
		migration?: number;
		missing: string[];
	};
}

/** Configuration class sent to the operator console. Never names an env var. */
export type ConsoleAccessPolicyClass =
	'ok' | 'dolt_unconfigured' | 'incomplete' | 'invalid_service_token_id' | 'public_origin_error';

/**
 * Redacted Cloudflare Access surface. Service-token Client IDs that are
 * already configured may appear. JWTs, audience tags, and Client secrets
 * must not.
 */
export interface ConsoleAccess {
	issuer_host?: string;
	audience_configured: boolean;
	service_token_ids: string[];
	allowed_hosts: string[];
	public_origin?: string;
	policy: ConsoleAccessPolicyClass;
}

/** Redacted operator-console payload. No Dolt hosts, paths, passwords, or keys. */
export interface ConsoleSnapshot {
	health: {
		dolt: StatusSnapshot['dolt'];
		state_db: StatusSnapshot['state_db'];
		dispatch: DispatchHealth;
	};
	coverage: {
		project_count: number;
		mapped_count: number;
		unmapped_ids: string[];
		maps_invalid: boolean;
	};
	projects: ConsoleProjectRow[];
	access: ConsoleAccess;
}

export type ApiErrorCode =
	| 'bad_request'
	| 'unauthorized'
	| 'forbidden'
	| 'not_found'
	| 'conflict'
	| 'dolt_error'
	| 'rate_limited'
	| 'unavailable';

export interface ApiErrorBody {
	error: { code: ApiErrorCode; message: string; failure_kind?: DoltFailureKind };
}

export type IssueSource = 'sql';

export interface IssueListResponse {
	issues: IssueSummary[];
	source: IssueSource;
	readonly: boolean;
}

/** One unblocked open issue on the cross-project Ready deck. */
export interface ReadyIssue extends IssueSummary {
	project_id: string;
	project_name: string;
}

export interface ReadyListResponse {
	issues: ReadyIssue[];
	source: IssueSource;
	readonly: boolean;
}

export interface IssueDetailResponse {
	issue: IssueDetail;
	readonly: boolean;
}

export type DependencyType = 'blocks' | 'related' | 'parent-child' | 'discovered-from';

/** Stored UI theme preference (settings key `ui.theme`). */
export type ThemePreference = 'system' | 'light' | 'dark';

/** Lifecycle intent the control plane may enqueue for an agent. */
export type DispatchOperation = 'file' | 'tackle' | 'comment' | 'discuss';

/**
 * What a `discuss` mission asks of the agent: talk the issue through, rewrite
 * its description and acceptance criteria, or close it with a reason.
 */
export type DiscussIntent = 'discuss' | 'elaborate' | 'close';

/** Durable workflow state for a File/Tackle/comment request. */
export type DispatchStatus =
	'queued' | 'launching' | 'launched' | 'running' | 'succeeded' | 'cancelled' | 'failed';

export interface DispatchRequest {
	id: string;
	project_id: string;
	operation: DispatchOperation;
	/** Present on `discuss` missions. */
	intent?: DiscussIntent;
	status: DispatchStatus;
	/**
	 * Provider that launched the agent; absent before launch and on missions
	 * from a provider this build no longer has.
	 */
	provider?: DispatchProviderId;
	issue_id?: string;
	agent_id?: string;
	agent_url?: string;
	result_summary?: string;
	duration_ms?: number;
	git_pr_url?: string;
	created_at: string;
	updated_at: string;
	error_message?: string;
}

/**
 * Fleet view of a File/Tackle/comment run. Includes the launching actor and a
 * display title, but never File notes, comment text, Tackle description, or
 * the idempotency key.
 */
export interface Mission extends DispatchRequest {
	actor: string;
	project_name: string;
	title?: string;
}

/** One message in a mission's conversation. */
export interface DispatchTurn {
	seq: number;
	/** `operator` is the person in Beadsmith; `agent` is a finished run's reply. */
	role: 'operator' | 'agent';
	text: string;
	run_id?: string;
	/** Terminal run status on an agent turn. */
	status?: 'succeeded' | 'cancelled' | 'failed';
	created_at: string;
}

/** GET /api/projects/:id/dispatch/:requestId/turns. */
export interface DispatchTurnsResponse {
	turns: DispatchTurn[];
}

/** What `system` resolves to for the current viewer. */
export type ResolvedTheme = 'light' | 'dark';

/** Backup settings as the console API returns them; never secrets (ADR-0010). */
export interface BackupConfigView {
	enabled: boolean;
	endpoint: string;
	bucket: string;
	region: string;
	url_style: 'virtual-host' | 'path';
	prefix: string;
	interval_hours: number;
	keep_runs: number;
	configured: boolean;
	access_key_id_set: boolean;
	access_key_id_hint?: string;
	secret_access_key_set: boolean;
	passphrase_set: boolean;
}

export interface BackupRunView {
	id: string;
	trigger: 'manual' | 'schedule';
	status: 'running' | 'succeeded' | 'failed';
	started_at: string;
	finished_at?: string;
	databases: number;
	bytes: number;
	location?: string;
	pruned: number;
	error?: string;
}

export interface BackupsResponse {
	config: BackupConfigView;
	runs: BackupRunView[];
	running: boolean;
	master_key: 'file' | 'generated';
}

/** PUT /api/console/backups: secret string sets, null clears, absent keeps. */
export type BackupSettingsUpdate = Partial<
	Omit<
		BackupConfigView,
		| 'configured'
		| 'access_key_id_set'
		| 'access_key_id_hint'
		| 'secret_access_key_set'
		| 'passphrase_set'
	>
> & {
	access_key_id?: string | null;
	secret_access_key?: string | null;
	passphrase?: string | null;
};

// --- Accounts (ADR-0011) -----------------------------------------------------

export type AccountRole = 'admin' | 'member';

/** Who the shell is rendering for; `null` while signed out. */
export interface Viewer {
	role: AccountRole;
	email?: string;
	name?: string;
}

/** One account as the console lists it. Never a password hash or session. */
export interface AccountView {
	id: string;
	email: string;
	name: string;
	role: AccountRole;
	banned: boolean;
	created_at: string;
}

/** GET /api/console/accounts. */
export interface AccountsResponse {
	signup_open: boolean;
	users: AccountView[];
	min_password_length: number;
}
