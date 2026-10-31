/**
 * Client stale-while-revalidate cache for the project issue list.
 *
 * Back-navigation re-runs `src/routes/p/[id]/+page.ts` and would otherwise
 * wait on SQL for a list the user was looking at seconds ago. Keep the last
 * successful payload per (project, filter set), return it immediately, and
 * refresh behind it. `view` is not part of the key: list and board share one
 * payload. SSR must not touch this map (it is a process singleton).
 */
import type { IssueSummary } from '$lib/types.js';

/** Serve a cached list for this long, then wait on the network again. */
export const ISSUE_LIST_CACHE_TTL_MS = 10_000;

export interface ListFilters {
	status: string[];
	type: string[];
	priority: number[];
	q: string;
	include_closed: boolean;
}

export interface IssueListPayload {
	issues: IssueSummary[];
	source: string;
	readonly: boolean;
	error: string | null;
}

export interface CachedIssueList extends IssueListPayload {
	project_id: string;
	stored_at: number;
}

const CACHE_KEY = '__beadsIssueListCache';
const INFLIGHT_KEY = '__beadsIssueListInflight';
const LISTENERS_KEY = '__beadsIssueListListeners';

type Listener = () => void;

function store(): {
	cache: Map<string, CachedIssueList>;
	inflight: Map<string, Promise<void>>;
	listeners: Set<Listener>;
} {
	const global_store = globalThis as typeof globalThis & {
		[CACHE_KEY]?: Map<string, CachedIssueList>;
		[INFLIGHT_KEY]?: Map<string, Promise<void>>;
		[LISTENERS_KEY]?: Set<Listener>;
	};
	if (global_store[CACHE_KEY] === undefined) {
		global_store[CACHE_KEY] = new Map();
	}
	if (global_store[INFLIGHT_KEY] === undefined) {
		global_store[INFLIGHT_KEY] = new Map();
	}
	if (global_store[LISTENERS_KEY] === undefined) {
		global_store[LISTENERS_KEY] = new Set();
	}
	return {
		cache: global_store[CACHE_KEY],
		inflight: global_store[INFLIGHT_KEY],
		listeners: global_store[LISTENERS_KEY]
	};
}

function cloneSummary(summary: IssueSummary): IssueSummary {
	return {
		...summary,
		labels: [...summary.labels]
	};
}

function clonePayload(payload: IssueListPayload): IssueListPayload {
	return {
		issues: payload.issues.map(cloneSummary),
		source: payload.source,
		readonly: payload.readonly,
		error: payload.error
	};
}

function emit(): void {
	for (const listener of store().listeners) {
		listener();
	}
}

/**
 * Read the filter set out of the URL. `view` is presentation, not a filter.
 *
 * @param params - Query parameters of the current URL.
 */
export function readListFilters(params: URLSearchParams): ListFilters {
	const list = (key: string) =>
		(params.get(key) ?? '')
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean);

	return {
		status: list('status'),
		type: list('type'),
		priority: list('priority')
			.map((value) => Number.parseInt(value, 10))
			.filter((value) => Number.isFinite(value)),
		q: params.get('q') ?? '',
		include_closed: params.get('include_closed') === '1'
	};
}

/**
 * Canonical cache key: project plus filters, ignoring list/board `view` and
 * the order the query string was written.
 *
 * @param project_id - Project id in the `/p/:id` path.
 * @param filters - Active list filters.
 */
export function issueListCacheKey(project_id: string, filters: ListFilters): string {
	const params = new URLSearchParams();
	if (filters.status.length > 0) {
		params.set('status', [...filters.status].sort().join(','));
	}
	if (filters.type.length > 0) {
		params.set('type', [...filters.type].sort().join(','));
	}
	if (filters.priority.length > 0) {
		params.set('priority', [...filters.priority].sort((a, b) => a - b).join(','));
	}
	const q = filters.q.trim();
	if (q) {
		params.set('q', q);
	}
	if (filters.include_closed) {
		params.set('include_closed', '1');
	}
	const encoded = params.toString();
	return encoded ? `${project_id}?${encoded}` : project_id;
}

/**
 * Stash a successful list payload. Error payloads are ignored so a failed
 * refresh cannot hide a list the user already had.
 *
 * @param key - `issueListCacheKey` for this project and filters.
 * @param payload - List body to remember.
 * @param stored_at - Clock ms; tests pass an explicit value.
 */
