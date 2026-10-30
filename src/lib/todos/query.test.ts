import { describe, expect, it } from 'vitest';
import {
	cycleFilter,
	defaultFilterName,
	dueRange,
	matchesQuery,
	parseSavedFilters,
	tagCounts
} from './query.js';
import { bodyLine, editLine, nextPriority, rawLine, toggleTag } from './lines.js';

const now = new Date(2026, 9, 28, 12);
const t = (over = {}) => ({
	title: 'Ship backups doc',
	priority: 1,
	due_at: '2026-10-30' as string | null,
	tags: ['+beadsmith', '@desk'],
	...over
});

describe('search', () => {
	it('matches words, tags and priority', () => {
		expect(matchesQuery(t(), '', now)).toBe(true);
		expect(matchesQuery(t(), 'BACKUPS ship', now)).toBe(true);
		expect(matchesQuery(t(), 'nope', now)).toBe(false);
		expect(matchesQuery(t(), '+beadsmith @desk', now)).toBe(true);
		expect(matchesQuery(t(), '+other', now)).toBe(false);
		expect(matchesQuery(t(), 'p1', now)).toBe(true);
		expect(matchesQuery(t(), 'p2', now)).toBe(false);
	});

	it('supports due ranges', () => {
		expect(dueRange('due:+1w', now)).toEqual(['2026-10-28', '2026-11-04']);
		expect(dueRange('due:-3d', now)).toEqual(['2026-10-25', '2026-10-28']);
		expect(dueRange('due:1w', now)).toEqual(['2026-10-28', '2026-11-04']);
		expect(dueRange('due:fri', now)).toBeUndefined();
		expect(matchesQuery(t(), 'due:+3d', now)).toBe(true);
		expect(matchesQuery(t(), 'due:+1d', now)).toBe(false);
		expect(matchesQuery(t({ due_at: null }), 'due:+1w', now)).toBe(false);
		expect(matchesQuery(t(), 'due:2026-10', now)).toBe(true);
	});
});

describe('tags and saved filters', () => {
	it('counts projects and contexts separately', () => {
		const list = [t(), t({ tags: ['+beadsmith'] }), t({ tags: ['+other', '@desk'] })];
		expect(tagCounts(list, '+')).toEqual([
			{ tag: '+beadsmith', count: 2 },
			{ tag: '+other', count: 1 }
		]);
		expect(tagCounts(list, '@')).toEqual([{ tag: '@desk', count: 2 }]);
	});

	it('cycles through none', () => {
		expect(cycleFilter(['a', 'b'], null, 1)).toBe('a');
		expect(cycleFilter(['a', 'b'], 'b', 1)).toBeNull();
		expect(cycleFilter(['a', 'b'], null, -1)).toBe('b');
		expect(cycleFilter([], null, 1)).toBeNull();
		expect(cycleFilter(['a'], 'gone', 1)).toBe('a');
	});

	it('parses stored filters defensively', () => {
		expect(parseSavedFilters('{"soon":"due:+1w","bad":3}')).toEqual({ soon: 'due:+1w' });
		expect(parseSavedFilters('[1]')).toEqual({});
		expect(parseSavedFilters('{{')).toEqual({});
		expect(parseSavedFilters(undefined)).toEqual({});
		expect(defaultFilterName('  +a   p1 ')).toBe('+a p1');
	});
});

describe('lines', () => {
	const todo = { ...t(), status: 'open', completed_at: null };
	it('formats todo.txt lines', () => {
		expect(rawLine(todo)).toBe('(B) Ship backups doc +beadsmith @desk due:2026-10-30');
		expect(
			rawLine({ ...todo, status: 'done', completed_at: '2026-10-28T10:00:00Z', due_at: null })
		).toBe('x 2026-10-28 (B) Ship backups doc +beadsmith @desk');
		expect(bodyLine(todo)).toBe('Ship backups doc');
		expect(editLine(todo)).toBe('Ship backups doc p1 due:2026-10-30 +beadsmith @desk');
	});

	it('cycles priority and toggles tags', () => {
		expect([0, 1, 4].map(nextPriority)).toEqual([1, 2, 0]);
		expect(toggleTag(['+a'], 'b', '@')).toEqual(['+a', '@b']);
		expect(toggleTag(['+a', '@b'], '@B', '@')).toEqual(['+a']);
		expect(toggleTag(['+a'], '  ', '+')).toEqual(['+a']);
	});
});
