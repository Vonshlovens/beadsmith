/**
 * One issue, with its dependencies, dependents and comments.
 *
 * When a list/board row has stashed a paint hint, `issue` is returned as a
 * promise so the detail page can mount immediately. Direct URLs and SSR
 * await the fetch so the header is real data, not an empty shell.
 */
import { browser } from '$app/environment';
import { error as kitError } from '@sveltejs/kit';
import { api, ApiError, errorMessage } from '$lib/client/api';
import { peekIssueSummaryHint } from '$lib/client/issue-summary-hint.js';
import type { IssueDetail, Mission } from '$lib/types.js';
import type { PageLoad } from './$types';

async function loadIssue(
	fetch_impl: typeof fetch,
	project_id: string,
	issue_id: string
): Promise<IssueDetail> {
	try {
		const response = await api.issue(project_id, issue_id, {
			fetch: fetch_impl
		});
		return response.issue;
	} catch (thrown) {
		// 400 is an id the API cannot read at all; for a page, that is "not found".
		if (thrown instanceof ApiError && (thrown.status === 404 || thrown.status === 400)) {
			kitError(404, `No issue ${issue_id} in this project.`);
		}
		throw thrown;
	}
}

async function loadMissions(
	fetch_impl: typeof fetch,
	project_id: string,
	issue_id: string
): Promise<{ missions: Mission[]; error: string | null }> {
	try {
		return {
			missions: (
				await api.missions(
					{ project_id, issue_id, limit: 20 },
					{
						fetch: fetch_impl
					}
				)
			).missions,
			error: null
		};
	} catch (thrown) {
		return { missions: [], error: errorMessage(thrown) };
	}
}

export const load: PageLoad = async ({ fetch, params }) => {
	const pending = loadIssue(fetch, params.id, params.issue_id);
	const stream = browser && peekIssueSummaryHint(params.issue_id) !== undefined;
	return {
		project_id: params.id,
		issue_id: params.issue_id,
		issue: stream ? pending : await pending,
		missions: loadMissions(fetch, params.id, params.issue_id)
	};
};
