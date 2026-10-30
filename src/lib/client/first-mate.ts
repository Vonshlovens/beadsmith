/**
 * First Mate's command palette over Beadsmith HTTP.
 *
 * Read queries (Ready, Missions, Go) never launch an agent. File and Tackle
 * reuse the dispatch dialogs; "Ask an agent" opens the issue agent dialog.
 * Missions open as threads on the First Mate page.
 */

export type FirstMateView = 'commands' | 'ready' | 'missions' | 'file-project' | 'tackle-pick';

export type FirstMateIntent =
	| { kind: 'commands' }
	| { kind: 'ready' }
	| { kind: 'missions' }
	| { kind: 'file' }
	| { kind: 'tackle'; issue_id?: string };

export type FirstMateGroup = 'Ask' | 'Dispatch' | 'Go';

export type FirstMateAction =
	| { type: 'view'; view: Exclude<FirstMateView, 'commands'> }
	| { type: 'navigate'; href: string }
	| { type: 'file'; project_id: string }
	| { type: 'tackle'; project_id: string; issue_id: string; issue_title: string }
	| { type: 'agent'; project_id: string; issue_id: string; issue_title: string }
	| { type: 'pick_file_project' };

export interface FirstMateCommand {
	id: string;
	group: FirstMateGroup;
	title: string;
	hint: string;
	keywords: string[];
	/** True for File, Tackle and Ask an agent. Ready/Missions/Go stay on GET. */
	launches_agent: boolean;
	action: FirstMateAction;
}

export interface FirstMateProject {
	id: string;
	name: string;
	file_allowed: boolean;
	tackle_allowed: boolean;
}

export interface FirstMateContext {
	current_project_id?: string;
	current_project_name?: string;
	current_issue_id?: string;
	current_issue_title?: string;
	dispatch_enabled: boolean;
	file_allowed: boolean;
	tackle_allowed: boolean;
	/** A provider is configured, so the agent dialog is worth offering. */
	agent_visible?: boolean;
	/** True on `/first-mate`, where Go → First Mate would only reload the page. */
	on_first_mate_page?: boolean;
	projects: FirstMateProject[];
}

export interface FirstMateReadyIssue {
	id: string;
	title: string;
	priority: number;
	issue_type: string;
	project_id: string;
	project_name: string;
}

export interface FirstMateMission {
	id: string;
	operation: string;
	status: string;
	project_id: string;
	project_name: string;
	issue_id?: string;
	title?: string;
}

/** Page that hosts the same console as the popup. */
export const FIRST_MATE_PATH = '/first-mate';

const PINNED_VIEWS = ['ready', 'missions', 'file-project', 'tackle-pick'] as const;

/**
 * A `?view=` value the page can pin. Anything else, including `commands`, is ignored.
 *
 * @param raw - Query value, or null when the parameter is absent.
 */
export function parsePinnedView(raw: string | null | undefined): FirstMateView | null {
	if (raw === undefined || raw === null || raw.length === 0) {
		return null;
	}
	return (PINNED_VIEWS as readonly string[]).includes(raw) ? (raw as FirstMateView) : null;
}

/**
 * Link to the First Mate page carrying the current query and view.
 * An empty query and the command list omit their parameters.
 *
 * @param query - Palette input.
 * @param view - Resolved view, or null on the command list.
 */
export function firstMatePageHref(query: string, view: FirstMateView | null): string {
	const params = new URLSearchParams();
	const q = query.trim();
	if (q.length > 0) {
		params.set('q', q);
	}
	if (view !== null && view !== 'commands') {
		params.set('view', view);
	}
	const search = params.toString();
	return search.length > 0 ? `${FIRST_MATE_PATH}?${search}` : FIRST_MATE_PATH;
}

