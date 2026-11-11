/**
 * First Mate's command palette over Beadsmith HTTP.
 *
 * Read queries (Ready, Missions, Go) never launch an agent. File and Tackle
 * reuse the dispatch dialogs; "Ask an agent" opens the issue agent dialog.
 * Missions open as threads on the First Mate page. Actions are local to this
 * browser (theme, rail, copy, the Recent changes drawer) or ordinary
 * Beadsmith requests (add a todo, refresh projects, sign out); none of them
 * launches an agent either.
 */
import { dueLabel } from '#lib/todos/dates.js';
import { parseCapture } from '#lib/todos/parse.js';

export type FirstMateView = 'commands' | 'ready' | 'missions' | 'file-project' | 'tackle-pick';

export type FirstMateIntent =
	| { kind: 'commands' }
	| { kind: 'ready' }
	| { kind: 'missions' }
	| { kind: 'file' }
	| { kind: 'tackle'; issue_id?: string };

export type FirstMateGroup = 'Jump' | 'Recent' | 'Ask' | 'Dispatch' | 'Go' | 'Actions' | 'Search';

/** Group order in the palette. */
export const FIRST_MATE_GROUP_ORDER: FirstMateGroup[] = [
	'Jump',
	'Recent',
	'Ask',
	'Dispatch',
	'Go',
	'Actions',
	'Search'
];

/** Palette actions that stay in the browser or make an ordinary request. */
export type FirstMateLocalAction =
	| 'activity'
	| 'shortcuts'
	| 'theme-light'
	| 'theme-dark'
	| 'theme-system'
	| 'rail'
	| 'refresh-projects'
	| 'sign-out';

export type FirstMateAction =
	| { type: 'view'; view: Exclude<FirstMateView, 'commands'> }
	| { type: 'navigate'; href: string }
	| { type: 'file'; project_id: string }
	| { type: 'tackle'; project_id: string; issue_id: string; issue_title: string }
	| { type: 'agent'; project_id: string; issue_id: string; issue_title: string }
	| { type: 'pick_file_project' }
	| { type: 'local'; action: FirstMateLocalAction }
	| { type: 'copy'; text: string; what: string }
	| {
			type: 'todo';
			title: string;
			priority: number;
			due_at: string | null;
			tags: string[];
	  };

export interface FirstMateCommand {
	id: string;
	group: FirstMateGroup;
	title: string;
	hint: string;
	keywords: string[];
	/** True for File, Tackle and Ask an agent. Ready/Missions/Go stay on GET. */
	launches_agent: boolean;
	action: FirstMateAction;
	/** The key sequence that does the same thing outside the palette, e.g. `g t`. */
	shortcut?: string;
}

