/**
 * Operator console: catalog coverage, redacted health, and read-only Access.
 */
import { api, errorMessage } from '$lib/client/api';
import type { ConsoleSnapshot } from '$lib/types';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	let console_snapshot: ConsoleSnapshot | null = null;
	let error: string | null = null;

	try {
		console_snapshot = await api.console({ fetch });
	} catch (thrown) {
		error = errorMessage(thrown);
	}

	return { console_snapshot, error };
};
