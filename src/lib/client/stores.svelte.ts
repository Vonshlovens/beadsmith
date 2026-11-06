/**
 * Runes-based client state: the polled health snapshot and the rail's UI
 * preferences.
 *
 * Project data deliberately lives in `page.data` (see projects.svelte.ts) so
 * nothing here is shared across SSR requests. Nothing is persisted except
 * non-secret UI preferences: the rail width goes to localStorage, the theme to
 * the server settings table (so the shell can paint it before hydration).
 */
import { browser } from '$app/env';
import { toast } from 'svelte-sonner';
import { api, errorMessage } from '#lib/client/api.js';
import {
	DARK_MEDIA_QUERY,
	applyTheme,
	nextTheme,
	resolveTheme,
	toThemePreference
} from '#lib/client/theme.js';
import type { AgentTarget } from '#lib/client/agent.js';
import type { ResolvedTheme, StatusSnapshot, ThemePreference } from '#lib/types.js';

const RAIL_KEY = 'bdui:rail-collapsed';
/** When this browser last opened Recent changes (epoch ms), for the unseen marker. */
const ACTIVITY_SEEN_KEY = 'bdui:activity-seen';
const STATUS_INTERVAL_MS = 30_000;

/** Shared, reactive UI state. */
class AppState {
	/** Latest polled snapshot; null until the first poll lands. */
	status = $state<StatusSnapshot | null>(null);
	status_error = $state<string | null>(null);
	rail_collapsed = $state(false);
	rail_open = $state(false);
	/** First Mate command palette. Not persisted. */
	first_mate_open = $state(false);
	/** Bumped so `/first-mate` focuses and selects its input. */
	first_mate_focus_tick = $state(0);
	/** The `?` keyboard shortcut overlay. */
	shortcuts_open = $state(false);
	/** The Recent changes drawer opened from the top bar. Not persisted. */
	activity_open = $state(false);
	/** When this browser last closed Recent changes (epoch ms); 0 before the first time. */
	activity_seen_at = $state(0);
	/** The issue the agent dialog is about; null while it is closed. */
	agent_target = $state<AgentTarget | null>(null);
	/** Last project route visited, so `g i` works from cross-project pages. */
	last_project_id = $state<string | null>(null);
	/** Stored preference, seeded from the shell that the server rendered. */
	theme = $state<ThemePreference>('system');
	/** Latest reading of `prefers-color-scheme: dark`; only matters for `system`. */
	prefers_dark = $state(false);
	/** What `theme` currently means for this viewer. */
	resolved_theme = $derived<ResolvedTheme>(resolveTheme(this.theme, this.prefers_dark));

	/**
	 * Replace the health snapshot.
	 *
	 * @param status - Latest snapshot.
	 */
	setStatus(status: StatusSnapshot | null) {
		this.status = status;
	}

	/** Read the persisted rail preference. Safe to call on the server. */
	loadRailPreference() {
		if (!browser) {
			return;
		}
		try {
			this.rail_collapsed = window.localStorage.getItem(RAIL_KEY) === '1';
		} catch {
			/* private mode or storage disabled — keep the default */
		}
	}

	/** Read when Recent changes was last seen in this browser. */
	loadActivitySeen() {
		if (!browser) {
			return;
		}
		try {
			this.activity_seen_at = Number(window.localStorage.getItem(ACTIVITY_SEEN_KEY)) || 0;
		} catch {
			/* storage disabled: everything reads as unseen, which is harmless */
		}
	}

	/**
	 * Record that Recent changes has been read up to `at`.
	 *
	 * @param at - Epoch ms; defaults to now.
	 */
	markActivitySeen(at = Date.now()) {
		this.activity_seen_at = at;
		if (!browser) {
			return;
		}
		try {
			window.localStorage.setItem(ACTIVITY_SEEN_KEY, String(at));
		} catch {
			/* storage disabled */
		}
	}

	/** Toggle the desktop rail between the expanded and icon widths. */
	toggleRail() {
		this.rail_collapsed = !this.rail_collapsed;
		if (!browser) {
			return;
		}
		try {
			window.localStorage.setItem(RAIL_KEY, this.rail_collapsed ? '1' : '0');
		} catch {
			/* preference is best-effort */
		}
	}

