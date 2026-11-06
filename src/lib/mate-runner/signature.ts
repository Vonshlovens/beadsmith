/**
 * Request signatures, the runner's half of the scheme webhook contract v1
 * uses (src/lib/server/dispatch/webhook-provider.ts): `x-beadsmith-signature:
 * v1=<hex HMAC-SHA256>` of `<timestamp>.<METHOD> <target>\n<body>`, where the
 * target is the request's path and query exactly as sent.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a request's timestamp may be from the runner's clock. */
export const MAX_CLOCK_SKEW_SECONDS = 300;

export interface SignedRequest {
	method: string;
	target: string;
	body: string;
	timestamp: string | undefined;
	signature: string | undefined;
}

export function signRequest(
	secret: string,
	timestamp: string,
	method: string,
	target: string,
	body: string
): string {
	const mac = createHmac('sha256', secret)
		.update(`${timestamp}.${method} ${target}\n${body}`)
		.digest('hex');
	return `v1=${mac}`;
}

/** True when the request is signed with `secret` and recent. */
export function verifyRequest(secret: string, request: SignedRequest, now: Date): boolean {
	const { timestamp, signature } = request;
	if (timestamp === undefined || signature === undefined || !/^\d{1,12}$/.test(timestamp)) {
		return false;
	}
	const skew = Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp));
	if (skew > MAX_CLOCK_SKEW_SECONDS) return false;
	const expected = Buffer.from(
		signRequest(secret, timestamp, request.method, request.target, request.body)
	);
	const given = Buffer.from(signature);
	return given.length === expected.length && timingSafeEqual(given, expected);
}
