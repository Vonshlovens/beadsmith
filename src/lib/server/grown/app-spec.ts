/**
 * Sandboxed apps (ADR-0025 rule 3): model-written HTML, CSS and JavaScript,
 * stored as data. The server never parses, templates or runs the document
 * (rule 4): `html` is opaque text that the frame route serves, byte for
 * byte, after the libraries the app names, into a sandboxed iframe whose CSP
 * allows no network at all.
 */
import { z } from 'zod';
import {
	APP_LIBRARIES,
	APP_LIBRARY_NAMES,
	appLibraryText,
	type AppLibraryName
} from './app-libraries.js';

/** Most model-written bytes in one app document, not counting inlined libraries. */
export const APP_DOCUMENT_MAX_BYTES = 256 * 1024;

/**
 * Most JSON bytes in one app spec. The document limit above is the one that
 * matters; JSON escaping can double a document of quotes and newlines, so the
 * store's byte check sits past that and never refuses a document that fits.
 */
export const APP_SPEC_MAX_BYTES = 2 * APP_DOCUMENT_MAX_BYTES + 4096;

export const app_spec_schema = z.strictObject({
	/**
	 * The document: HTML with inline `<style>` and `<script>`. It may be a
	 * fragment or a whole document; the host's head (charset, viewport,
	 * libraries) comes first either way.
	 */
	html: z
		.string()
		.min(1)
		.refine((html) => Buffer.byteLength(html, 'utf8') <= APP_DOCUMENT_MAX_BYTES, {
			error: (issue) =>
				`an app document is at most ${APP_DOCUMENT_MAX_BYTES} bytes; this is ${Buffer.byteLength(String(issue.input), 'utf8')}`
		}),
	/** Allowlisted libraries to inline, in order. The design tokens by default. */
	libraries: z
		.array(z.enum(APP_LIBRARY_NAMES))
		.max(APP_LIBRARY_NAMES.length)
		.refine((names) => new Set(names).size === names.length, 'name each library once')
		.default(['beadsmith-tokens'])
});

export type AppSpec = z.infer<typeof app_spec_schema>;

export type AppTheme = 'light' | 'dark';

/**
 * The document the frame route serves: the host's head, then the app's own
 * bytes unchanged. `class="dark"` on `<html>` selects the dark token block;
 * an app document that opens its own `<html>` merges into this element, as
 * HTML parsing does, so the class survives.
 * @param spec The app revision's parsed spec.
 * @param theme The host page's resolved theme.
 */
export function appDocument(spec: AppSpec, theme: AppTheme): string {
	const libraries = spec.libraries.map((name: AppLibraryName) => {
		const text = appLibraryText(name);
		return APP_LIBRARIES[name].type === 'css'
			? `<style data-library="${name}">${text}</style>`
			: `<script data-library="${name}">${text}</script>`;
	});
	return [
		'<!doctype html>',
		`<html lang="en"${theme === 'dark' ? ' class="dark"' : ''}>`,
		'<head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		...libraries,
		'</head>',
		spec.html
	].join('\n');
}

/**
 * The frame's response CSP (ADR-0025 rule 3). `sandbox allow-scripts` keeps
 * the document in an opaque origin even when opened directly rather than
 * through the host's `<iframe sandbox>`; everything else shuts the network:
 * no fetch, XHR, WebSocket, external script, style, font, image or frame.
 * Only the host page may embed it.
 */
export const APP_FRAME_CSP = [
	'sandbox allow-scripts',
	"default-src 'none'",
	"script-src 'unsafe-inline'",
	"style-src 'unsafe-inline'",
	'img-src data:',
	"connect-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
	"frame-ancestors 'self'"
].join('; ');