	/**
	 * Adopt the preference the shell already painted, plus the current platform
	 * setting. No network call: `hooks.server.ts` put the truth in the markup.
	 * Safe to call on the server.
	 */
	loadThemePreference() {
		if (!browser) {
			return;
		}
		this.theme = toThemePreference(document.documentElement.dataset.theme);
		this.prefers_dark = window.matchMedia(DARK_MEDIA_QUERY).matches;
		this.applyToDocument();
	}

	/**
	 * Track the platform setting so a `system` preference follows it live.
	 *
	 * @returns A cleanup function that removes the listener.
	 */
	watchSystemTheme(): () => void {
		if (!browser) {
			return () => {};
		}
		const query = window.matchMedia(DARK_MEDIA_QUERY);
		const onChange = (event: MediaQueryListEvent) => {
			this.prefers_dark = event.matches;
			this.applyToDocument();
		};
		query.addEventListener('change', onChange);
		return () => {
			query.removeEventListener('change', onChange);
		};
	}

	/**
	 * Switch the theme: paint first, persist after. A failed write leaves the
	 * new look in place — it simply will not survive a reload.
	 *
	 * @param preference - Preference to adopt.
	 */
	async setTheme(preference: ThemePreference) {
		this.theme = preference;
		this.applyToDocument();
		if (!browser) {
			return;
		}
		try {
			await api.setTheme(preference);
		} catch (error) {
			toast.error('Could not save the theme', { description: errorMessage(error) });
		}
	}

	/** Advance the toggle: system → light → dark → system. */
	cycleTheme() {
		void this.setTheme(nextTheme(this.theme));
	}

	/** Push the current preference onto `<html>` (the contract app.css reads). */
	private applyToDocument() {
		if (!browser) {
			return;
		}
		applyTheme(document.documentElement, this.theme, this.resolved_theme);
	}

	/** Open/close the overlay drawer used below 900px. */
	toggleDrawer() {
		this.rail_open = !this.rail_open;
	}

	closeDrawer() {
		this.rail_open = false;
	}

	/** Open the First Mate palette and close the overlay drawer if it is up. */
	openFirstMate() {
		this.closeDrawer();
		this.closeActivity();
		this.first_mate_open = true;
	}

	closeFirstMate() {
		this.first_mate_open = false;
	}

	/** Close the Recent changes drawer, recording what it showed as seen. */
	closeActivity() {
		if (!this.activity_open) {
			return;
		}
		this.activity_open = false;
		this.markActivitySeen();
	}

	/** Open the Recent changes drawer; it replaces the palette and the rail drawer. */
	openActivity() {
		this.closeDrawer();
		this.first_mate_open = false;
		this.activity_open = true;
	}

	/** Focus the First Mate page input. Does not open the popup. */
	focusFirstMatePage() {
		this.first_mate_focus_tick += 1;
	}

	/**
	 * Open the agent dialog on one issue (key `a`).
	 *
	 * @param target - The issue, and optionally an intent or thread to start on.
	 */
	openAgent(target: AgentTarget) {
		this.closeDrawer();
		this.first_mate_open = false;
		this.closeActivity();
		this.agent_target = target;
	}

	closeAgent() {
		this.agent_target = null;
	}

	/** Collapse the desktop rail, or open the drawer on a narrow screen. */
	toggleRailForViewport() {
		if (browser && window.matchMedia('(max-width: 900px)').matches) {
			this.toggleDrawer();
			return;
		}
		this.toggleRail();
	}
}

export const app_state = new AppState();

/**
 * Poll `/api/status` every 30s while the document is visible, refreshing
 * immediately when the tab regains visibility.
 *
 * @returns A cleanup function that stops the polling.
 */
export function startStatusPolling(): () => void {
	if (!browser) {
		return () => {};
	}

	let disposed = false;

	const refresh = async () => {
		if (document.visibilityState !== 'visible') {
			return;
		}
		try {
			const snapshot = await api.status();
			if (!disposed) {
				app_state.setStatus(snapshot);
				app_state.status_error = null;
			}
		} catch (error) {
			if (!disposed) {
				app_state.status_error = error instanceof Error ? error.message : 'status unavailable';
			}
		}
	};

	const onVisibility = () => {
		if (document.visibilityState === 'visible') {
			void refresh();
		}
	};

	void refresh();
	const timer = setInterval(() => void refresh(), STATUS_INTERVAL_MS);
	document.addEventListener('visibilitychange', onVisibility);

	return () => {
		disposed = true;
		clearInterval(timer);
		document.removeEventListener('visibilitychange', onVisibility);
	};
}
