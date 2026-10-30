/**
 * Classify an empty issue list so the page never paints silence for both
 * "this project has no issues" and "the load failed or filters hid everything".
 */
import type { ProjectCounts } from '$lib/types';

export type IssueListVacancyKind = 'empty' | 'closed_hidden' | 'filtered' | 'partial';

export type IssueListVacancyAction = 'clear_filters' | 'include_closed' | 'retry';

export interface IssueListVacancy {
	kind: IssueListVacancyKind;
	title: string;
	description: string;
	action?: IssueListVacancyAction;
}

export interface IssueListVacancyInput {
	/** Rows the list endpoint returned after its own filters. */
	issues_loaded: number;
	/** Rows still visible after client-side filters. */
	visible: number;
	include_closed: boolean;
	/** True when status, type, priority, or q is set. */
	has_filters: boolean;
	/** Discovery enrichment; absent when counts could not be loaded. */
	counts?: ProjectCounts;
}

/**
 * Describe why the issue table has no rows, or return null when it does.
 *
 * @param input - Loaded rows, visible rows, filters, and optional counts.
 */
export function describeIssueListVacancy(input: IssueListVacancyInput): IssueListVacancy | null {
	if (input.visible > 0) {
		return null;
	}

	if (input.has_filters || input.issues_loaded > 0) {
		return {
			kind: 'filtered',
			title: 'Nothing matches',
			description:
				input.issues_loaded > 0
					? `${input.issues_loaded} issues exist, but none match the current filters.`
					: 'No issues match the current filters.',
			action: 'clear_filters'
		};
	}

	const total = input.counts?.total;
	const closed = input.counts?.closed ?? 0;

	if (total === 0) {
		return emptyProject();
	}

	if (input.include_closed && input.issues_loaded === 0 && total !== undefined && total > 0) {
		return {
			kind: 'partial',
			title: 'The issue list did not load',
			description: `This project reports ${total} issues, but none were returned. Retry the load, or check the Dolt connection.`,
			action: 'retry'
		};
	}

	if (!input.include_closed && (closed > 0 || total === undefined)) {
		return {
			kind: 'closed_hidden',
			title: 'No open issues',
			description:
				closed > 0
					? `${closed} closed ${closed === 1 ? 'issue is' : 'issues are'} hidden. Include closed issues to see them.`
					: 'Closed issues are hidden by default. Include them to confirm whether this project is empty.',
			action: 'include_closed'
		};
	}

	return emptyProject();
}

function emptyProject(): IssueListVacancy {
	return {
		kind: 'empty',
		title: 'This project is empty',
		description:
			'No issues have been created in this project yet. An agent can create work with bd.'
	};
}
