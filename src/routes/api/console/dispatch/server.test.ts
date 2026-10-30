import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DispatchPolicyStore } from '$lib/server/dispatch/policy.js';
import { setDispatchPolicyStore } from '$lib/server/state/db.js';
import { PUT } from './+server.js';

let armed = true;

function fakeStore(): DispatchPolicyStore {
	return {
		async getArmed() {
			return armed;
		},
		async setArmed(next) {
			armed = next;
		},
		async getAllow() {
			return { file: true, tackle: true };
		},
		async listAllows() {
			return {};
		},
		async putAllow() {
			return;
		}
	};
}

function putRequest(body: unknown): Parameters<typeof PUT>[0] {
	return {
		request: new Request('http://localhost/api/console/dispatch', {
			method: 'PUT',
			body: JSON.stringify(body)
		})
	} as unknown as Parameters<typeof PUT>[0];
}

beforeEach(() => {
	armed = true;
	setDispatchPolicyStore(fakeStore());
});

afterEach(() => {
	setDispatchPolicyStore(undefined);
});

describe('PUT /api/console/dispatch', () => {
	it('disarms and rearms without accepting extra keys', async () => {
		const disarmed = await PUT(putRequest({ armed: false }));
		expect(disarmed.status).toBe(200);
		expect(await disarmed.json()).toEqual({ armed: false });
		expect(armed).toBe(false);

		const rearmed = await PUT(putRequest({ armed: true }));
		expect(await rearmed.json()).toEqual({ armed: true });
		expect(armed).toBe(true);
	});

	it('rejects extra keys so the browser cannot smuggle policy', async () => {
		const response = await PUT(putRequest({ armed: false, secret: 'x' }));
		expect(response.status).toBe(400);
		expect(armed).toBe(true);
	});
});
