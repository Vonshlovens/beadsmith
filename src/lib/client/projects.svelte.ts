/**
 * Project accessors backed by the layout's `load` result.
 *
 * These read `page.data` rather than a module-level store on purpose: a
 * module singleton is shared across requests during SSR, so server-rendered
 * markup would either leak another request's data or render empty. Call these
 * inside `$derived(...)` and they stay reactive.
 */
import { page } from '$app/state';
import { app_state } from '$lib/client/stores.svelte';
import type { Project, StatusSnapshot, Viewer } from '$lib/types';

/** Every known project, in the order discovery returned them. */
export function projectList(): Project[] {
	return (page.data.projects ?? []) as Project[];
}

/** The project the current route belongs to, if any. */
export function currentProject(): Project | null {
	const id = page.params.id;
	if (!id) {
		return null;
	}
	return projectList().find((project) => project.id === id) ?? null;
}

/**
 * The freshest health snapshot: the polled one when it exists, otherwise the
 * one the layout loaded.
 */
export function statusSnapshot(): StatusSnapshot | null {
	return app_state.status ?? ((page.data.status ?? null) as StatusSnapshot | null);
}

/** Who the shell renders for (`null` while signed out), from the layout load. */
export function currentViewer(): Viewer | null {
	return (page.data.viewer ?? null) as Viewer | null;
}
