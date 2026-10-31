/**
 * Appearance preference: `auto` follows the system. Stored in localStorage
 * under the same key the pre-paint script in app.html reads.
 */

export type Appearance = 'auto' | 'light' | 'dark';

const KEY = 'beadsmith-site:appearance';
const ORDER: Appearance[] = ['auto', 'light', 'dark'];

export function storedAppearance(): Appearance {
	try {
		const value = localStorage.getItem(KEY);
		return value === 'light' || value === 'dark' ? value : 'auto';
	} catch {
		return 'auto';
	}
}

export function nextAppearance(current: Appearance): Appearance {
	return ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
}

export function applyAppearance(value: Appearance): void {
	try {
		if (value === 'auto') {
			localStorage.removeItem(KEY);
		} else {
			localStorage.setItem(KEY, value);
		}
	} catch {
		// Private mode or storage disabled: the choice lasts for this page only.
	}
	const dark =
		value === 'dark' ||
		(value === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
	document.documentElement.classList.toggle('dark', dark);
}
