/**
 * Run now and pause/resume, shared by the Automations list and an
 * automation's page so both report the same outcome. Run now starts a
 * mission whose result arrives later (docs/design-standards.md §9): the toast
 * says it launched and links to the mission, never that it finished.
 */
import { goto, refreshAll } from '$app/navigation';
import { toast } from 'svelte-sonner';
import type { AutomationView } from '#lib/automations.js';
import { api, errorMessage } from '#lib/client/api.js';
import { AUTOMATION_OUTCOME_LABEL } from '#lib/client/automations.js';
import { missionThreadHref } from '#lib/client/first-mate.js';

/** Fire the automation once now. @returns Whether it launched a mission. */
export async function runAutomationNow(automation: AutomationView): Promise<boolean> {
	try {
		const { run } = await api.runAutomation(automation.id);
		if (run.outcome === 'fired' && run.mission_id !== undefined) {
			const href = missionThreadHref(automation.project_id, run.mission_id);
			toast.success(`${automation.name} launched`, {
				description: 'The mission is starting.',
				action: { label: 'Open mission', onClick: () => void goto(href) }
			});
		} else {
			toast.error(`${automation.name} was ${AUTOMATION_OUTCOME_LABEL[run.outcome]}`, {
				description: run.message ?? 'See its history for details.'
			});
		}
		await refreshAll();
		return run.outcome === 'fired';
	} catch (error) {
		toast.error(`Could not run ${automation.name}`, { description: errorMessage(error) });
		return false;
	}
}

/** Pause or resume its schedule. Resuming never fires the runs missed while paused. */
export async function setAutomationEnabled(
	automation: AutomationView,
	enabled: boolean
): Promise<void> {
	try {
		await api.setAutomationEnabled(automation.id, enabled);
		toast.success(enabled ? `${automation.name} resumed` : `${automation.name} paused`);
		await refreshAll();
	} catch (error) {
		toast.error(enabled ? 'Could not resume it' : 'Could not pause it', {
			description: errorMessage(error)
		});
	}
}
