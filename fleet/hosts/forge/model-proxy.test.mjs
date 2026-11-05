import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

// Fault injection exercises errors surfaced by HTTP writable streams and
// transforms, without depending on OS-specific reset timing.
const faultInjection = `
import { ServerResponse } from 'node:http';
import { Transform } from 'node:stream';
const responseWrite = ServerResponse.prototype.write;
ServerResponse.prototype.write = function (...args) {
  const written = responseWrite.apply(this, args);
  if (this.req.url.includes('fault=response') && !this.fixtureFault) {
    this.fixtureFault = true;
    queueMicrotask(() => this.emit('error', new Error('fixture response failure')));
  }
  return written;
};
const transformWrite = Transform.prototype.write;
Transform.prototype.write = function (chunk, ...args) {
  const written = transformWrite.call(this, chunk, ...args);
  if (chunk.includes('fixture-transform-failure') && !this.fixtureFault) {
    this.fixtureFault = true;
    queueMicrotask(() => this.emit('error', new Error('fixture transform failure')));
  }
  return written;
};
`;

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

for (const failure of ['disconnect', 'response', 'transform']) {
	test(
		`proxy isolates ${failure} while another stream remains active`,
		{ timeout: 5000 },
		async () => {
			const dir = mkdtempSync(join(tmpdir(), 'model-proxy-fault-'));
			writeFileSync(join(dir, 'key'), 'test-only-credential-0123456789abcdef', { mode: 0o600 });
			writeFileSync(join(dir, 'faults.mjs'), faultInjection);
			let finishSurvivor;
			let confirmClosed;
			const victimClosed = new Promise((resolve) => (confirmClosed = resolve));
			const upstream = createServer((req, res) => {
				req.resume();
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				res.write('data: ' + 'fixture-padding-'.repeat(8) + '\n\n');
				if (req.url.includes('survivor')) {
					finishSurvivor = () => res.end('data: survivor-finished\n\n');
				} else if (req.url.includes('fault=')) {
					res.on('close', confirmClosed);
					if (failure === 'transform') res.write('data: fixture-transform-failure\n\n');
				} else res.end('data: healthy\n\n');
			}).listen(0, '127.0.0.1');
			await once(upstream, 'listening');
			const proxy = spawn(
				process.execPath,
				[
					'--import',
					join(dir, 'faults.mjs'),
					new URL('./model-proxy.mjs', import.meta.url).pathname
				],
				{
					env: {
						...process.env,
						PROXY_BIND: '127.0.0.1',
						PROXY_PORT: '18443',
						UPSTREAM_PORT: String(upstream.address().port),
						PROXY_KEY_FILE: join(dir, 'key')
					},
					stdio: ['ignore', 'ignore', 'pipe']
				}
			);
			proxy.stderr.resume();
			try {
				for (let i = 0; i < 30; i++) {
					try {
						await fetch('http://127.0.0.1:18443/');
						break;
					} catch {
						await new Promise((resolve) => setTimeout(resolve, 20));
					}
				}
				const post = (query, signal = AbortSignal.timeout(2000)) =>
					fetch('http://127.0.0.1:18443/v1/messages?' + query, {
						method: 'POST',
						body: '{}',
						signal
					});
				const survivor = await post('survivor');
				// Attach rejection handling before inducing a failure in another chat.
				const survivorBody = survivor.text().then(
					(body) => ({ body }),
					(error) => ({ error })
				);
				if (failure === 'disconnect') {
					const controller = new AbortController();
					const victim = await post('fault=disconnect', controller.signal);
					const reader = victim.body.getReader();
					await reader.read();
					controller.abort();
				} else {
					await assert.rejects(async () => (await post('fault=' + failure)).text());
				}
				await victimClosed;
				finishSurvivor();
				const result = await survivorBody;
				assert.equal(result.error, undefined, 'another chat must survive');
				assert.match(result.body, /survivor-finished/);
				assert.match(await (await post('healthy')).text(), /healthy/);
				assert.equal(proxy.exitCode, null, 'proxy must remain alive');
			} finally {
				if (proxy.exitCode === null && proxy.signalCode === null) {
					proxy.kill();
					await once(proxy, 'exit');
				}
				upstream.closeAllConnections();
				upstream.close();
				rmSync(dir, { recursive: true });
			}
		}
	);
}
