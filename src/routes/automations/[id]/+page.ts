/** One automation: its schedule, next fire times and run history. */
import { api, errorMessage } from '#lib/client/api.js';
import type { AutomationDetailResponse } from '#lib/automations.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	let detail: AutomationDetailResponse | null = null;
	let error: string | null = null;
	try {
		detail = await api.automation(params.id, { fetch });
	} catch (thrown) {
		error = errorMessage(thrown);
	}
	return { detail, error, id: params.id };
};
