/**
 * Theme primitives shared by the store, the toggle, and the blocking script in
 * `app.html` (which reimplements `resolveTheme` inline, since it must run
 * before any module loads — keep the two in step).
 *
 * The contract with `app.css`: `<html>` carries the class `dark` iff the
 * resolved theme is dark, `data-theme` carries the *preference*, and the inline
 * `color-scheme` style follows the resolved theme so native controls match.
 *
 * Deliberately free of runes and `$app` imports so it stays plain, testable
 * TypeScript.
 */
import type { ResolvedTheme, ThemePreference } from '$lib/types';

/** Cycle order used by the top-bar toggle. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** Media query consulted whenever the preference is `system`. */
export const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** Settings key holding the preference server-side. */
export const THEME_SETTING_KEY = 'ui.theme';

/**
 * Narrow an untrusted value to a preference.
 *
 * @param value - Candidate value, typically from the DOM or the network.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
	return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/**
 * Coerce an untrusted value to a preference, defaulting to `system`.
 *
 * @param value - Candidate value, typically `document.documentElement.dataset.theme`.
 */
export function toThemePreference(value: unknown): ThemePreference {
	return isThemePreference(value) ? value : 'system';
}

/**
 * Next preference in the `system → light → dark → system` cycle.
 *
 * @param preference - Current preference; unrecognised values restart the cycle.
 */
export function nextTheme(preference: ThemePreference): ThemePreference {
	const index = THEME_PREFERENCES.indexOf(preference);
	return THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length];
}

/**
 * Resolve a preference against the platform setting.
 *
 * @param preference - Stored preference.
 * @param prefers_dark - Whether the OS currently prefers dark.
 */
export function resolveTheme(preference: ThemePreference, prefers_dark: boolean): ResolvedTheme {
	if (preference === 'system') {
		return prefers_dark ? 'dark' : 'light';
	}
	return preference;
}

/**
 * Write the preference and the resolved theme onto the document element.
 *
 * @param root - The `<html>` element.
 * @param preference - Preference to record in `data-theme`.
 * @param resolved - Resolved theme driving the `dark` class and `color-scheme`.
 */
export function applyTheme(
	root: HTMLElement,
	preference: ThemePreference,
	resolved: ResolvedTheme
): void {
	root.dataset.theme = preference;
	root.classList.toggle('dark', resolved === 'dark');
	root.style.colorScheme = resolved;
}

/**
 * Accessible label naming the current mode and what a click does.
 *
 * @param preference - Current preference.
 */
export function themeToggleLabel(preference: ThemePreference): string {
	return `Theme: ${preference}. Switch to ${nextTheme(preference)}.`;
}
