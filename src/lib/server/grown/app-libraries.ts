/**
 * The libraries an app may ask the host to inline into its document
 * (ADR-0025 rule 3), in one file so the allowlist is reviewed in one place.
 * An app's document can load nothing over the network (its CSP is
 * `default-src 'none'`), so this list is everything an app can use beyond
 * its own code. Adding an entry is a repository change through review;
 * neither First Mate nor an app can extend it.
 *
 * Two kinds of entry:
 *
 * - **First-party**: CSS that comes from this repository's own source in the
 *   same build, so it cannot drift from what was reviewed. The design tokens
 *   are cut from `src/app.css`, so an app looks like Beadsmith and follows
 *   its palette in both themes without a second copy of the tokens.
 * - **Vendored**: a third-party file committed under `vendor/`, pinned here
 *   by version and SHA-256. The bytes are checked against the pin before
 *   they are first served, and a mismatch refuses to serve rather than
 *   inline something nobody reviewed. Its licence goes in
 *   `THIRD_PARTY_NOTICES.md`.
 */
import { createHash } from 'node:crypto';
import app_css from '../../../app.css?raw';
import chart_js from '../../../../vendor/chart.js/chart.umd.min.js?raw';

export type AppLibraryType = 'css' | 'js';

interface FirstPartyLibrary {
	origin: 'first-party';
	type: AppLibraryType;
	/** What an app gets, for the crew tool's description. */
	summary: string;
	source: () => string;
}

interface VendoredLibrary {
	origin: 'vendored';
	type: AppLibraryType;
	summary: string;
	version: string;
	/** Lowercase hex SHA-256 of the committed file's bytes. */
	sha256: string;
	source: () => string;
}

export type AppLibrary = FirstPartyLibrary | VendoredLibrary;

/**
 * The `:root { … }` (light) and `:root.dark { … }` token blocks of
 * `src/app.css`, which hold every colour, spacing and type token, plus a
 * base so a bare document starts on the right paper and ink. The rest of
 * `app.css` is Tailwind source and the app's own components, which mean
 * nothing inside an app.
 * @param css The text of `src/app.css`.
 */
export function designTokenCss(css: string): string {
	const blocks = css.match(/^:root(?:\.dark)? \{[\s\S]*?^\}/gm) ?? [];
	if (blocks.length !== 2) {
		throw new Error(`expected the light and dark token blocks in app.css, found ${blocks.length}`);
	}
	return [
		...blocks,
		'*,*::before,*::after{box-sizing:border-box}',
		'body{margin:0;background:var(--bg);color:var(--tx);font-family:var(--font);font-size:var(--t-base)}'
	].join('\n');
}

/** Every library an app may name. The key is the name an app's spec uses. */
export const APP_LIBRARIES = {
	'beadsmith-tokens': {
		origin: 'first-party',
		type: 'css',
		summary:
			"Beadsmith's colour, type and spacing tokens as CSS variables (--bg, --s1..--s5, --tx, --tx-hi, --tx-mid, --line, --em-500, --danger, --mint, --amber, --t-sm..--t-2xl, --s-1..--s-8, --r-1..--r-3), light and dark, and a body on the app's paper and ink.",
		source: () => designTokenCss(app_css)
	},
	/*
	 * Chart.js's UMD build, byte for byte from the npm tarball (provenance in
	 * `vendor/chart.js/package.json`). Chosen because it draws line, bar,
	 * pie, doughnut and scatter charts from one file with no dependencies to
	 * load, makes no network requests, draws on a canvas (nothing the frame's
	 * CSP blocks), and is the chart API models write most fluently. Its
	 * trailing `sourceMappingURL` comment is left in place so the bytes stay
	 * upstream's: only devtools reads it, and the frame's CSP refuses the
	 * fetch.
	 */
	'chart.js': {
		origin: 'vendored',
		type: 'js',
		summary:
			'Chart.js 4.5.1 as the global `Chart` (line, bar, pie, doughnut, radar, scatter on a <canvas>). Read colours from the token variables with getComputedStyle so charts follow the theme.',
		version: '4.5.1',
		sha256: '48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a',
		source: () => chart_js
	}
} satisfies Record<string, AppLibrary>;

export type AppLibraryName = keyof typeof APP_LIBRARIES;

export const APP_LIBRARY_NAMES = Object.keys(APP_LIBRARIES) as [
	AppLibraryName,
	...AppLibraryName[]
];

/**
 * A library's bytes, checked against its pin when it is vendored.
 * @param name The library.
 * @param library Its entry (a parameter so tests can check a bad pin).
 * @throws When a vendored file's SHA-256 is not the pinned one.
 */
export function libraryText(name: string, library: AppLibrary): string {
	const text = library.source();
	if (library.origin === 'vendored') {
		const actual = createHash('sha256').update(text, 'utf8').digest('hex');
		if (actual !== library.sha256) {
			throw new Error(
				`vendored app library ${name}@${library.version} does not match its pinned SHA-256 (got ${actual})`
			);
		}
	}
	// Inlined into a <style> or <script> element, a closing tag would end the
	// element early and turn the rest into markup.
	if (new RegExp(`</${library.type === 'css' ? 'style' : 'script'}`, 'i').test(text)) {
		throw new Error(`app library ${name} contains its own closing tag and cannot be inlined`);
	}
	return text;
}

const checked = new Map<AppLibraryName, string>();

/**
 * An allowlisted library's text, checked once per process.
 * @param name The library.
 */
export function appLibraryText(name: AppLibraryName): string {
	let text = checked.get(name);
	if (text === undefined) {
		text = libraryText(name, APP_LIBRARIES[name]);
		checked.set(name, text);
	}
	return text;
}
