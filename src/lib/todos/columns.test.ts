import { describe, expect, it } from 'vitest';
import { groupIntoColumns } from './columns.js';
import { dueLabel } from './dates.js';

const NOW = new Date(2026, 9, 28, 12, 0, 0);
const t = (id: string, due_at: string | null, priority = 2) => ({ id, due_at, priority });
const ids = (list: { id: string }[]) => list.map((x) => x.id);

const TODOS = [
	t('overdue', '2026-10-20'),
	t('today', '2026-10-28'),
	t('today-p0', '2026-10-28', 0),
	t('tomorrow', '2026-10-29'),
	t('day7', '2026-11-04'),
	t('day8', '2026-11-05'),
	t('none', null)
];

describe('groupIntoColumns', () => {
	it('splits three columns with agenda.dev bucket rules', () => {
		const [now, week, later] = groupIntoColumns(TODOS, 3, NOW);
		expect(ids(now.todos)).toEqual(['today-p0', 'today', 'overdue']);
		expect(ids(week.todos)).toEqual(['tomorrow', 'day7']);
		expect(ids(later.todos).sort()).toEqual(['day8', 'none']);
	});

	it('splits two columns', () => {
		const [now, rest] = groupIntoColumns(TODOS, 2, NOW);
		expect(ids(now.todos)).toEqual(['today-p0', 'today', 'overdue']);
		expect(rest.todos).toHaveLength(4);
	});

	it('puts everything in one column by urgency', () => {
		const [all] = groupIntoColumns(TODOS, 1, NOW);
		expect(all.todos).toHaveLength(TODOS.length);
		expect(all.todos[0].id).toBe('today-p0');
	});

	it('orders by urgency inside a column', () => {
		const [now] = groupIntoColumns([t('a', '2026-10-28', 3), t('b', '2026-10-28', 1)], 3, NOW);
		expect(ids(now.todos)).toEqual(['b', 'a']);
	});
});

describe('dueLabel', () => {
	it.each([
		['2026-10-28', 'today'],
		['2026-10-29', 'tomorrow'],
		['2026-10-27', 'yesterday'],
		['2026-10-24', '4d overdue'],
		['2026-10-31', 'sat'],
		['2026-11-05', 'Nov 5'],
		['2027-01-02', 'Jan 2 2027']
	])('%s → %s', (due, label) => {
		expect(dueLabel(due, NOW)).toBe(label);
	});
	it('says no date', () => {
		expect(dueLabel(null, NOW)).toBe('no date');
	});

	it('orders a column by sort_key in manual order', () => {
		const keyed = [
			{ ...t('a', '2026-10-28', 2), sort_key: 3 },
			{ ...t('b', '2026-10-28', 0), sort_key: 2 },
			{ ...t('c', '2026-10-20', 4), sort_key: 1 }
		];
		const [now] = groupIntoColumns(keyed, 3, NOW, 'manual');
		expect(ids(now.todos)).toEqual(['c', 'b', 'a']);
	});
});
