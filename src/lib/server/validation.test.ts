import { describe, expect, it } from 'vitest';
import {
	ISSUE_ID_PATTERN,
	activity_query_schema,
	dispatch_allow_schema,
	dispatch_arm_schema,
	dispatch_schema,
	follow_up_schema,
	FOLLOW_UP_TEXT_MAX,
	issue_id_schema,
	list_query_schema,
	parseFileMapBody,
	parseJsonBody,
	parseQuery,
	parseTackleMapBody,
	parseValue,
	project_id_schema,
	tackle_map_schema,
	file_map_schema,
	theme_schema
} from './validation.js';

describe('issue id validation', () => {
	it('accepts documented issue ids and rejects traversal', () => {
		expect(ISSUE_ID_PATTERN.test('bd-1')).toBe(true);
		expect(ISSUE_ID_PATTERN.test('acme-platform-0sd')).toBe(true);
		expect(ISSUE_ID_PATTERN.test('bd-1.2')).toBe(true);
		expect(ISSUE_ID_PATTERN.test('../etc/passwd')).toBe(false);
		expect(ISSUE_ID_PATTERN.test('bd-1/../bd-2')).toBe(false);
	});

	it('accepts nested children and underscore prefixes, bounded in length', () => {
		expect(ISSUE_ID_PATTERN.test('beads-web-9nu.5.4')).toBe(true);
		expect(ISSUE_ID_PATTERN.test('demo_alpha-t4e')).toBe(true);
		expect(ISSUE_ID_PATTERN.test('bd-1.')).toBe(false);
		expect(ISSUE_ID_PATTERN.test('bd-1..2')).toBe(false);
		expect(ISSUE_ID_PATTERN.test('_bd-1')).toBe(false);
		expect(ISSUE_ID_PATTERN.test(`bd-1${'.1'.repeat(70)}`)).toBe(false);
	});

	it('returns bad_request for an invalid id', () => {
		const result = parseValue(issue_id_schema, '../x');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.response.status).toBe(400);
		}
	});
});

describe('remote project ids', () => {
	it('accepts only remote d_ ids', () => {
		expect(parseValue(project_id_schema, 'd_acme_platform').ok).toBe(true);
		expect(parseValue(project_id_schema, 'w_0123456789abcdef').ok).toBe(false);
		expect(parseValue(project_id_schema, 'd_ACME').ok).toBe(false);
	});
});

describe('read query validation', () => {
	it('defaults and validates issue-list filters', () => {
		const result = parseQuery(new URLSearchParams(''), list_query_schema);
		expect(result.ok && result.data.limit).toBe(200);
		expect(result.ok && result.data.include_closed).toBe(false);
		expect(parseQuery(new URLSearchParams('limit=25'), list_query_schema).ok).toBe(true);
		expect(parseQuery(new URLSearchParams('limit=100000'), list_query_schema).ok).toBe(false);
		expect(parseQuery(new URLSearchParams('priority=9'), list_query_schema).ok).toBe(false);
	});

	it('defaults and caps activity requests', () => {
		const result = parseQuery(new URLSearchParams(''), activity_query_schema);
		expect(result.ok && result.data.limit).toBe(50);
		expect(parseQuery(new URLSearchParams('limit=100000'), activity_query_schema).ok).toBe(false);
	});
});

describe('theme settings', () => {
	it('accepts only the supported preferences', () => {
		expect(parseValue(theme_schema, { theme: 'system' }).ok).toBe(true);
		expect(parseValue(theme_schema, { theme: 'light' }).ok).toBe(true);
		expect(parseValue(theme_schema, { theme: 'dark' }).ok).toBe(true);
		expect(parseValue(theme_schema, { theme: 'solarized' }).ok).toBe(false);
	});
});

