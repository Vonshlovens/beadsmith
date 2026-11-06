import { describe, expect, it } from 'vitest';
import type { Project } from '#lib/types.js';
import { sortProjects } from './project-sort';

function project(name: string, extra: Partial<Project> = {}): Project {
	return { id: `d_${name}`, name, state: 'remote', readonly: true, ...extra } as Project;
}

const counts = (open: number) => ({ open, in_progress: 0, blocked: 0, closed: 0, total: open });

describe('sortProjects', () => {
	it('sorts counts descending and keeps unreadable projects last', () => {
		const rows = sortProjects(
			[project('a', { counts: counts(1) }), project('b'), project('c', { counts: counts(5) })],
			'open',
			true
		);
		expect(rows.map((row) => row.name)).toEqual(['c', 'a', 'b']);
	});

	it('keeps unreadable projects last ascending too', () => {
		const rows = sortProjects(
			[project('b'), project('a', { counts: counts(1) }), project('c', { counts: counts(5) })],
			'open',
			false
		);
		expect(rows.map((row) => row.name)).toEqual(['a', 'c', 'b']);
	});

	it('sorts by recency, newest first, with missing activity last', () => {
		const rows = sortProjects(
			[
				project('old', { last_activity: '2026-10-01T00:00:00Z' }),
				project('none'),
				project('new', { last_activity: '2026-11-01T00:00:00Z' })
			],
			'last_activity',
			true
		);
		expect(rows.map((row) => row.name)).toEqual(['new', 'old', 'none']);
	});

	it('breaks ties by name and does not mutate the input', () => {
		const input = [project('b', { counts: counts(2) }), project('a', { counts: counts(2) })];
		const rows = sortProjects(input, 'open', true);
		expect(rows.map((row) => row.name)).toEqual(['a', 'b']);
		expect(input.map((row) => row.name)).toEqual(['b', 'a']);
	});
});
