import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	loadTackleRepositoriesFromEnv,
	parseGitHubRepositoryUrl,
	parseGitRef,
	parseTackleRepositoriesJson
} from './repositories.js';

describe('parseGitHubRepositoryUrl', () => {
	it('accepts a canonical https GitHub owner/repo URL', () => {
		expect(parseGitHubRepositoryUrl('https://github.com/Example-Org/beads-web')).toBe(
			'https://github.com/Example-Org/beads-web'
		);
	});

	it('strips a trailing slash and .git suffix', () => {
		expect(parseGitHubRepositoryUrl('https://github.com/example-org/beads-web.git/')).toBe(
			'https://github.com/example-org/beads-web'
		);
	});

	it('rejects non-github, credentials, query, and extra path', () => {
		const rejected = [
			'http://github.com/example-org/beads-web',
			'https://gitlab.com/example-org/beads-web',
			'https://user:pass@github.com/example-org/beads-web', // trufflehog:ignore (fixture)
			'https://github.com/example-org/beads-web?foo=1',
			'https://github.com/example-org/beads-web#frag',
			'https://github.com/example-org/beads-web/tree/main',
			'https://example.com/example-org/beads-web',
			'not-a-url'
		];
		for (const raw of rejected) {
			expect(parseGitHubRepositoryUrl(raw), raw).toBeUndefined();
		}
	});
});

describe('parseGitRef', () => {
	it('accepts branch-like refs', () => {
		expect(parseGitRef('main')).toBe('main');
		expect(parseGitRef('release/1.2')).toBe('release/1.2');
	});

	it('rejects empty, traversal, and control values', () => {
		expect(parseGitRef('')).toBeUndefined();
		expect(parseGitRef('..')).toBeUndefined();
		expect(parseGitRef('main\norigin')).toBeUndefined();
		expect(parseGitRef('/abs')).toBeUndefined();
	});
});

describe('parseTackleRepositoriesJson', () => {
	it('parses a project-id keyed object with defaults', () => {
		const result = parseTackleRepositoriesJson(`{
			"d_beads_web": { "url": "https://github.com/example-org/beads-web" }
		}`);

		expect(result.error).toBeUndefined();
		expect(result.mappings).toEqual({
			d_beads_web: {
				url: 'https://github.com/example-org/beads-web',
				ref: 'main',
				auto_create_pr: true
			}
		});
	});

	it('honours ref and auto_create_pr', () => {
		const result = parseTackleRepositoriesJson(
			JSON.stringify({
				d_other: {
					url: 'https://github.com/example-org/other',
					ref: 'develop',
					auto_create_pr: false
				}
			})
		);

		expect(result.mappings.d_other).toEqual({
			url: 'https://github.com/example-org/other',
			ref: 'develop',
			auto_create_pr: false
		});
	});

	it('treats empty JSON as no maps', () => {
		expect(parseTackleRepositoriesJson('')).toEqual({ mappings: {} });
		expect(parseTackleRepositoriesJson('{}')).toEqual({ mappings: {} });
	});

	it('fails closed on invalid JSON, keys, URLs, and extra fields', () => {
		const rejected = [
			'{',
			'[]',
			'null',
			'{"beads_web":{"url":"https://github.com/example-org/beads-web"}}',
			'{"d_beads_web":{"url":"https://evil.example/repo"}}',
			'{"d_beads_web":{"url":"https://github.com/example-org/beads-web","token":"x"}}',
			'{"d_beads_web":{"url":"https://github.com/example-org/beads-web","auto_create_pr":"yes"}}'
		];
		for (const raw of rejected) {
			expect(parseTackleRepositoriesJson(raw), raw).toEqual({ mappings: {}, error: 'invalid' });
		}
	});
});

describe('loadTackleRepositoriesFromEnv', () => {
	it('reads inline JSON', () => {
		const result = loadTackleRepositoriesFromEnv({
			BDX_TACKLE_REPOSITORIES: JSON.stringify({
				d_beads_web: { url: 'https://github.com/example-org/beads-web' }
			})
		});

		expect(result.error).toBeUndefined();
		expect(result.mappings.d_beads_web?.url).toBe('https://github.com/example-org/beads-web');
	});

	it('prefers a file over inline JSON', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bdx-tackle-repos-'));
		const path = join(dir, 'maps.json');
		writeFileSync(
			path,
			JSON.stringify({
				d_other: { url: 'https://github.com/example-org/other' }
			})
		);

		const result = loadTackleRepositoriesFromEnv({
			BDX_TACKLE_REPOSITORIES: JSON.stringify({
				d_beads_web: { url: 'https://github.com/example-org/beads-web' }
			}),
			BDX_TACKLE_REPOSITORIES_FILE: path
		});

		expect(result.mappings).toEqual({
			d_other: {
				url: 'https://github.com/example-org/other',
				ref: 'main',
				auto_create_pr: true
			}
		});
		expect(result.mappings.d_beads_web).toBeUndefined();
	});

	it('fails closed when the mapping file cannot be read', () => {
		const result = loadTackleRepositoriesFromEnv({
			BDX_TACKLE_REPOSITORIES_FILE: '/no/such/tackle-repositories.json'
		});

		expect(result).toEqual({ mappings: {}, error: 'invalid' });
	});
});
