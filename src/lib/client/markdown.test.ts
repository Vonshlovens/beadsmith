import { describe, expect, it } from 'vitest';
import { extractToc, slugify, taskBox } from '$lib/client/markdown';

describe('extractToc', () => {
	it('returns nothing for an empty body', () => {
		expect(extractToc(undefined)).toEqual([]);
		expect(extractToc('')).toEqual([]);
	});

	it('lists headings with depth and anchor ids', () => {
		expect(extractToc('# Decision\n\nText.\n\n## Why `now`\n\nMore.')).toEqual([
			{ id: 'md-decision', text: 'Decision', depth: 1 },
			{ id: 'md-why-now', text: 'Why now', depth: 2 }
		]);
	});
});

describe('slugify', () => {
	it('keeps anchors stable and non-empty', () => {
		expect(slugify('Steps to Reproduce')).toBe('steps-to-reproduce');
		expect(slugify('!!!')).toBe('section');
	});
});

describe('taskBox', () => {
	it('says whether the task is done without an input element', () => {
		expect(taskBox(true)).toContain('is-done');
		expect(taskBox(true)).toContain('aria-label="done"');
		expect(taskBox(false)).not.toContain('is-done');
		expect(taskBox(false)).not.toContain('<input');
	});
});
