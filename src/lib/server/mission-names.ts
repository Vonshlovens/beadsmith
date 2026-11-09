import { discoverProjects } from './discovery.js';

/**
 * Display names for missions' projects, by project id. Empty when discovery
 * fails: missions live in SQLite, and a Dolt outage must not hide them, so
 * callers fall back to the mission's database name.
 */
export async function missionProjectNames(): Promise<Map<string, string>> {
	try {
		const projects = await discoverProjects();
		return new Map(projects.map((project) => [project.id, project.name]));
	} catch {
		return new Map();
	}
}
