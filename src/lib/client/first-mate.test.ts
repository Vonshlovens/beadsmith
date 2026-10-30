import { describe, expect, it } from 'vitest';
import {
	defaultCommands,
	extractIssueId,
	firstMatePageHref,
	parsePinnedView,
	FIRST_MATE_PATH,
	fileProjectRows,
	filterCommands,
	findReadyIssue,
	isFirstMateHotkey,
	matchesQuery,
	missionRows,
	normalizeQuery,
	parseFirstMateQuery,
	readyRows,
	remainderAfterIntent,
	resolveView,
	catalogFetchForView,
	type FirstMateContext
} from './first-mate.js';

function ctx(overrides: Partial<FirstMateContext> = {}): FirstMateContext {
	return {
		dispatch_enabled: true,
		file_allowed: true,
		tackle_allowed: true,
		projects: [
			{ id: 'd_beads_web', name: 'beads-web', file_allowed: true, tackle_allowed: true },
			{ id: 'd_other', name: 'other', file_allowed: false, tackle_allowed: true }
		],
		...overrides
	};
}

describe('parseFirstMateQuery', () => {
	it('treats empty input as the command list', () => {
		expect(parseFirstMateQuery('')).toEqual({ kind: 'commands' });
		expect(parseFirstMateQuery('   ')).toEqual({ kind: 'commands' });
	});

	it('recognises ready questions without implying an agent launch', () => {
		for (const query of [
			'ready',
			'Ready',
			"what's ready",
			'what is ready',
			'whats ready',
			'show ready',
			'show the ready deck',
			'list ready work',
			'bd ready',
			'ready auth'
		]) {
			expect(parseFirstMateQuery(query), query).toEqual({ kind: 'ready' });
		}
	});

	it('recognises mission list questions', () => {
		expect(parseFirstMateQuery('missions')).toEqual({ kind: 'missions' });
		expect(parseFirstMateQuery('show the fleet')).toEqual({ kind: 'missions' });
		expect(parseFirstMateQuery('list missions')).toEqual({ kind: 'missions' });
	});

	it('recognises file and tackle prefixes', () => {
		expect(parseFirstMateQuery('file')).toEqual({ kind: 'file' });
		expect(parseFirstMateQuery('file an issue')).toEqual({ kind: 'file' });
		expect(parseFirstMateQuery('tackle')).toEqual({ kind: 'tackle', issue_id: undefined });
		expect(parseFirstMateQuery('tackle beads-web-s42.7')).toEqual({
			kind: 'tackle',
			issue_id: 'beads-web-s42.7'
		});
		expect(parseFirstMateQuery('start work beads-web-0ef')).toEqual({
			kind: 'tackle',
			issue_id: 'beads-web-0ef'
		});
	});

	it('does not treat unrelated words as dispatch', () => {
		expect(parseFirstMateQuery('filter')).toEqual({ kind: 'commands' });
		expect(parseFirstMateQuery('console')).toEqual({ kind: 'commands' });
		expect(parseFirstMateQuery('filename')).toEqual({ kind: 'commands' });
	});
});

describe('resolveView', () => {
	it('lets typed intents win over a pinned view', () => {
		expect(resolveView({ kind: 'ready' }, 'missions')).toBe('ready');
		expect(resolveView({ kind: 'commands' }, 'ready')).toBe('ready');
		expect(resolveView({ kind: 'commands' }, null)).toBe('commands');
		expect(resolveView({ kind: 'file' }, null)).toBe('file-project');
		expect(resolveView({ kind: 'tackle' }, null)).toBe('tackle-pick');
	});
});

describe('catalogFetchForView', () => {
	it('only GETs ready or missions', () => {
		expect(catalogFetchForView('ready')).toBe('ready');
		expect(catalogFetchForView('tackle-pick')).toBe('ready');
		expect(catalogFetchForView('missions')).toBe('missions');
		expect(catalogFetchForView('commands')).toBeNull();
		expect(catalogFetchForView('file-project')).toBeNull();
	});
});

describe('remainderAfterIntent', () => {
	it('strips the ready question and keeps a filter', () => {
		expect(remainderAfterIntent('what is ready auth', { kind: 'ready' })).toBe('auth');
		expect(remainderAfterIntent('ready', { kind: 'ready' })).toBe('');
	});

	it('strips a tackle prefix and issue id', () => {
		expect(
			remainderAfterIntent('tackle beads-web-s42.7 auth', {
				kind: 'tackle',
				issue_id: 'beads-web-s42.7'
			})
		).toBe('auth');
	});
});

