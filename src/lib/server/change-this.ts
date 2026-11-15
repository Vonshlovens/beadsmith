/**
 * Which Beads project tracks Beadsmith's own code, for "Change this" and
 * First Mate's `request_code_change` (ADR-0025 rule 10). It is configuration,
 * not a constant: an admin picks it the first time they send a request, and
 * it lives in the settings table like the theme. An empty value means unset.
 */
import { CHANGE_THIS_PROJECT_SETTING } from '#lib/change-request.js';
import { PROJECT_ID_PATTERN } from './validation.js';
import type { StateStore } from './state/db.js';

/** The configured project id, or null when none is set (or the stored value is unusable). */
export async function changeThisProjectId(store: StateStore): Promise<string | null> {
	const value = await store.getSetting(CHANGE_THIS_PROJECT_SETTING);
	return value !== undefined && PROJECT_ID_PATTERN.test(value) ? value : null;
}

/** Remember the project, or forget it with null. */
export async function setChangeThisProjectId(
	store: StateStore,
	project_id: string | null
): Promise<void> {
	await store.setSetting(CHANGE_THIS_PROJECT_SETTING, project_id ?? '');
}