const READY_PREFIX =
	/^(what(?:'s| is|s) ready|whats ready|show (?:the )?ready(?: work| queue| deck| issues?)?|list ready(?: work| issues?)?|bd ready|ready(?: work| queue| deck)?)\b/;

const MISSIONS_PREFIX =
	/^(what(?:'s| is|s) (?:the )?(?:missions?|fleet)|show (?:the )?(?:missions?|fleet)|list (?:the )?(?:missions?|fleet)|missions?|fleet)\b/;

const FILE_PREFIX = /^(file(?: an(?: new)? issue)?|file issue|launch filing(?: agent)?)\b/;

const TACKLE_PREFIX = /^(tackle|start work|launch tackling(?: agent)?)\b/;

const ISSUE_ID = /^[a-z][a-z0-9]*-[a-z0-9][a-z0-9.-]*$/i;

/**
 * Collapse user text for intent matching.
 *
 * @param raw - Palette input.
 */
export function normalizeQuery(raw: string): string {
	return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Pull a Beads issue id off the end of a query when present.
 *
 * @param raw - Palette input.
 */
export function extractIssueId(raw: string): string | undefined {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	for (let index = tokens.length - 1; index >= 0; index -= 1) {
		const token = tokens[index];
		if (token !== undefined && ISSUE_ID.test(token) && token.includes('-') && token.length >= 5) {
			return token;
		}
	}
	return undefined;
}

/**
 * Classify the palette query. Read intents never imply an agent launch.
 *
 * @param raw - Palette input.
 */
export function parseFirstMateQuery(raw: string): FirstMateIntent {
	const query = normalizeQuery(raw);
	if (query.length === 0) {
		return { kind: 'commands' };
	}
	if (READY_PREFIX.test(query)) {
		return { kind: 'ready' };
	}
	if (MISSIONS_PREFIX.test(query)) {
		return { kind: 'missions' };
	}
	if (FILE_PREFIX.test(query)) {
		return { kind: 'file' };
	}
	if (TACKLE_PREFIX.test(query)) {
		return { kind: 'tackle', issue_id: extractIssueId(raw) };
	}
	return { kind: 'commands' };
}

/**
 * View shown for a query, or a command the operator pinned with Enter.
 *
 * @param intent - Parsed query.
 * @param pinned - View chosen from the command list.
 */
export function resolveView(intent: FirstMateIntent, pinned: FirstMateView | null): FirstMateView {
	if (intent.kind === 'ready') {
		return 'ready';
	}
	if (intent.kind === 'missions') {
		return 'missions';
	}
	if (intent.kind === 'file') {
		return 'file-project';
	}
	if (intent.kind === 'tackle') {
		return 'tackle-pick';
	}
	return pinned ?? 'commands';
}

/**
 * Which catalog GET a view needs. Never a dispatch POST.
 *
 * @param view - Active palette view.
 */
export function catalogFetchForView(view: FirstMateView): 'ready' | 'missions' | null {
	if (view === 'ready' || view === 'tackle-pick') {
		return 'ready';
	}
	if (view === 'missions') {
		return 'missions';
	}
	return null;
}

/**
 * Text left after stripping a recognised intent prefix, used to filter rows.
 *
 * @param raw - Palette input.
 * @param intent - Parsed intent.
 */
export function remainderAfterIntent(raw: string, intent: FirstMateIntent): string {
	const query = normalizeQuery(raw);
	if (intent.kind === 'ready') {
		return query.replace(READY_PREFIX, '').trim();
	}
	if (intent.kind === 'missions') {
		return query.replace(MISSIONS_PREFIX, '').trim();
	}
	if (intent.kind === 'file') {
		return query.replace(FILE_PREFIX, '').trim();
	}
	if (intent.kind === 'tackle') {
		let rest = query.replace(TACKLE_PREFIX, '').trim();
		if (intent.issue_id) {
			rest = rest.replace(intent.issue_id.toLowerCase(), '').trim();
		}
		return rest;
	}
	return query;
}

/**
 * Cmd/Ctrl+K, ignoring Shift/Alt and IME composition.
 *
 * @param event - Keyboard event-like object.
 */
export function isFirstMateHotkey(event: {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	isComposing?: boolean;
	repeat?: boolean;
}): boolean {
	if (event.isComposing || event.repeat) {
		return false;
	}
	if (event.altKey || event.shiftKey) {
		return false;
	}
	if (event.key.toLowerCase() !== 'k') {
		return false;
	}
	return event.metaKey || event.ctrlKey;
}

/**
 * Whether a haystack contains every whitespace-separated token.
 *
 * @param haystack - Title, hint, and keywords.
 * @param query - Filter text.
 */
export function matchesQuery(haystack: string, query: string): boolean {
	const tokens = normalizeQuery(query).split(' ').filter(Boolean);
	if (tokens.length === 0) {
		return true;
	}
	const hay = normalizeQuery(haystack);
	return tokens.every((token) => hay.includes(token));
}

/**
 * Static palette commands for the current route and dispatch policy.
 *
 * @param ctx - Route and allow flags.
 */
export function defaultCommands(ctx: FirstMateContext): FirstMateCommand[] {
	const commands: FirstMateCommand[] = [
		{
			id: 'ask-ready',
			group: 'Ask',
			title: "What's ready?",
			hint: 'Unblocked work in every project',
			keywords: ['ready', 'unblocked', 'bd ready', 'ask'],
			launches_agent: false,
			action: { type: 'view', view: 'ready' }
		},
		{
			id: 'ask-missions',
			group: 'Ask',
			title: 'List missions',
			hint: 'Recent agent threads',
			keywords: ['missions', 'fleet', 'dispatch', 'ask'],
			launches_agent: false,
			action: { type: 'view', view: 'missions' }
		}
	];

	if (ctx.dispatch_enabled && ctx.file_allowed && ctx.current_project_id) {
		commands.push({
			id: 'file-current',
			group: 'Dispatch',
			title: `File an issue in ${ctx.current_project_name ?? ctx.current_project_id}`,
			hint: 'An agent files it with bd',
			keywords: ['file', 'create', 'new issue', 'dispatch'],
			launches_agent: true,
			action: { type: 'file', project_id: ctx.current_project_id }
		});
	} else if (ctx.dispatch_enabled && ctx.projects.some((project) => project.file_allowed)) {
		commands.push({
			id: 'file-pick',
			group: 'Dispatch',
			title: 'File an issue…',
			hint: 'Pick a project; an agent files it',
			keywords: ['file', 'create', 'new issue', 'dispatch'],
			launches_agent: true,
			action: { type: 'pick_file_project' }
		});
	}

	if (ctx.agent_visible && ctx.current_issue_id && ctx.current_project_id) {
		commands.push({
			id: 'agent-current',
			group: 'Dispatch',
			title: `Ask an agent about ${ctx.current_issue_id}`,
			hint: 'Discuss, elaborate, close or tackle',
			keywords: ['agent', 'discuss', 'elaborate', 'close', 'ask', ctx.current_issue_id],
			launches_agent: true,
			action: {
				type: 'agent',
				project_id: ctx.current_project_id,
				issue_id: ctx.current_issue_id,
				issue_title: ctx.current_issue_title ?? ctx.current_issue_id
			}
		});
	}

	if (
		ctx.dispatch_enabled &&
		ctx.tackle_allowed &&
		ctx.current_issue_id &&
		ctx.current_project_id
	) {
		commands.push({
			id: 'tackle-current',
			group: 'Dispatch',
			title: `Tackle ${ctx.current_issue_id}`,
			hint: ctx.current_issue_title ?? 'An agent claims it and does the work',
			keywords: ['tackle', 'start work', 'dispatch', ctx.current_issue_id],
			launches_agent: true,
			action: {
				type: 'tackle',
				project_id: ctx.current_project_id,
				issue_id: ctx.current_issue_id,
				issue_title: ctx.current_issue_title ?? ctx.current_issue_id
			}
		});
	} else if (ctx.dispatch_enabled && ctx.projects.some((project) => project.tackle_allowed)) {
		commands.push({
			id: 'tackle-pick',
			group: 'Dispatch',
			title: 'Tackle ready work…',
			hint: 'Pick an unblocked issue; an agent does the work',
			keywords: ['tackle', 'start work', 'dispatch', 'ready'],
			launches_agent: true,
			action: { type: 'view', view: 'tackle-pick' }
		});
	}

	if (!ctx.on_first_mate_page) {
		commands.push({
			id: 'go-first-mate',
			group: 'Go',
			title: 'First Mate',
			hint: FIRST_MATE_PATH,
			keywords: ['first mate', 'palette', 'officer', 'commands'],
			launches_agent: false,
			action: { type: 'navigate', href: FIRST_MATE_PATH }
		});
	}

	commands.push(
		{
			id: 'go-ready',
			group: 'Go',
			title: 'Ready',
			hint: '/ready',
			keywords: ['ready', 'deck', 'unblocked'],
			launches_agent: false,
			action: { type: 'navigate', href: '/ready' }
		},
		{
			id: 'go-missions',
			group: 'Go',
			title: 'Missions',
			hint: '/missions',
			keywords: ['missions', 'fleet'],
			launches_agent: false,
			action: { type: 'navigate', href: '/missions' }
		},
		{
			id: 'go-projects',
			group: 'Go',
			title: 'Projects',
			hint: '/',
			keywords: ['projects', 'home', 'catalog'],
			launches_agent: false,
			action: { type: 'navigate', href: '/' }
		},
		{
			id: 'go-activity',
			group: 'Go',
			title: 'Activity log',
			hint: '/activity',
			keywords: ['activity', 'events'],
			launches_agent: false,
			action: { type: 'navigate', href: '/activity' }
		},
		{
			id: 'go-console',
			group: 'Go',
			title: 'Console',
			hint: '/console',
			keywords: ['console', 'operator', 'maps'],
			launches_agent: false,
			action: { type: 'navigate', href: '/console' }
		}
	);

	for (const project of ctx.projects) {
		commands.push({
			id: `go-project-${project.id}`,
			group: 'Go',
			title: project.name,
			hint: `/p/${project.id}`,
			keywords: ['project', project.id, project.name],
			launches_agent: false,
			action: { type: 'navigate', href: `/p/${project.id}` }
		});
	}

	return commands;
}

/**
 * Filter commands by a free-text query.
 *
 * @param commands - Candidate rows.
 * @param query - Filter text.
 */
export function filterCommands(commands: FirstMateCommand[], query: string): FirstMateCommand[] {
	return commands.filter((command) =>
		matchesQuery(`${command.title} ${command.hint} ${command.keywords.join(' ')}`, query)
	);
}

/**
 * Ready rows for Ask (open) or Tackle-pick (enqueue after confirm).
 *
 * @param issues - GET /api/ready payload.
 * @param mode - Open the issue, or confirm Tackle.
 * @param tackle_by_project - Per-project Tackle allow.
 */
export function readyRows(
	issues: FirstMateReadyIssue[],
	mode: 'open' | 'tackle',
	tackle_by_project: Readonly<Record<string, boolean>>
): FirstMateCommand[] {
	const rows: FirstMateCommand[] = [];
	for (const issue of issues) {
		if (mode === 'tackle' && tackle_by_project[issue.project_id] !== true) {
			continue;
		}
		const hint = `P${issue.priority} · ${issue.issue_type} · ${issue.project_name}`;
		if (mode === 'tackle') {
			rows.push({
				id: `tackle-${issue.project_id}-${issue.id}`,
				group: 'Dispatch',
				title: `Tackle ${issue.id}`,
				hint: `${issue.title} · ${hint}`,
				keywords: [issue.id, issue.title, issue.project_name, issue.project_id],
				launches_agent: true,
				action: {
					type: 'tackle',
					project_id: issue.project_id,
					issue_id: issue.id,
					issue_title: issue.title
				}
			});
			continue;
		}
		rows.push({
			id: `ready-${issue.project_id}-${issue.id}`,
			group: 'Ask',
			title: issue.title,
			hint: `${issue.id} · ${hint}`,
			keywords: [issue.id, issue.title, issue.project_name, issue.project_id],
			launches_agent: false,
			action: {
				type: 'navigate',
				href: `/p/${issue.project_id}/i/${issue.id}`
			}
		});
	}
	return rows;
}

/**
 * Link to one mission's thread on the First Mate page.
 *
 * @param mission - Its id and project.
 */
export function threadHref(mission: { id: string; project_id: string }): string {
	const params = new URLSearchParams({ thread: mission.id, project: mission.project_id });
	return `${FIRST_MATE_PATH}?${params.toString()}`;
}

/**
 * Mission rows. Opening one shows its thread; it never launches a new agent.
 *
 * @param missions - GET /api/missions payload.
 */
export function missionRows(missions: FirstMateMission[]): FirstMateCommand[] {
	return missions.map((mission) => {
		const href = threadHref(mission);
		return {
			id: `mission-${mission.id}`,
			group: 'Ask' as const,
			title: mission.title ?? `${mission.operation} · ${mission.status}`,
			hint: `${mission.operation} · ${mission.status} · ${mission.project_name}`,
			keywords: [
				mission.operation,
				mission.status,
				mission.project_name,
				mission.project_id,
				mission.issue_id ?? '',
				mission.id
			],
			launches_agent: false,
			action: { type: 'navigate', href }
		};
	});
}

/**
 * Projects that may File, for the File picker view.
 *
 * @param projects - Catalog projects with allow flags.
 */
export function fileProjectRows(projects: FirstMateProject[]): FirstMateCommand[] {
	return projects
		.filter((project) => project.file_allowed)
		.map((project) => {
			return {
				id: `file-project-${project.id}`,
				group: 'Dispatch' as const,
				title: `File in ${project.name}`,
				hint: 'An agent files it with bd',
				keywords: [project.id, project.name, 'file'],
				launches_agent: true,
				action: { type: 'file' as const, project_id: project.id }
			};
		});
}

/**
 * Find a ready issue matching an explicit id.
 *
 * @param issues - Ready list.
 * @param issue_id - Typed Beads id.
 */
export function findReadyIssue(
	issues: FirstMateReadyIssue[],
	issue_id: string
): FirstMateReadyIssue | undefined {
	const wanted = issue_id.toLowerCase();
	return issues.find((issue) => issue.id.toLowerCase() === wanted);
}
