import type { IssueSummary } from '$lib/types.js';

const HINTS_KEY = '__beadsIssueSummaryHints';

function hints(): Map<string, IssueSummary> {
	const store = globalThis as typeof globalThis & {
		[HINTS_KEY]?: Map<string, IssueSummary>;
	};
	if (store[HINTS_KEY] === undefined) {
		store[HINTS_KEY] = new Map();
	}
	return store[HINTS_KEY];
}

function cloneSummary(summary: IssueSummary): IssueSummary {
	return {
		...summary,
		labels: [...summary.labels]
	};
}

/**
 * Stash a list-row (or board-card) summary as a paint hint for the next
 * detail view of that id. The hint is never authoritative.
 *
 * @param summary - IssueSummary from the list payload.
 */
export function rememberIssueSummaryHint(summary: IssueSummary): void {
	hints().set(summary.id, cloneSummary(summary));
}

/**
 * Read a paint hint without consuming it.
 *
 * @param issue_id - Issue id the detail page is opening.
 */
export function peekIssueSummaryHint(issue_id: string): IssueSummary | undefined {
	return hints().get(issue_id);
}

/**
 * Take the paint hint for one issue. Call again after the real detail
 * arrives so a stale row cannot linger.
 *
 * @param issue_id - Issue id the detail page is opening.
 */
export function takeIssueSummaryHint(issue_id: string): IssueSummary | undefined {
	const hint = hints().get(issue_id);
	if (hint !== undefined) {
		hints().delete(issue_id);
	}
	return hint;
}

/**
 * If this pathname is an issue in the given list, stash that row as a paint
 * hint. Used from `beforeNavigate` so link clicks still count (they skip
 * the row's pointerdown handler).
 *
 * @param pathname - Destination path, e.g. `/p/d_example/i/proj-8u7`.
 * @param project_id - Current project id.
 * @param issues - Issue summaries currently painted on the list or board.
 */
export function rememberHintIfListed(
	pathname: string,
	project_id: string,
	issues: readonly IssueSummary[]
): void {
	const prefix = `/p/${project_id}/i/`;
	if (!pathname.startsWith(prefix)) {
		return;
	}
	const issue_id = decodeURIComponent(pathname.slice(prefix.length).split('/')[0] ?? '');
	if (!issue_id) {
		return;
	}
	const summary = issues.find((issue) => issue.id === issue_id);
	if (summary) {
		rememberIssueSummaryHint(summary);
	}
}

/**
 * Drop every hint. Tests only.
 */
export function clearIssueSummaryHints(): void {
	hints().clear();
}
