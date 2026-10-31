import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import {
	CLOSE_NOT_ALLOWED_MESSAGE,
	DEFAULT_DISPATCH_ALLOW,
	DISCUSS_NOT_ALLOWED_MESSAGE,
	ELABORATE_NOT_ALLOWED_MESSAGE,
	DISPATCH_ARMED_SETTING_KEY,
	createDispatchPolicyStore,
	deniedOperationMessage,
	dispatchEnabled,
	operationAllowed
} from './policy.js';

let store: ReturnType<typeof createDispatchPolicyStore>;

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createDispatchPolicyStore(client);
});

describe('createDispatchPolicyStore', () => {
	it('defaults to armed with both operations allowed', async () => {
		expect(await store.getArmed()).toBe(true);
		expect(await store.getAllow('d_beads_web')).toEqual(DEFAULT_DISPATCH_ALLOW);
		expect(await store.listAllows()).toEqual({});
	});

	it('round-trips a global disarm without storing secrets', async () => {
		await store.setArmed(false);
		expect(await store.getArmed()).toBe(false);
		await store.setArmed(true);
		expect(await store.getArmed()).toBe(true);
	});

	it('round-trips per-project File vs Tackle allow', async () => {
		await store.putAllow('d_beads_web', { file: true, tackle: false });
		await store.putAllow('d_other', { file: false, tackle: false });

		expect(await store.getAllow('d_beads_web')).toEqual({ file: true, tackle: false });
		expect(await store.listAllows()).toEqual({
			d_beads_web: { file: true, tackle: false },
			d_other: { file: false, tackle: false }
		});
		expect(JSON.stringify(await store.listAllows())).not.toContain(DISPATCH_ARMED_SETTING_KEY);
	});
});

describe('dispatchEnabled', () => {
	it('requires both a configured key and a global arm', () => {
		expect(dispatchEnabled(true, true)).toBe(true);
		expect(dispatchEnabled(true, false)).toBe(false);
		expect(dispatchEnabled(false, true)).toBe(false);
		expect(dispatchEnabled(false, false)).toBe(false);
	});
});

describe('operationAllowed', () => {
	it('gates File, Tackle, and comment independently', () => {
		expect(operationAllowed({ file: true, tackle: false }, 'file')).toBe(true);
		expect(operationAllowed({ file: true, tackle: false }, 'tackle')).toBe(false);
		expect(operationAllowed({ file: true, tackle: false }, 'comment')).toBe(true);
		expect(operationAllowed({ file: false, tackle: true }, 'comment')).toBe(true);
		expect(operationAllowed({ file: false, tackle: false }, 'comment')).toBe(false);
		expect(deniedOperationMessage('file')).toBe('File is not allowed for this project.');
		expect(deniedOperationMessage('tackle')).toBe('Tackle is not allowed for this project.');
		expect(deniedOperationMessage('comment')).toBe('Comment is not allowed for this project.');
	});
});

describe('operationAllowed for discuss', () => {
	it('lets either allow talk, but needs Tackle to change the issue', () => {
		const file_only = { file: true, tackle: false };
		const tackle_only = { file: false, tackle: true };
		const neither = { file: false, tackle: false };

		expect(operationAllowed(file_only, 'discuss', 'discuss')).toBe(true);
		expect(operationAllowed(tackle_only, 'discuss', 'discuss')).toBe(true);
		expect(operationAllowed(neither, 'discuss', 'discuss')).toBe(false);

		for (const intent of ['elaborate', 'close'] as const) {
			expect(operationAllowed(file_only, 'discuss', intent)).toBe(false);
			expect(operationAllowed(tackle_only, 'discuss', intent)).toBe(true);
		}
	});

	it('names the intent in the refusal', () => {
		expect(deniedOperationMessage('discuss', 'discuss')).toBe(DISCUSS_NOT_ALLOWED_MESSAGE);
		expect(deniedOperationMessage('discuss', 'elaborate')).toBe(ELABORATE_NOT_ALLOWED_MESSAGE);
		expect(deniedOperationMessage('discuss', 'close')).toBe(CLOSE_NOT_ALLOWED_MESSAGE);
		expect(deniedOperationMessage('discuss')).toBe(DISCUSS_NOT_ALLOWED_MESSAGE);
	});
});
