import { describe, expect, it } from 'vitest';
import {
	THEME_PREFERENCES,
	applyTheme,
	isThemePreference,
	nextTheme,
	resolveTheme,
	themeToggleLabel,
	toThemePreference
} from './theme.js';
import type { ThemePreference } from '$lib/types.js';

describe('nextTheme', () => {
	it('cycles system → light → dark → system', () => {
		expect(nextTheme('system')).toBe('light');
		expect(nextTheme('light')).toBe('dark');
		expect(nextTheme('dark')).toBe('system');
	});

	it('returns to the starting point after one full cycle', () => {
		const start: ThemePreference = 'light';

		let current: ThemePreference = start;
		for (let step = 0; step < THEME_PREFERENCES.length; step += 1) {
			current = nextTheme(current);
		}

		expect(current).toBe(start);
	});
});

describe('resolveTheme', () => {
	it('follows the platform only for system', () => {
		expect(resolveTheme('system', true)).toBe('dark');
		expect(resolveTheme('system', false)).toBe('light');
	});

	it('ignores the platform for an explicit preference', () => {
		expect(resolveTheme('light', true)).toBe('light');
		expect(resolveTheme('dark', false)).toBe('dark');
	});
});

describe('preference coercion', () => {
	it('accepts the three documented values', () => {
		expect(isThemePreference('system')).toBe(true);
		expect(isThemePreference('light')).toBe(true);
		expect(isThemePreference('dark')).toBe(true);
	});

	it('rejects anything else', () => {
		expect(isThemePreference('DARK')).toBe(false);
		expect(isThemePreference('')).toBe(false);
		expect(isThemePreference(undefined)).toBe(false);
		expect(isThemePreference(null)).toBe(false);
	});

	it('falls back to system, including for the unsubstituted placeholder', () => {
		expect(toThemePreference('light')).toBe('light');
		expect(toThemePreference('%bdui.theme%')).toBe('system');
		expect(toThemePreference(undefined)).toBe('system');
	});
});

describe('applyTheme', () => {
	/** Minimal stand-in for `document.documentElement`. */
	function makeRoot() {
		const classes = new Set<string>();
		return {
			dataset: {} as Record<string, string>,
			style: { colorScheme: '' },
			classList: {
				toggle(name: string, force: boolean): void {
					if (force) {
						classes.add(name);
					} else {
						classes.delete(name);
					}
				}
			},
			classes
		};
	}

	it('marks dark with the class, the preference, and color-scheme', () => {
		const root = makeRoot();

		applyTheme(root as unknown as HTMLElement, 'system', 'dark');

		expect(root.classes.has('dark')).toBe(true);
		expect(root.dataset.theme).toBe('system');
		expect(root.style.colorScheme).toBe('dark');
	});

	it('removes the class when the resolved theme is light', () => {
		const root = makeRoot();
		applyTheme(root as unknown as HTMLElement, 'dark', 'dark');

		applyTheme(root as unknown as HTMLElement, 'light', 'light');

		expect(root.classes.has('dark')).toBe(false);
		expect(root.dataset.theme).toBe('light');
		expect(root.style.colorScheme).toBe('light');
	});
});

describe('themeToggleLabel', () => {
	it('names the current mode and the next one', () => {
		expect(themeToggleLabel('system')).toBe('Theme: system. Switch to light.');
		expect(themeToggleLabel('dark')).toBe('Theme: dark. Switch to system.');
	});
});
