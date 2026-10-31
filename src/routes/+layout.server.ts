/**
 * Shell data: every screen needs the project list (switcher, rail) and the
 * health snapshot (status cluster). Load both directly on the server so status
 * can reuse the same discovery result instead of discovering projects again.
 *
 * Both failures are non-fatal — the shell still renders and the banners
 * explain what is missing. A signed-out visitor (only ever on the sign-in
 * page) gets none of it: no project name or count leaves before sign-in.
 */
import { discoverProjects } from '$lib/server/discovery.js';
import { DEFAULT_DISPATCH_ALLOW } from '$lib/server/dispatch/policy.js';
import { scrubSecretLines } from '$lib/server/security.js';
import { getDispatchPolicyStore } from '$lib/server/state/db.js';
import { getStatus, statusForViewer } from '$lib/server/status.js';
import type { Project, StatusSnapshot, Viewer } from '$lib/types.js';
import type { LayoutServerLoad } from './$types';

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Something went wrong.';
}

async function withDispatchAllows(projects: Project[]): Promise<Project[]> {
	try {
		const allows = await (await getDispatchPolicyStore()).listAllows();
		return projects.map((project) => {
			return {
				...project,
				allow: allows[project.id] ?? { ...DEFAULT_DISPATCH_ALLOW }
			};
		});
	} catch {
		return projects;
	}
}

/**
 * The viewer the shell renders for, from what `hooks.server.ts` established.
 * @param locals Request locals.
 */
function viewerFrom(locals: App.Locals): Viewer | null {
	if (locals.role === undefined) {
		return null;
	}
	return {
		role: locals.role,
		...(locals.user === undefined ? {} : { email: locals.user.email, name: locals.user.name })
	};
}

export const load: LayoutServerLoad = async ({ locals }) => {
	const viewer = viewerFrom(locals);
	if (viewer === null) {
		return { projects: [], projects_error: null, status: null, viewer };
	}

	let projects: Project[] = [];
	let projects_error: string | null = null;
	let status: StatusSnapshot | null = null;

	const discovery = discoverProjects();
	const [projects_result, status_result] = await Promise.allSettled([
		discovery,
		getStatus({ projects: () => discovery })
	]);

	if (projects_result.status === 'fulfilled') {
		projects = await withDispatchAllows(projects_result.value);
	} else {
		projects_error = scrubSecretLines(errorMessage(projects_result.reason)).trim();
	}

	if (status_result.status === 'fulfilled') {
		// Same masking as /api/status, so the first render agrees with later polls.
		status = statusForViewer(status_result.value, locals.role);
	}

	return { projects, projects_error, status, viewer };
};