describe('extractIssueId', () => {
	it('pulls a Beads id off the end of a phrase', () => {
		expect(extractIssueId('tackle beads-web-s42.7')).toBe('beads-web-s42.7');
		expect(extractIssueId('beads-web-0ef')).toBe('beads-web-0ef');
		expect(extractIssueId('hello')).toBeUndefined();
	});
});

describe('isFirstMateHotkey', () => {
	const base = { key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

	it('accepts Cmd+K and Ctrl+K', () => {
		expect(isFirstMateHotkey({ ...base, metaKey: true })).toBe(true);
		expect(isFirstMateHotkey({ ...base, ctrlKey: true })).toBe(true);
		expect(isFirstMateHotkey({ ...base, key: 'K', metaKey: true })).toBe(true);
	});

	it('rejects modifiers, repeats, and composition', () => {
		expect(isFirstMateHotkey(base)).toBe(false);
		expect(isFirstMateHotkey({ ...base, metaKey: true, shiftKey: true })).toBe(false);
		expect(isFirstMateHotkey({ ...base, metaKey: true, altKey: true })).toBe(false);
		expect(isFirstMateHotkey({ ...base, metaKey: true, isComposing: true })).toBe(false);
		expect(isFirstMateHotkey({ ...base, metaKey: true, repeat: true })).toBe(false);
	});
});

describe('defaultCommands', () => {
	it('never marks Ask or Go rows as agent launches', () => {
		const commands = defaultCommands(ctx());
		for (const command of commands.filter((row) => row.group !== 'Dispatch')) {
			expect(command.launches_agent, command.id).toBe(false);
		}
		expect(commands.some((command) => command.id === 'ask-ready')).toBe(true);
		expect(commands.find((command) => command.id === 'ask-ready')?.action).toEqual({
			type: 'view',
			view: 'ready'
		});
	});

	it('hides File and Tackle when dispatch is disarmed', () => {
		const commands = defaultCommands(ctx({ dispatch_enabled: false }));
		expect(commands.some((command) => command.group === 'Dispatch')).toBe(false);
	});

	it('files in the current project when File is allowed', () => {
		const commands = defaultCommands(
			ctx({
				current_project_id: 'd_beads_web',
				current_project_name: 'beads-web',
				file_allowed: true
			})
		);
		const file = commands.find((command) => command.id === 'file-current');
		expect(file?.launches_agent).toBe(true);
		expect(file?.action).toEqual({ type: 'file', project_id: 'd_beads_web' });
	});

	it('tackles the open issue when Tackle is allowed', () => {
		const commands = defaultCommands(
			ctx({
				current_project_id: 'd_beads_web',
				current_issue_id: 'beads-web-s42.7',
				current_issue_title: 'First Mate',
				tackle_allowed: true
			})
		);
		const tackle = commands.find((command) => command.id === 'tackle-current');
		expect(tackle?.launches_agent).toBe(true);
		expect(tackle?.action).toEqual({
			type: 'tackle',
			project_id: 'd_beads_web',
			issue_id: 'beads-web-s42.7',
			issue_title: 'First Mate'
		});
	});
});

describe('filterCommands', () => {
	it('keeps ready ask when the query is ready', () => {
		const commands = filterCommands(defaultCommands(ctx()), 'ready');
		expect(commands.some((command) => command.id === 'ask-ready')).toBe(true);
		expect(commands.some((command) => command.id === 'go-ready')).toBe(true);
		expect(commands.some((command) => command.id === 'go-console')).toBe(false);
	});
});

describe('readyRows', () => {
	const issues = [
		{
			id: 'beads-web-s42.7',
			title: 'First Mate officer chat',
			priority: 2,
			issue_type: 'feature',
			project_id: 'd_beads_web',
			project_name: 'beads-web'
		},
		{
			id: 'other-1',
			title: 'Denied',
			priority: 1,
			issue_type: 'task',
			project_id: 'd_other',
			project_name: 'other'
		}
	];

	it('opens issues without launching an agent', () => {
		const rows = readyRows(issues, 'open', { d_beads_web: true, d_other: true });
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.launches_agent === false)).toBe(true);
		expect(rows[0]?.action).toEqual({
			type: 'navigate',
			href: '/p/d_beads_web/i/beads-web-s42.7'
		});
	});

	it('only offers Tackle on allowed projects', () => {
		const rows = readyRows(issues, 'tackle', { d_beads_web: true, d_other: false });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.launches_agent).toBe(true);
		expect(rows[0]?.action).toEqual({
			type: 'tackle',
			project_id: 'd_beads_web',
			issue_id: 'beads-web-s42.7',
			issue_title: 'First Mate officer chat'
		});
	});
});

