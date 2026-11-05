// Only the Anthropic model surface crosses the guest boundary. Never log
// headers, bodies, or upstream errors: any of them can contain credentials.
import { createServer, request } from 'node:http';
import { readFileSync } from 'node:fs';
import { Transform } from 'node:stream';
const key = readFileSync(process.env.PROXY_KEY_FILE, 'utf8').trim();
if (key.length < 32) throw new Error('Proxy credential is invalid');
const allowed = new Set(['/v1/messages', '/v1/messages/count_tokens']);
const requestHeaders =
	/^(content-type|accept|user-agent|x-app|anthropic-[a-z-]+|x-stainless-[a-z-]+|x-claude-code-session-id)$/;
createServer((req, res) => {
	if (req.method !== 'POST' || !allowed.has(req.url.split('?')[0])) {
		res.writeHead(404).end();
		return;
	}
	const headers = {};
	for (const [name, value] of Object.entries(req.headers)) {
		if (requestHeaders.test(name)) headers[name] = value;
	}
	headers.authorization = `Bearer ${key}`;
	const upstream = request(
		{
			hostname: '127.0.0.1',
			port: Number(process.env.UPSTREAM_PORT ?? 8080),
			path: req.url,
			method: 'POST',
			headers
		},
		(reply) => {
			// No redirects, cookies, auth headers or arbitrary diagnostic headers.
			const safe = {};
			for (const name of ['content-type', 'retry-after']) {
				if (reply.headers[name]) safe[name] = reply.headers[name];
			}
			if (reply.statusCode >= 300 && reply.statusCode < 400) {
				reply.resume();
				res.writeHead(502).end();
				return;
			}
			res.writeHead(reply.statusCode, safe);
			// Keep enough trailing bytes to redact a key split across chunks.
			let pending = Buffer.alloc(0);
			const secret = Buffer.from(key);
			const scrub = new Transform({
				transform(chunk, encoding, done) {
					pending = Buffer.concat([pending, chunk]);
					let index;
					while ((index = pending.indexOf(secret)) !== -1)
						pending.fill(42, index, index + secret.length);
					const end = Math.max(0, pending.length - secret.length + 1);
					this.push(pending.subarray(0, end));
					pending = pending.subarray(end);
					done();
				},
				flush(done) {
					this.push(pending);
					done();
				}
			});
			reply.pipe(scrub).pipe(res);
			reply.on('error', () => res.destroy());
		}
	);
	upstream.on('error', () => {
		if (!res.headersSent) res.writeHead(502);
		res.end();
	});
	req.on('aborted', () => upstream.destroy());
	res.on('close', () => upstream.destroy());
	req.pipe(upstream);
}).listen(Number(process.env.PROXY_PORT), process.env.PROXY_BIND);
