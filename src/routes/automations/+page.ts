/**
 * Automations across projects, or one project's with `?project=`.
 */
import { api, errorMessage } from '#lib/client/api.js';
import type { AutomationView } from '#lib/automations.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const project = url.searchParams.get('project') ?? undefined;
	let automations: AutomationView[] = [];
	let error: string | null = null;
	try {
		automations = (await api.automations({ project }, { fetch })).automations;
	} catch (thrown) {
		error = errorMessage(thrown);
	}
	return { automations, error, project };
};