describe('missionRows and fileProjectRows', () => {
	it('opens a mission as its First Mate thread without launching anything', () => {
		const rows = missionRows([
			{
				id: 'dq_1',
				operation: 'tackle',
				status: 'running',
				project_id: 'd_beads_web',
				project_name: 'beads-web',
				issue_id: 'beads-web-s42.7',
				title: 'First Mate'
			}
		]);
		expect(rows[0]?.launches_agent).toBe(false);
		expect(rows[0]?.action).toEqual({
			type: 'navigate',
			href: '/first-mate?thread=dq_1&project=d_beads_web'
		});
	});

	it('only lists projects allowed to File', () => {
		const rows = fileProjectRows(ctx().projects);
		expect(rows.map((row) => row.action)).toEqual([{ type: 'file', project_id: 'd_beads_web' }]);
		expect(rows[0]?.launches_agent).toBe(true);
	});
});

describe('helpers', () => {
	it('normalises and matches tokens', () => {
		expect(normalizeQuery('  What   IS  ')).toBe('what is');
		expect(matchesQuery('Ready deck /ready', 'ready')).toBe(true);
		expect(matchesQuery('Console', 'ready')).toBe(false);
	});

	it('finds a ready issue by id', () => {
		const issues = [
			{
				id: 'beads-web-s42.7',
				title: 'First Mate',
				priority: 2,
				issue_type: 'feature',
				project_id: 'd_beads_web',
				project_name: 'beads-web'
			}
		];
		expect(findReadyIssue(issues, 'BEADS-WEB-S42.7')?.title).toBe('First Mate');
		expect(findReadyIssue(issues, 'missing')).toBeUndefined();
	});
});

describe('parsePinnedView', () => {
	it('accepts the views the page can pin', () => {
		expect(parsePinnedView('ready')).toBe('ready');
		expect(parsePinnedView('missions')).toBe('missions');
		expect(parsePinnedView('file-project')).toBe('file-project');
		expect(parsePinnedView('tackle-pick')).toBe('tackle-pick');
	});

	it('ignores a missing or unknown view', () => {
		expect(parsePinnedView(null)).toBeNull();
		expect(parsePinnedView(undefined)).toBeNull();
		expect(parsePinnedView('')).toBeNull();
		expect(parsePinnedView('commands')).toBeNull();
		expect(parsePinnedView('nope')).toBeNull();
	});
});

describe('firstMatePageHref', () => {
	it('omits an empty query and the command list', () => {
		expect(firstMatePageHref('', null)).toBe(FIRST_MATE_PATH);
		expect(firstMatePageHref('   ', 'commands')).toBe(FIRST_MATE_PATH);
	});

	it('keeps the query and a real view', () => {
		expect(firstMatePageHref('ready', null)).toBe('/first-mate?q=ready');
		expect(firstMatePageHref('', 'tackle-pick')).toBe('/first-mate?view=tackle-pick');
		expect(firstMatePageHref('auth', 'ready')).toBe('/first-mate?q=auth&view=ready');
	});
});

describe('go-first-mate', () => {
	it('lists First Mate under Go', () => {
		const command = defaultCommands(ctx()).find((row) => row.id === 'go-first-mate');
		expect(command?.group).toBe('Go');
		expect(command?.launches_agent).toBe(false);
		expect(command?.action).toEqual({ type: 'navigate', href: '/first-mate' });
	});

	it('hides the command on the First Mate page', () => {
		const commands = defaultCommands(ctx({ on_first_mate_page: true }));
		expect(commands.some((row) => row.id === 'go-first-mate')).toBe(false);
	});
});
