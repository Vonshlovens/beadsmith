import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	APP_LIBRARIES,
	APP_LIBRARY_NAMES,
	appLibraryText,
	designTokenCss,
	libraryText,
	type AppLibrary
} from './app-libraries.js';
import {
	APP_DOCUMENT_MAX_BYTES,
	APP_FRAME_CSP,
	APP_SPEC_MAX_BYTES,
	app_spec_schema,
	appDocument
} from './app-spec.js';

function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('app library allowlist', () => {
	it('serves every allowlisted library, and every vendored one matches its pin', () => {
		for (const name of APP_LIBRARY_NAMES) {
			const library = APP_LIBRARIES[name] as AppLibrary;
			const text = appLibraryText(name);
			expect(text.length, name).toBeGreaterThan(0);
			if (library.origin === 'vendored') {
				expect(library.version, name).toMatch(/^\d+\.\d+\.\d+/);
				expect(sha256(text), name).toBe(library.sha256);
			}
		}
	});

	it('refuses to serve a vendored file whose bytes do not match its SHA-256', () => {
		const pinned: AppLibrary = {
			origin: 'vendored',
			type: 'js',
			summary: 'test',
			version: '1.0.0',
			sha256: sha256('window.ok = 1;'),
			source: () => 'window.ok = 1;'
		};
		expect(libraryText('ok', pinned)).toBe('window.ok = 1;');
		const tampered = { ...pinned, source: () => 'window.ok = 1; fetch("//x")' };
		expect(() => libraryText('ok', tampered)).toThrow(/does not match its pinned SHA-256/);
	});

	it('refuses a library that would close its own element', () => {
		const css: AppLibrary = {
			origin: 'first-party',
			type: 'css',
			summary: 'test',
			source: () => 'a{}</STYLE><script>alert(1)</script>'
		};
		expect(() => libraryText('bad', css)).toThrow(/closing tag/);
	});

	it('cuts both theme blocks from app.css and nothing else of it', () => {
		const tokens = appLibraryText('beadsmith-tokens');
		expect(tokens).toMatch(/^:root \{/);
		expect(tokens).toContain(':root.dark {');
		expect(tokens).toContain('--bg:');
		expect(tokens).not.toContain('@import');
		expect(tokens).not.toContain('@layer');
		expect(() => designTokenCss('a { color: red }')).toThrow(/token blocks/);
	});
});

describe('app spec', () => {
	it('defaults the libraries to the design tokens and rejects unknown keys and libraries', () => {
		expect(app_spec_schema.parse({ html: '<p>hi</p>' })).toEqual({
			html: '<p>hi</p>',
			libraries: ['beadsmith-tokens']
		});
		expect(app_spec_schema.safeParse({ html: '<p>hi</p>', src: 'x.js' }).success).toBe(false);
		expect(app_spec_schema.safeParse({ html: '<p>hi</p>', libraries: ['jquery'] }).success).toBe(
			false
		);
		expect(
			app_spec_schema.safeParse({
				html: '<p>hi</p>',
				libraries: ['beadsmith-tokens', 'beadsmith-tokens']
			}).success
		).toBe(false);
		expect(app_spec_schema.safeParse({ html: '' }).success).toBe(false);
	});

	it('counts the document in UTF-8 bytes, and the JSON limit never refuses a document that fits', () => {
		const fits = '"\n'.repeat(APP_DOCUMENT_MAX_BYTES / 2);
		expect(app_spec_schema.safeParse({ html: fits }).success).toBe(true);
		expect(JSON.stringify({ html: fits, libraries: ['beadsmith-tokens'] }).length).toBeLessThan(
			APP_SPEC_MAX_BYTES
		);
		const over = 'é'.repeat(APP_DOCUMENT_MAX_BYTES / 2 + 1);
		const parsed = app_spec_schema.safeParse({ html: over });
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0].message).toContain(`at most ${APP_DOCUMENT_MAX_BYTES} bytes`);
	});
});

describe('app document', () => {
	it("puts the host's head first and the app's bytes after it, unchanged", () => {
		const html = '<div id="x">{{ not a template }} ${nor this}</div><script>go()</script>';
		const document = appDocument({ html, libraries: ['beadsmith-tokens'] }, 'light');
		expect(document.startsWith('<!doctype html>\n<html lang="en">\n<head>')).toBe(true);
		expect(document).toContain('<style data-library="beadsmith-tokens">:root {');
		expect(document.endsWith(`</head>\n${html}`)).toBe(true);
		expect(appDocument({ html, libraries: [] }, 'dark')).toBe(
			[
				'<!doctype html>',
				'<html lang="en" class="dark">',
				'<head>',
				'<meta charset="utf-8">',
				'<meta name="viewport" content="width=device-width, initial-scale=1">',
				'</head>',
				html
			].join('\n')
		);
	});

	it('sends a CSP that sandboxes the document and shuts every network path', () => {
		const directives = new Map(
			APP_FRAME_CSP.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1).join(' ')])
		);
		expect(directives.get('sandbox')).toBe('allow-scripts');
		expect(directives.get('default-src')).toBe("'none'");
		expect(directives.get('connect-src')).toBe("'none'");
		expect(directives.get('script-src')).toBe("'unsafe-inline'");
		expect(directives.get('style-src')).toBe("'unsafe-inline'");
		expect(directives.get('img-src')).toBe('data:');
		expect(directives.get('form-action')).toBe("'none'");
		expect(directives.get('base-uri')).toBe("'none'");
		expect(directives.get('frame-ancestors')).toBe("'self'");
		// No same-origin, popups, navigation, forms or modals in the sandbox.
		expect(APP_FRAME_CSP).not.toMatch(/allow-(same-origin|top-navigation|popups|forms|modals)/);
	});
});