/** An issue this browser opened lately (src/lib/client/recent-issues.ts). */
export interface FirstMateRecentIssue {
	project_id: string;
	issue_id: string;
	title: string;
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
	/** Admins see Todos and Console, and may add todos. */
	is_admin?: boolean;
	/** The stored theme preference, so the palette offers the other two. */
	theme?: 'system' | 'light' | 'dark';
	/** The desktop rail is collapsed. */
	rail_collapsed?: boolean;
	/** Absolute URL of the page under the palette, for Copy link. */
	page_url?: string;
	/** Newest first. */
	recent_issues?: FirstMateRecentIssue[];
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

/**
 * One mission's thread on the First Mate page, where a launch lands.
 *
 * @param project_id - The mission's project.
 * @param request_id - The mission.
 */
export function missionThreadHref(project_id: string, request_id: string): string {
	return `${FIRST_MATE_PATH}?thread=${encodeURIComponent(request_id)}&project=${encodeURIComponent(project_id)}`;
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

	const go = (
		id: string,
		title: string,
		href: string,
		keywords: string[],
		shortcut?: string
	): FirstMateCommand => {
		return {
			id,
			group: 'Go',
			title,
			hint: href,
			keywords,
			launches_agent: false,
			action: { type: 'navigate', href },
			...(shortcut ? { shortcut } : {})
		};
	};

	if (ctx.current_project_id) {
		const name = ctx.current_project_name ?? ctx.current_project_id;
		commands.push(
			go(
				'go-issues',
				`Issues in ${name}`,
				`/p/${ctx.current_project_id}`,
				['issues', 'list', 'parade', name],
				'g i'
			),
			go(
				'go-board',
				`Board for ${name}`,
				`/p/${ctx.current_project_id}?view=board`,
				['board', 'kanban', 'columns', name],
				'g b'
			)
		);
	}
	if (ctx.is_admin) {
		commands.push(go('go-todos', 'Todos', '/todos', ['todos', 'agenda', 'home', 'tasks'], 'g t'));
	}
	if (!ctx.on_first_mate_page) {
		commands.push(
			go('go-first-mate', 'First Mate', FIRST_MATE_PATH, ['first mate', 'chat', 'ask'], 'g f')
		);
	}
	commands.push(
		go('go-ready', 'Ready', '/ready', ['ready', 'deck', 'unblocked'], 'g r'),
		go('go-projects', 'Projects', '/projects', ['projects', 'catalog', 'databases'], 'g p'),
		go('go-missions', 'Missions', '/missions', ['missions', 'fleet', 'agents', 'runs'], 'g m'),
		go('go-activity', 'Activity log', '/activity', ['activity', 'events', 'history', 'log'], 'g a')
	);
	if (ctx.is_admin) {
		commands.push(
			go('go-console', 'Console', '/console', ['console', 'operator', 'maps', 'backups'], 'g c')
		);
	}
	commands.push(go('go-account', 'Account', '/account', ['account', 'password', 'profile']));

	for (const project of ctx.projects) {
		if (project.id === ctx.current_project_id) {
			continue;
		}
		commands.push(
			go(`go-project-${project.id}`, project.name, `/p/${project.id}`, [
				'project',
				project.id,
				project.name
			])
		);
	}

	commands.push(...actionCommands(ctx));
	return [...recentCommands(ctx), ...commands];
}

/**
 * The browser-side actions: the drawer, theme, rail, copy, refresh, sign out.
 *
 * @param ctx - Route and preferences.
 */
export function actionCommands(ctx: FirstMateContext): FirstMateCommand[] {
	const local = (
		id: string,
		title: string,
		hint: string,
		action: FirstMateLocalAction,
		keywords: string[],
		shortcut?: string
	): FirstMateCommand => {
		return {
			id,
			group: 'Actions',
			title,
			hint,
			keywords,
			launches_agent: false,
			action: { type: 'local', action },
			...(shortcut ? { shortcut } : {})
		};
	};
	const rows: FirstMateCommand[] = [
		local(
			'act-activity',
			'Recent changes',
			'What changed lately, one line per issue',
			'activity',
			['recent', 'changes', 'activity', 'feed', 'what changed'],
			'.'
		),
		local(
			'act-shortcuts',
			'Keyboard shortcuts',
			'Every key this page answers',
			'shortcuts',
			['keys', 'keyboard', 'shortcuts', 'help', 'hotkeys'],
			'?'
		)
	];
	const theme = ctx.theme ?? 'system';
	if (theme !== 'light') {
		rows.push(
			local('act-theme-light', 'Use the light theme', 'Paper and ink', 'theme-light', [
				'theme',
				'light',
				'appearance'
			])
		);
	}
	if (theme !== 'dark') {
		rows.push(
			local('act-theme-dark', 'Use the dark theme', 'Onyx and cream', 'theme-dark', [
				'theme',
				'dark',
				'appearance',
				'night'
			])
		);
	}
	if (theme !== 'system') {
		rows.push(
			local(
				'act-theme-system',
				'Follow the system theme',
				'Light or dark with your OS',
				'theme-system',
				['theme', 'auto', 'system', 'appearance']
			)
		);
	}
	rows.push(
		local(
			'act-rail',
			ctx.rail_collapsed ? 'Expand the navigation rail' : 'Collapse the navigation rail',
			'Sidebar width',
			'rail',
			['sidebar', 'rail', 'navigation', 'collapse', 'expand'],
			'['
		)
	);
	if (ctx.current_issue_id) {
		rows.push({
			id: 'act-copy-id',
			group: 'Actions',
			title: `Copy issue ID ${ctx.current_issue_id}`,
			hint: 'For bd or a commit message',
			keywords: ['copy', 'id', 'clipboard', ctx.current_issue_id],
			launches_agent: false,
			action: { type: 'copy', text: ctx.current_issue_id, what: 'Issue ID' }
		});
	}
	if (ctx.page_url) {
		rows.push({
			id: 'act-copy-link',
			group: 'Actions',
			title: 'Copy a link to this page',
			hint: 'With its filters',
			keywords: ['copy', 'link', 'url', 'share', 'clipboard'],
			launches_agent: false,
			action: { type: 'copy', text: ctx.page_url, what: 'Link' }
		});
	}
	rows.push(
		local(
			'act-refresh-projects',
			'Refresh projects',
			'Look for new or removed Beads databases',
			'refresh-projects',
			['refresh', 'rescan', 'projects', 'reload', 'databases']
		),
		local('act-sign-out', 'Sign out', 'End this session', 'sign-out', [
			'sign out',
			'log out',
			'logout'
		])
	);
	return rows;
}

/**
 * Recently opened issues, newest first, minus the one already on screen.
 *
 * @param ctx - Carries the recent list and the current issue.
 */
export function recentCommands(ctx: FirstMateContext): FirstMateCommand[] {
	const names = new Map(ctx.projects.map((project) => [project.id, project.name]));
	return (ctx.recent_issues ?? [])
		.filter((issue) => {
			return !(
				issue.issue_id === ctx.current_issue_id && issue.project_id === ctx.current_project_id
			);
		})
		.filter((issue) => names.has(issue.project_id))
		.slice(0, 5)
		.map((issue) => {
			const project_name = names.get(issue.project_id) ?? issue.project_id;
			return {
				id: `recent-${issue.project_id}-${issue.issue_id}`,
				group: 'Recent' as const,
				title: issue.title,
				hint: `${issue.issue_id} · ${project_name}`,
				keywords: [issue.issue_id, project_name, 'recent'],
				launches_agent: false,
				action: { type: 'navigate' as const, href: `/p/${issue.project_id}/i/${issue.issue_id}` }
			};
		});
}

const TODO_PREFIX = /^(?:add (?:a )?todo|new todo|todo)\s*:?\s+/i;

/**
 * Rows the typed text itself offers: jump to an issue ID, add a todo, search
 * issues, or ask First Mate. Shown above (ID, todo) or below (search, ask)
 * the matching commands.
 *
 * @param ctx - Projects and the current route.
 * @param raw - Palette input.
 * @param now - Reference time for todo dates.
 */
export function queryCommands(
	ctx: FirstMateContext,
	raw: string,
	now: Date = new Date()
): { lead: FirstMateCommand[]; tail: FirstMateCommand[] } {
	const text = raw.trim();
	const lead: FirstMateCommand[] = [];
	const tail: FirstMateCommand[] = [];
	if (text.length === 0) {
		return { lead, tail };
	}

	// A bare issue ID: open it. Its prefix rarely names the project, so the
	// project in view comes first, then any project a recent visit tied the
	// prefix to, then the rest.
	if (ISSUE_ID.test(text) && /\d/.test(text.slice(text.lastIndexOf('-') + 1))) {
		const prefix = text.slice(0, text.lastIndexOf('-') + 1).toLowerCase();
		const known = (ctx.recent_issues ?? []).find((issue) => {
			return issue.issue_id.toLowerCase().startsWith(prefix);
		})?.project_id;
		const order = [...ctx.projects].sort((a, b) => {
			const rank = (id: string) => {
				if (id === known) return 0;
				if (id === ctx.current_project_id) return 1;
				return 2;
			};
			return rank(a.id) - rank(b.id);
		});
		for (const project of order.slice(0, known || ctx.current_project_id ? 1 : 4)) {
			lead.push({
				id: `jump-${project.id}-${text}`,
				group: 'Jump',
				title: `Open ${text}`,
				hint: `in ${project.name}`,
				keywords: [text],
				launches_agent: false,
				action: { type: 'navigate', href: `/p/${project.id}/i/${encodeURIComponent(text)}` }
			});
		}
	}

	// Only an admin gets the add-todo row; for anyone else "todo …" is
	// ordinary text and still offers search and ask.
	const todo = ctx.is_admin ? text.match(TODO_PREFIX) : null;
	if (todo) {
		const parsed = parseCapture(text.slice(todo[0].length), now);
		if (parsed.title.length > 0) {
			const details = parsed.tokens.map((token) => {
				return token.kind === 'due' ? `due ${dueLabel(token.value, now)}` : token.value;
			});
			lead.push({
				id: 'todo-add',
				group: 'Jump',
				title: `Add todo: ${parsed.title}`,
				hint: details.length > 0 ? details.join(' · ') : `P${parsed.priority}, no date`,
				keywords: [text],
				launches_agent: false,
				action: {
					type: 'todo',
					title: parsed.title,
					priority: parsed.priority,
					due_at: parsed.due_at,
					tags: parsed.tags
				}
			});
		}
	}

	const search_project =
		ctx.projects.find((project) => project.id === ctx.current_project_id) ?? ctx.projects[0];
	if (search_project && !todo) {
		tail.push({
			id: 'search-issues',
			group: 'Search',
			title: `Search issues for “${text}”`,
			hint: `in ${search_project.name}`,
			keywords: [text],
			launches_agent: false,
			action: {
				type: 'navigate',
				href: `/p/${search_project.id}?q=${encodeURIComponent(text)}`
			}
		});
	}
	if (!todo) {
		tail.push({
			id: 'ask-chat',
			group: 'Search',
			title: `Ask First Mate: “${text}”`,
			hint: 'Opens a chat with this question',
			keywords: [text],
			launches_agent: false,
			action: { type: 'navigate', href: firstMatePageHref(text, null) }
		});
	}
	return { lead, tail };
}

/**
 * Everything the command list shows for a query: what the text offers, the
 * matching commands, then search and ask.
 *
 * @param ctx - Route and allow flags.
 * @param query - Palette input.
 * @param now - Reference time for todo dates.
 */
export function paletteRows(
	ctx: FirstMateContext,
	query: string,
	now: Date = new Date()
): FirstMateCommand[] {
	const matched = filterCommands(defaultCommands(ctx), query);
	const { lead, tail } = queryCommands(ctx, query, now);
	return sortByGroup([...lead, ...matched, ...tail]);
}

/**
 * Rows in palette group order, keeping their order within a group, so the
 * order the arrow keys walk is the order on screen.
 *
 * @param rows - Any order.
 */
export function sortByGroup(rows: FirstMateCommand[]): FirstMateCommand[] {
	const rank = (row: FirstMateCommand) => FIRST_MATE_GROUP_ORDER.indexOf(row.group);
	return rows
		.map((row, index) => ({ row, index }))
		.sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
		.map((entry) => entry.row);
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
