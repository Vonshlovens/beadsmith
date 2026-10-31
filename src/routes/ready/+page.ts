/**
 * Cross-project Ready deck: unblocked open work across catalog projects.
 */
import { api, errorMessage } from '$lib/client/api';
import type { ReadyIssue } from '$lib/types';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	let issues: ReadyIssue[] = [];
	let error: string | null = null;

	try {
		issues = (await api.ready(100, { fetch })).issues;
	} catch (thrown) {
		error = errorMessage(thrown);
	}

	return { issues, error };
};
