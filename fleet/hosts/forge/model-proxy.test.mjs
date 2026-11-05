import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('model boundary streams, strips credentials, blocks admin and redacts reflected key', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'model-proxy-test-'));
	const key = 'test-only-credential-0123456789abcdef';
	writeFileSync(join(dir, 'key'), key, { mode: 0o600 });
	let received;
	const upstream = createServer((req, res) => {
		received = req.headers;
		req.resume();
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'set-cookie': key,
			authorization: key
		});
		res.write('data: ' + key.slice(0, 10));
		setImmediate(() => res.end(key.slice(10) + '\n\n'));
	}).listen(0, '127.0.0.1');
	await once(upstream, 'listening');
	const proxy = spawn(process.execPath, [new URL('./model-proxy.mjs', import.meta.url).pathname], {
		env: {
			...process.env,
			PROXY_BIND: '127.0.0.1',
			PROXY_PORT: '18443',
			UPSTREAM_PORT: String(upstream.address().port),
			PROXY_KEY_FILE: join(dir, 'key')
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	try {
		// Bounded startup retry, not an operational polling loop.
		let ready;
		for (let i = 0; i < 30; i++) {
			try {
				ready = await fetch('http://127.0.0.1:18443/');
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
		assert.equal(ready.status, 404);
		for (const path of [
			'/admin/api/accounts',
			'/v1/messages/../admin',
			'/v1/messages%2f..%2fadmin'
		]) {
			assert.equal((await fetch('http://127.0.0.1:18443' + path, { method: 'POST' })).status, 404);
		}
		const res = await fetch('http://127.0.0.1:18443/v1/messages?beta=true', {
			method: 'POST',
			headers: {
				authorization: 'Bearer placeholder',
				'x-api-key': 'guest',
				cookie: 'private',
				'x-app': 'cli'
			},
			body: '{}'
		});
		assert.equal(res.status, 200);
		assert.equal(received.authorization, 'Bearer ' + key);
		assert.equal(received['x-api-key'], undefined);
		assert.equal(received.cookie, undefined);
		assert.equal(received['x-app'], 'cli');
		assert.equal(res.headers.get('set-cookie'), null);
		assert.equal(res.headers.get('authorization'), null);
		assert.equal(await res.text(), 'data: ' + '*'.repeat(key.length) + '\n\n');
	} finally {
		proxy.kill();
		await once(proxy, 'exit');
		upstream.close();
		rmSync(dir, { recursive: true });
	}
});
