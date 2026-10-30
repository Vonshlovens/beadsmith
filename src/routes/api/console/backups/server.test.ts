import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackupStore } from '$lib/server/backup/store.js';
import { createSecretBox, setSecretBox } from '$lib/server/secret-box.js';
import { initStateSchema, setBackupStore } from '$lib/server/state/db.js';
import { GET, PUT } from './+server.js';
import { POST as RUN } from './run/+server.js';

function request(method: string, body?: unknown): Parameters<typeof PUT>[0] {
	return {
		request: new Request('http://localhost/api/console/backups', {
			method,
			body: body === undefined ? undefined : JSON.stringify(body)
		})
	} as unknown as Parameters<typeof PUT>[0];
}

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	const box = await createSecretBox(new Uint8Array(32).fill(4), 'generated');
	setSecretBox(box);
	setBackupStore(createBackupStore(client, async () => box));
});

afterEach(() => {
	setBackupStore(undefined);
	setSecretBox(undefined);
});

describe('/api/console/backups', () => {
	it('saves settings and never echoes secrets', async () => {
		const put = await PUT(
			request('PUT', {
				enabled: true,
				endpoint: 'https://t3.storageapi.dev/',
				bucket: 'beads-backups-abc',
				prefix: '/beadsmith/',
				access_key_id: 'AKIDEXAMPLE1234',
				secret_access_key: 'secret-value-xyz',
				passphrase: 'twelve chars plus'
			})
		);
		expect(put.status).toBe(200);
		const put_text = await put.text();
		expect(put_text).not.toContain('secret-value-xyz');
		expect(put_text).not.toContain('twelve chars plus');
		expect(JSON.parse(put_text).config).toMatchObject({
			endpoint: 'https://t3.storageapi.dev',
			prefix: 'beadsmith',
			configured: true,
			access_key_id_hint: '1234'
		});

		const get = await GET(request('GET') as Parameters<typeof GET>[0]);
		const text = await get.text();
		expect(text).not.toContain('secret-value-xyz');
		expect(text).not.toContain('AKIDEXAMPLE1234');
		expect(JSON.parse(text)).toMatchObject({ running: false, master_key: 'generated', runs: [] });
	});

	it('rejects invalid input and unknown keys', async () => {
		for (const body of [
			{ endpoint: 'https://host/path' },
			{ bucket: 'Bad_Bucket' },
			{ prefix: 'a/../b' },
			{ interval_hours: 0 },
			{ passphrase: 'short' },
			{ access_key_id: 'has space' },
			{ surprise: true }
		]) {
			const response = await PUT(request('PUT', body));
			expect(response.status, JSON.stringify(body)).toBe(400);
		}
	});

	it('refuses to start a run before it is configured', async () => {
		const response = await RUN(request('POST') as unknown as Parameters<typeof RUN>[0]);
		expect(response.status).toBe(400);
	});
});
