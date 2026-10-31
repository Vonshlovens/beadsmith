import { describe, expect, it } from 'vitest';
import {
	cycleSort,
	groupByCompletion,
	groupByDue,
	parseSortMode,
	reorderPatches,
	sortTodos,
	tiesUnder,
	type SortableTodo
} from './sort.js';

const now = new Date(2026, 9, 28, 12);
let n = 0;
const todo = (over: Partial<SortableTodo> = {}): SortableTodo => ({
	id: `td_${++n}`,
	priority: 2,
	due_at: null,
	sort_key: n,
	created_at: `2026-10-0${n % 9}`,
	...over
});

describe('sort modes', () => {
	it('cycles urgency → due → priority → manual and wraps', () => {
		expect(cycleSort('urgency')).toBe('due');
		expect(cycleSort('due')).toBe('priority');
		expect(cycleSort('priority')).toBe('manual');
		expect(cycleSort('manual')).toBe('urgency');
		expect(cycleSort('urgency', -1)).toBe('manual');
		expect(parseSortMode('nope')).toBe('urgency');
		expect(parseSortMode('due')).toBe('due');
	});

	it('orders by each mode', () => {
		const a = todo({ priority: 3, due_at: '2026-10-28', sort_key: 3 });
		const b = todo({ priority: 0, due_at: null, sort_key: 2 });
		const c = todo({ priority: 1, due_at: '2026-11-20', sort_key: 1 });
		const ids = (mode: Parameters<typeof sortTodos>[1]) =>
			sortTodos([a, b, c], mode, now).map((t) => t.id);
		expect(ids('urgency')).toEqual([b.id, a.id, c.id]);
		expect(ids('due')).toEqual([a.id, c.id, b.id]);
		expect(ids('priority')).toEqual([b.id, c.id, a.id]);
		expect(ids('manual')).toEqual([c.id, b.id, a.id]);
	});
});

describe('reorder within ties', () => {
	it('swaps sort_key between tied neighbours', () => {
		const a = todo({ sort_key: 1 });
		const b = todo({ sort_key: 2 });
		expect(reorderPatches([a, b], 0, 1, 'urgency', now)).toEqual([
			{ id: a.id, sort_key: 2 },
			{ id: b.id, sort_key: 1 }
		]);
		expect(reorderPatches([a, b], 1, -1, 'priority', now)?.length).toBe(2);
	});

	it('refuses to cross a tie boundary or the list end', () => {
		const a = todo({ priority: 1 });
		const b = todo({ priority: 3 });
		expect(reorderPatches([a, b], 0, 1, 'priority', now)).toBeNull();
		expect(reorderPatches([a, b], 0, -1, 'manual', now)).toBeNull();
		expect(reorderPatches([a, b], 1, 1, 'manual', now)).toBeNull();
		expect(reorderPatches([a, b], 0, 1, 'manual', now)).not.toBeNull();
	});

	it('urgency ties need the same score and due date', () => {
		const a = todo({ priority: 2, due_at: '2026-10-28' });
		const b = todo({ priority: 2, due_at: '2026-10-29' });
		expect(tiesUnder('urgency', a, b, now)).toBe(false);
		expect(tiesUnder('due', a, b, now)).toBe(false);
		expect(tiesUnder('priority', a, todo({ priority: 2, due_at: '2026-10-28' }), now)).toBe(true);
	});

	it('nudges equal keys apart', () => {
		const a = todo({ sort_key: 5 });
		const b = todo({ sort_key: 5 });
		const [patch] = reorderPatches([a, b], 0, 1, 'manual', now)!;
		expect(patch).toEqual({ id: a.id, sort_key: 5.5 });
	});
});

describe('grouping', () => {
	it('groups by due bucket in agenda order and drops empty ones', () => {
		const groups = groupByDue(
			[
				todo({ due_at: '2026-10-20' }),
				todo({ due_at: '2026-10-28' }),
				todo({ due_at: '2026-12-01' }),
				todo()
			],
			now
		);
		expect(groups.map((g) => g.label)).toEqual(['Overdue', 'Today', 'Later', 'No date']);
	});

	it('groups done todos by local completion day, newest first', () => {
		const groups = groupByCompletion([
			{ id: 1, completed_at: '2026-10-26T12:00:00' },
			{ id: 2, completed_at: '2026-10-28T09:00:00' },
			{ id: 3, completed_at: '2026-10-28T15:00:00' }
		]);
		expect(groups.map((g) => g.key)).toEqual(['2026-10-28', '2026-10-26']);
		expect(groups[0].items.map((t) => t.id)).toEqual([3, 2]);
	});
});
