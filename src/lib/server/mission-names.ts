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
 * Names of the surfaces and apps this viewer may see, by slug, so a mission
 * launched from one can link it (both open at `/views/<slug>`, and slugs are
 * unique across kinds). The grown store decides visibility (the viewer's own
 * and every published one), so an owner-private slug never reaches a member
 * or another admin (ADR-0025 rule 5). Empty when the store is unavailable:
 * the missions still list, without where they came from.
 * @param viewer The request's viewer.
 */
export async function missionSurfaceNames(viewer: GrownViewer): Promise<Map<string, string>> {
	try {
		const store = await getGrownStore();
		const things = (
			await Promise.all([store.list(viewer, 'surface'), store.list(viewer, 'app')])
		).flat();
		return new Map(things.map((thing) => [thing.slug, thing.revision.name]));
	} catch {
		return new Map();
	}
}
