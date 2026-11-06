/**
 * Ordering for the projects table. Projects whose counts could not be read
 * sort after every readable one, whichever way the column runs: an unknown
 * count is not zero (docs/design-standards.md §2).
 */
import type { Project } from '#lib/types.js';

export type ProjectSortKey =
	'name' | 'open' | 'in_progress' | 'blocked' | 'closed' | 'total' | 'last_activity';

function value(project: Project, key: ProjectSortKey): string | number | undefined {
	if (key === 'name') return project.name.toLowerCase();
	if (key === 'last_activity') {
		const at = project.last_activity ? Date.parse(project.last_activity) : Number.NaN;
		return Number.isNaN(at) ? undefined : at;
	}
	return project.counts?.[key];
}

/**
 * A sorted copy of `projects`. Ties fall back to the name, so the order is stable.
 *
 * @param projects - The catalogue.
 * @param key - Column to sort by.
 * @param desc - Largest, newest or Z first.
 */
export function sortProjects(projects: Project[], key: ProjectSortKey, desc: boolean): Project[] {
	const direction = desc ? -1 : 1;
	return [...projects].sort((a, b) => {
		const left = value(a, key);
		const right = value(b, key);
		if (left === undefined && right !== undefined) return 1;
		if (right === undefined && left !== undefined) return -1;
		if (left !== undefined && right !== undefined && left !== right) {
			return left < right ? -direction : direction;
		}
		return a.name.localeCompare(b.name);
	});
}
