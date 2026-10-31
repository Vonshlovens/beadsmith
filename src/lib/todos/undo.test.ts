import { describe, expect, it } from 'vitest';
import { snapshot, UNDO_LIMIT, UndoStack } from './undo.js';

const entry = (n: number) => ({
	label: `op ${n}`,
	restores: [{ id: `td_${n}`, fields: { priority: n } }]
});

describe('undo stack', () => {
	it('pops newest first', () => {
		const stack = new UndoStack();
		stack.push(entry(1));
		stack.push(entry(2));
		expect(stack.pop()?.label).toBe('op 2');
		expect(stack.pop()?.label).toBe('op 1');
		expect(stack.pop()).toBeUndefined();
	});

	it('keeps 50 levels, dropping the oldest', () => {
		const stack = new UndoStack();
		for (let n = 0; n < UNDO_LIMIT + 5; n++) stack.push(entry(n));
		expect(stack.size).toBe(UNDO_LIMIT);
		let last: string | undefined;
		for (let e = stack.pop(); e; e = stack.pop()) last = e.label;
		expect(last).toBe('op 5');
	});

	it('ignores empty entries and clears', () => {
		const stack = new UndoStack();
		stack.push({ label: 'nothing', restores: [] });
		expect(stack.size).toBe(0);
		stack.push(entry(1));
		stack.clear();
		expect(stack.size).toBe(0);
	});

	it('removes one entry wherever it sits', () => {
		const stack = new UndoStack();
		const failed = entry(1);
		stack.push(failed);
		stack.push(entry(2));
		stack.remove(failed);
		expect(stack.size).toBe(1);
		expect(stack.pop()?.label).toBe('op 2');
	});

	it('snapshots only the named fields', () => {
		expect(snapshot({ id: 'td_1', priority: 3 }, ['priority'])).toEqual({
			id: 'td_1',
			fields: { priority: 3 }
		});
	});
});