describe('dispatch body', () => {
	it('accepts file, tackle, and comment payloads and rejects other operations', () => {
		expect(
			parseValue(dispatch_schema, {
				operation: 'file',
				idempotency_key: 'idem-aaaaaaaa',
				notes: 'File this.'
			}).ok
		).toBe(true);
		expect(
			parseValue(dispatch_schema, {
				operation: 'tackle',
				idempotency_key: 'idem-aaaaaaaa',
				issue_id: 'beads-web-1'
			}).ok
		).toBe(true);
		expect(
			parseValue(dispatch_schema, {
				operation: 'comment',
				idempotency_key: 'idem-aaaaaaaa',
				issue_id: 'beads-web-1',
				text: 'Please keep the composer.'
			}).ok
		).toBe(true);
		expect(
			parseValue(dispatch_schema, {
				operation: 'close',
				idempotency_key: 'idem-aaaaaaaa',
				issue_id: 'beads-web-1'
			}).ok
		).toBe(false);
		expect(
			parseValue(dispatch_schema, {
				operation: 'file',
				idempotency_key: 'short',
				notes: 'File this.'
			}).ok
		).toBe(false);
		expect(
			parseValue(dispatch_schema, {
				operation: 'tackle',
				idempotency_key: 'idem-aaaaaaaa',
				issue_id: 'beads-web-1',
				repository: 'https://github.com/evil/repo'
			}).ok
		).toBe(false);
		expect(
			parseValue(dispatch_schema, {
				operation: 'file',
				idempotency_key: 'idem-aaaaaaaa',
				notes: 'File this.',
				repository: 'https://github.com/evil/repo'
			}).ok
		).toBe(false);
		expect(
			parseValue(dispatch_schema, {
				operation: 'comment',
				idempotency_key: 'idem-aaaaaaaa',
				issue_id: 'beads-web-1',
				text: 'Hello',
				author: 'spoofed@example.com'
			}).ok
		).toBe(false);
		expect(
			parseValue(dispatch_schema, {
				operation: 'comment',
				idempotency_key: 'idem-aaaaaaaa',
				issue_id: 'beads-web-1',
				text: 'Hello',
				repository: 'https://github.com/evil/repo'
			}).ok
		).toBe(false);
		expect(
			parseValue(dispatch_schema, {
				operation: 'file',
				idempotency_key: 'idem-aaaaaaaa',
				notes: 'File this.',
				armed: true
			}).ok
		).toBe(false);
		expect(
			parseValue(dispatch_schema, {
				operation: 'file',
				idempotency_key: 'idem-aaaaaaaa',
				notes: 'File this.',
				status: 'in_progress'
			}).ok
		).toBe(true);
		expect(
			parseValue(dispatch_schema, {
				operation: 'file',
				idempotency_key: 'idem-aaaaaaaa',
				notes: 'File this.',
				status: 'wontfix'
			}).ok
		).toBe(false);
		expect(
			parseValue(dispatch_schema, {
				operation: 'tackle',
				idempotency_key: 'idem-aaaaaaaa',
				issue_id: 'beads-web-1',
				file: true
			}).ok
		).toBe(false);
	});
});

describe('discuss dispatch body', () => {
	const base = { operation: 'discuss', idempotency_key: 'idem-aaaaaaaa', issue_id: 'beads-web-1' };

	it('accepts each intent with an optional message', () => {
		for (const intent of ['discuss', 'elaborate', 'close']) {
			expect(parseValue(dispatch_schema, { ...base, intent }).ok).toBe(true);
		}
		const parsed = parseValue(dispatch_schema, {
			...base,
			intent: 'close',
			message: '  shipped in eec9e6a  '
		});
		expect(parsed.ok && parsed.data.operation === 'discuss' && parsed.data.message).toBe(
			'shipped in eec9e6a'
		);
	});

	it('rejects unknown intents, empty or oversized messages, and extra keys', () => {
		expect(parseValue(dispatch_schema, { ...base, intent: 'tackle' }).ok).toBe(false);
		expect(parseValue(dispatch_schema, base).ok).toBe(false);
		expect(parseValue(dispatch_schema, { ...base, intent: 'discuss', message: '   ' }).ok).toBe(
			false
		);
		expect(
			parseValue(dispatch_schema, {
				...base,
				intent: 'discuss',
				message: 'x'.repeat(FOLLOW_UP_TEXT_MAX + 1)
			}).ok
		).toBe(false);
		expect(
			parseValue(dispatch_schema, { ...base, intent: 'discuss', repository: 'https://x' }).ok
		).toBe(false);
		expect(parseValue(dispatch_schema, { ...base, intent: 'discuss', issue_id: '../x' }).ok).toBe(
			false
		);
	});
});

