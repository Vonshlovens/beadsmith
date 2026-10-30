/**
 * Issue list and board. Filters and `view` live in the URL so a filtered
 * list or board is shareable and survives a reload; they are passed to the
 * server and re-applied on the client so the count is right whichever the
 * server chose to honour. An omitted `view` is restored from per-project
 * localStorage on the client (explicit `?view=` always wins).
 *
 * Client navigations reuse the last successful list payload for a few
 * seconds so back-from-detail does not wait on SQL.
 */
import { browser } from '$app/environment';
import { api, errorMessage } from '$lib/client/api';
import { readListFilters, resolveIssueListPayload } from '$lib/client/issue-list-cache.js';
import { parseIssueView } from '$lib/client/issue-view';
import type { PageLoad } from './$types';

export type { ListFilters } from '$lib/client/issue-list-cache.js';

export const load: PageLoad = async ({ fetch, params, url }) => {
	const filters = readListFilters(url.searchParams);
	const view = parseIssueView(url.searchParams.get('view'));
	const payload = await resolveIssueListPayload({
		cache: browser,
		project_id: params.id,
		filters,
		fetchPayload: async () => {
			try {
				const response = await api.issues(
					params.id,
					{
						status: filters.status.join(',') || undefined,
						type: filters.type.join(',') || undefined,
						priority: filters.priority.join(',') || undefined,
						q: filters.q || undefined,
						include_closed: filters.include_closed
					},
					{ fetch }
				);
				return {
					issues: response.issues,
					source: response.source,
					readonly: response.readonly,
					error: null
				};
			} catch (thrown) {
				return {
					issues: [],
					source: 'sql',
					readonly: true,
					error: errorMessage(thrown)
				};
			}
		}
	});

	return { project_id: params.id, ...payload, filters, view };
};
