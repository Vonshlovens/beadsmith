/**
 * Argument checks for the hc client. Everything Beadsmith passes to hc comes
 * through here first: hc has no authentication (ADR-0021), so the client is
 * the place that keeps a request to the shapes Beadsmith means to send.
 *
 * The client never builds shell lines: programs start from `argv`, and hc's
 * `line` (a `sh -c` string) and `on` (another machine) parameters are not
 * offered at all.
 */

import { HcError } from './errors.js';

/**
 * A terminal is an address (`t7`, `t1b`) or a name (1-32 of a-z 0-9 - _ .).
 * Both fit one pattern. `machine/t7` addresses are refused: a sandbox's core
 * has no other machines (ADR-0021 rule 1).
 */
const TERMINAL = /^[a-z0-9_][a-z0-9_.-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const LABEL_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
/** Named keys as hc spells them: enter, esc, ctrl+c, alt+x, f5, a. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9+_-]{0,31}$/;

export const MAX_ARGV = 256;
export const MAX_ARG = 128 * 1024;
export const MAX_ENV_VALUE = 32 * 1024;
export const MAX_LABEL_VALUE = 256;
export const MAX_TEXT = 1024 * 1024;
export const MAX_PATH = 4096;
export const MAX_KEYS = 64;
export const MAX_TIMEOUT_SECONDS = 3600;
export const MAX_HISTORY = 100_000;

function invalid(message: string): HcError {
	return new HcError(message, { kind: 'invalid_params' });
}

function noNul(value: string, what: string): void {
	if (value.includes('\0')) throw invalid(`${what} contains a NUL byte`);
}

export function terminalId(value: unknown): string {
	if (typeof value !== 'string' || !TERMINAL.test(value) || /^\.+$/.test(value)) {
		throw invalid('terminal must be an address like t7 or a name of 1-32 of a-z 0-9 - _ .');
	}
	return value;
}

export function argv(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARGV) {
		throw invalid(`argv must be 1-${MAX_ARGV} strings`);
	}
	return value.map((arg, i) => {
		if (typeof arg !== 'string' || arg.length > MAX_ARG) {
			throw invalid(`argv[${i}] must be a string of at most ${MAX_ARG} characters`);
		}
		noNul(arg, `argv[${i}]`);
		if (i === 0 && arg.length === 0) throw invalid('argv[0] must name a program');
		return arg;
	});
}

export function absolutePath(value: unknown, what: string): string {
	if (typeof value !== 'string' || !value.startsWith('/') || value.length > MAX_PATH) {
		throw invalid(`${what} must be an absolute path`);
	}
	noNul(value, what);
	return value;
}

export function env(value: unknown): Record<string, string> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw invalid('env must be an object of strings');
	}
	const out: Record<string, string> = {};
	for (const [name, v] of Object.entries(value)) {
		if (!ENV_NAME.test(name)) throw invalid(`env name ${JSON.stringify(name)} is not valid`);
		if (typeof v !== 'string' || v.length > MAX_ENV_VALUE) {
			throw invalid(`env ${name} must be a string of at most ${MAX_ENV_VALUE} characters`);
		}
		noNul(v, `env ${name}`);
		out[name] = v;
	}
	return out;
}

export function labels(value: unknown): Record<string, string> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw invalid('labels must be an object of strings');
	}
	const out: Record<string, string> = {};
	for (const [key, v] of Object.entries(value)) {
		if (!LABEL_KEY.test(key)) throw invalid(`label key ${JSON.stringify(key)} is not valid`);
		if (typeof v !== 'string' || v.length > MAX_LABEL_VALUE || /[\0\n\r]/.test(v)) {
			throw invalid(`label ${key} must be one line of at most ${MAX_LABEL_VALUE} characters`);
		}
		out[key] = v;
	}
	return out;
}

/** Text pasted into a program: anything printable, but not empty and not NUL. */
export function text(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT) {
		throw invalid(`text must be 1-${MAX_TEXT} characters`);
	}
	noNul(value, 'text');
	return value;
}

export function keys(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_KEYS) {
		throw invalid(`keys must be 1-${MAX_KEYS} key names`);
	}
	return value.map((key) => {
		if (typeof key !== 'string' || !KEY.test(key)) {
			throw invalid(`${JSON.stringify(key)} is not a key name`);
		}
		return key;
	});
}

export function timeoutSeconds(value: unknown): number {
	if (
		typeof value !== 'number' ||
		!Number.isFinite(value) ||
		value <= 0 ||
		value > MAX_TIMEOUT_SECONDS
	) {
		throw invalid(`timeout must be more than 0 and at most ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return value;
}

export function integer(value: unknown, what: string, min: number, max: number): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
		throw invalid(`${what} must be an integer from ${min} to ${max}`);
	}
	return value;
}

/** A viewer's size in cells. hc takes u16; nothing real is near that. */
export function cells(value: unknown, what: string): number {
	return integer(value, what, 1, 1000);
}

export function history(value: unknown): number {
	return integer(value, 'history', 0, MAX_HISTORY);
}