describe('follow-up body', () => {
	it('accepts only size-capped text', () => {
		expect(parseValue(follow_up_schema, { text: 'Also add tests.' }).ok).toBe(true);
		expect(parseValue(follow_up_schema, { text: '   ' }).ok).toBe(false);
		expect(
			parseValue(follow_up_schema, {
				text: 'Also add tests.',
				model: 'composer'
			}).ok
		).toBe(false);
		expect(
			parseValue(follow_up_schema, {
				text: 'x'.repeat(FOLLOW_UP_TEXT_MAX + 1)
			}).ok
		).toBe(false);
	});
});

describe('parseJsonBody', () => {
	it('rejects malformed JSON', async () => {
		const request = new Request('http://localhost/api/settings/theme', {
			method: 'POST',
			body: 'not json'
		});
		const result = await parseJsonBody(request, theme_schema);
		expect(result.ok).toBe(false);
	});

	it('returns validated settings data', async () => {
		const request = new Request('http://localhost/api/settings/theme', {
			method: 'POST',
			body: JSON.stringify({ theme: 'dark' })
		});
		const result = await parseJsonBody(request, theme_schema);
		expect(result.ok && result.data.theme).toBe('dark');
	});
});

describe('console Tackle map body', () => {
	it('accepts a GitHub checkout and defaults ref/PR', () => {
		expect(parseTackleMapBody({ url: 'https://github.com/example-org/beads-web' })).toEqual({
			url: 'https://github.com/example-org/beads-web',
			ref: 'main',
			auto_create_pr: true
		});
	});

	it('rejects extra keys and non-GitHub URLs', () => {
		expect(
			parseValue(tackle_map_schema, {
				url: 'https://github.com/example-org/beads-web',
				token: 'x'
			}).ok
		).toBe(false);
		expect(parseTackleMapBody({ url: 'https://evil.example/repo' })).toBeUndefined();
		expect(parseTackleMapBody({ url: 'https://github.com/example-org/beads-web', ref: '..' })).toBe(
			undefined
		);
	});
});

describe('console File map body', () => {
	it('accepts a GitHub checkout and defaults ref', () => {
		expect(parseFileMapBody({ url: 'https://github.com/example-org/other' })).toEqual({
			url: 'https://github.com/example-org/other',
			ref: 'main'
		});
	});

	it('rejects extra keys, a PR flag, and non-GitHub URLs', () => {
		expect(
			parseValue(file_map_schema, {
				url: 'https://github.com/example-org/other',
				auto_create_pr: false
			}).ok
		).toBe(false);
		expect(
			parseValue(file_map_schema, {
				url: 'https://github.com/example-org/other',
				token: 'x'
			}).ok
		).toBe(false);
		expect(parseFileMapBody({ url: 'https://evil.example/repo' })).toBeUndefined();
		expect(parseFileMapBody({ url: 'https://github.com/example-org/other', ref: '..' })).toBe(
			undefined
		);
	});
});

describe('console dispatch policy bodies', () => {
	it('accepts arm and allow payloads and rejects extra keys', () => {
		expect(parseValue(dispatch_arm_schema, { armed: false }).ok).toBe(true);
		expect(parseValue(dispatch_arm_schema, { armed: true, secret: 'x' }).ok).toBe(false);
		expect(parseValue(dispatch_allow_schema, { file: true, tackle: false }).ok).toBe(true);
		expect(
			parseValue(dispatch_allow_schema, { file: true, tackle: false, repository: 'https://x' }).ok
		).toBe(false);
	});
});
