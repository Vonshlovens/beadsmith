import { describe, expect, it } from 'vitest';
import { dispatchBadgeKey, projectHealth } from './format.js';
import type { Project } from '$lib/types';

function project(overrides: Partial<Project> = {}): Project {
	return {
		id: 'd_demo',
		name: 'demo',
		state: 'remote',
		dolt_database: 'demo',
		backend: 'server-sql',
		readonly: true,
		...overrides
	};
}

describe('projectHealth', () => {
	it('does not badge a project whose counts loaded and that has issues', () => {
		expect(
			projectHealth(
				project({
					counts: { open: 2, in_progress: 1, blocked: 0, closed: 3, total: 6 }
				})
			)
		).toBeNull();
	});

	it('labels a project with zero issues as empty', () => {
		expect(
			projectHealth(
				project({
					counts: { open: 0, in_progress: 0, blocked: 0, closed: 0, total: 0 }
				})
			)
		).toEqual({ cls: 'health-ok', dot: 'dot-closed', label: 'Empty' });
	});

	it('labels a project whose counts did not load as unavailable', () => {
		expect(projectHealth(project())).toEqual({
			cls: 'health-warn',
			dot: 'dot-deferred',
			label: 'Unavailable'
		});
	});
});

describe('dispatchBadgeKey', () => {
	it('maps workflow states onto existing badge colours', () => {
		expect(dispatchBadgeKey('queued')).toBe('deferred');
		expect(dispatchBadgeKey('launching')).toBe('in_progress');
		expect(dispatchBadgeKey('launched')).toBe('hooked');
		expect(dispatchBadgeKey('running')).toBe('in_progress');
		expect(dispatchBadgeKey('succeeded')).toBe('closed');
		expect(dispatchBadgeKey('cancelled')).toBe('deferred');
		expect(dispatchBadgeKey('failed')).toBe('blocked');
	});
});