export function rememberIssueList(
	key: string,
	payload: Omit<CachedIssueList, 'stored_at'> & { stored_at?: number },
	stored_at = Date.now()
): void {
	if (payload.error) {
		return;
	}
	store().cache.set(key, {
		project_id: payload.project_id,
		...clonePayload(payload),
		stored_at
	});
	emit();
}

/**
 * Read a cached list regardless of age. Used by the painted page so a
 * background refresh can replace rows without waiting on `load`.
 *
 * @param key - `issueListCacheKey` for this project and filters.
 */
export function getIssueList(key: string): CachedIssueList | undefined {
	const hit = store().cache.get(key);
	if (!hit) {
		return undefined;
	}
	return {
		project_id: hit.project_id,
		...clonePayload(hit),
		stored_at: hit.stored_at
	};
}

/**
 * Read a cached list only while it is still within the TTL.
 *
 * @param key - `issueListCacheKey` for this project and filters.
 * @param now - Clock ms; tests pass an explicit value.
 */
export function peekFreshIssueList(key: string, now = Date.now()): CachedIssueList | undefined {
	const hit = getIssueList(key);
	if (!hit) {
		return undefined;
	}
	if (now - hit.stored_at >= ISSUE_LIST_CACHE_TTL_MS) {
		return undefined;
	}
	return hit;
}

/**
 * Drop every cached list for one project. Ready for a write path that needs
 * to stop a stale row surviving a mutation.
 *
 * @param project_id - Project whose entries should disappear.
 */
export function dropIssueListCacheForProject(project_id: string): void {
	const { cache } = store();
	for (const [key, value] of cache) {
		if (value.project_id === project_id) {
			cache.delete(key);
		}
	}
	emit();
}

/**
 * Drop every cached list. Tests only.
 */
export function clearIssueListCache(): void {
	store().cache.clear();
	store().inflight.clear();
	emit();
}

/**
 * Subscribe to cache writes so the list page can paint a background refresh.
 *
 * @param listener - Called after remember/drop/clear.
 */
export function subscribeIssueListCache(listener: Listener): () => void {
	store().listeners.add(listener);
	return () => {
		store().listeners.delete(listener);
	};
}

/**
 * In-flight revalidation for tests that need to wait on the background fetch.
 *
 * @param key - `issueListCacheKey` for this project and filters.
 */
export function pendingIssueListRevalidation(key: string): Promise<void> | undefined {
	return store().inflight.get(key);
}

function revalidateIssueList(
	key: string,
	project_id: string,
	fetchPayload: () => Promise<IssueListPayload>
): void {
	const { inflight } = store();
	if (inflight.has(key)) {
		return;
	}
	const pending = fetchPayload()
		.then((fresh) => {
			if (fresh.error === null) {
				rememberIssueList(key, { project_id, ...fresh });
			}
		})
		.finally(() => {
			if (inflight.get(key) === pending) {
				inflight.delete(key);
			}
		});
	inflight.set(key, pending);
}

/**
 * Return a fresh list, or a still-warm cached list immediately while a
 * refresh runs behind it.
 *
 * @param options.cache - False during SSR so this singleton cannot leak.
 * @param options.now - Clock ms; tests pass an explicit value.
 * @param options.project_id - Project id in the `/p/:id` path.
 * @param options.filters - Active list filters.
 * @param options.fetchPayload - Network load for this key.
 */
export async function resolveIssueListPayload(options: {
	cache: boolean;
	now?: number;
	project_id: string;
	filters: ListFilters;
	fetchPayload: () => Promise<IssueListPayload>;
}): Promise<IssueListPayload> {
	const key = issueListCacheKey(options.project_id, options.filters);
	const now = options.now ?? Date.now();

	if (options.cache) {
		const hit = peekFreshIssueList(key, now);
		if (hit) {
			revalidateIssueList(key, options.project_id, options.fetchPayload);
			return clonePayload(hit);
		}
	}

	const fresh = await options.fetchPayload();
	if (options.cache && fresh.error === null) {
		rememberIssueList(key, { project_id: options.project_id, ...fresh }, now);
	}
	return fresh;
}
