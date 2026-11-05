import { describe, expect, it } from 'vitest';
import { signWebhookRequest } from '../server/dispatch/webhook-provider.js';
import { signRequest, verifyRequest } from './signature.js';

const SECRET = 'x'.repeat(40);
const NOW = new Date('2026-11-05T12:00:00Z');
const TS = String(Math.floor(NOW.getTime() / 1000));

describe('request signatures', () => {
	it('matches what Beadsmith signs', async () => {
		const target = '/v1/mate/chats/abc/events?after=e000000003';
		expect(signRequest(SECRET, TS, 'GET', target, '')).toBe(
			await signWebhookRequest(SECRET, TS, 'GET', target, '')
		);
	});

	it('accepts a fresh signed request', () => {
		const body = '{"prompt":"hi"}';
		const signature = signRequest(SECRET, TS, 'POST', '/v1/mate/chats/a/messages', body);
		expect(
			verifyRequest(
				SECRET,
				{ method: 'POST', target: '/v1/mate/chats/a/messages', body, timestamp: TS, signature },
				NOW
			)
		).toBe(true);
	});

	it('rejects tampering, another target, stale or missing headers', () => {
		const signature = signRequest(SECRET, TS, 'POST', '/v1/mate/chats/a/messages', '{}');
		const base = {
			method: 'POST',
			target: '/v1/mate/chats/a/messages',
			body: '{}',
			timestamp: TS,
			signature
		};
		expect(verifyRequest(SECRET, { ...base, body: '{"x":1}' }, NOW)).toBe(false);
		expect(verifyRequest(SECRET, { ...base, target: '/v1/mate/chats/b/messages' }, NOW)).toBe(
			false
		);
		expect(verifyRequest(SECRET, { ...base, method: 'DELETE' }, NOW)).toBe(false);
		expect(verifyRequest('y'.repeat(40), base, NOW)).toBe(false);
		expect(verifyRequest(SECRET, base, new Date(NOW.getTime() + 301_000))).toBe(false);
		expect(verifyRequest(SECRET, { ...base, signature: undefined }, NOW)).toBe(false);
		expect(verifyRequest(SECRET, { ...base, timestamp: 'soon' }, NOW)).toBe(false);
	});
});
