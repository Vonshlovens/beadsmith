/**
 * Sanitizers for runner output. Every provider passes run summaries, errors,
 * and PR links through these so credential-shaped text never reaches SQLite
 * or the browser.
 */

export const RESULT_SUMMARY_MAX_LENGTH = 4_000;

export function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Drop ANSI/OSC sequences without trying to interpret a PTY transcript.
 */
export function stripTerminalNoise(value: string): string {
	return value
		.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
		.replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
		.replace(/\u001B[@-Z\\-_]/g, '');
}

/**
 * Reduce runner text to a bounded public summary and redact credential
 * shapes. The exact secret is removed even when the surrounding text does not
 * identify it as a credential.
 */
export function sanitizeResultSummary(value: unknown, secret: string): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	let summary = stripTerminalNoise(value)
		.replace(/\r\n?/g, '\n')
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
		.trim();
	if (summary.length === 0) {
		return undefined;
	}
	if (secret.length > 0) {
		summary = summary.split(secret).join('[redacted]');
	}
	summary = summary
		.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
		.replace(/\b(?:api[_ -]?key|authorization)\s*[:=]\s*\S+/gi, '[redacted credential]')
		.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9._-]{8,})\b/g, '[redacted]');
	if (summary.length > RESULT_SUMMARY_MAX_LENGTH) {
		summary = `${summary.slice(0, RESULT_SUMMARY_MAX_LENGTH - 1)}…`;
	}
	return summary;
}

export function readDurationMs(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** A GitHub pull request URL with no credentials, query, or fragment. */
export function readGithubPullUrl(value: unknown, secret: string): string | undefined {
	const candidate = asNonEmptyString(value);
	if (candidate === undefined || (secret.length > 0 && candidate.includes(secret))) {
		return undefined;
	}
	try {
		const url = new URL(candidate);
		if (
			url.protocol === 'https:' &&
			url.hostname === 'github.com' &&
			url.username === '' &&
			url.password === '' &&
			url.search === '' &&
			url.hash === '' &&
			/^\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*\/?$/.test(url.pathname)
		) {
			return url.toString().replace(/\/$/, '');
		}
	} catch {
		// Ignore malformed and non-HTTPS PR URLs.
	}
	return undefined;
}
