import { discoverProjects } from './discovery.js';
import type { GrownViewer } from './grown/store.js';
import { getGrownStore } from './state/db.js';

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

/**
 * Names of the surfaces this viewer may see, by slug, so a mission launched
 * from one can link it. The grown store decides visibility (the viewer's own
 * surfaces and every published one), so an owner-private surface's slug
 * never reaches a member or another admin (ADR-0025 rule 5). Empty when the
 * store is unavailable: the missions still list, without their surfaces.
 * @param viewer The request's viewer.
 */
export async function missionSurfaceNames(viewer: GrownViewer): Promise<Map<string, string>> {
	try {
		const surfaces = await (await getGrownStore()).list(viewer, 'surface');
		return new Map(surfaces.map((surface) => [surface.slug, surface.revision.name]));
	} catch {
		return new Map();
	}
}
