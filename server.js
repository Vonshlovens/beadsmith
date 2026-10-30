/**
 * Beadsmith's Node entry: `node server.js` after `pnpm run build`. It serves
 * adapter-node's `build/handler.js` on HOST:PORT (default 127.0.0.1:4321).
 *
 * adapter-node's own `build/index.js` assumes `https` when neither ORIGIN nor
 * PROTOCOL_HEADER is set, so on plain HTTP (the quickstart, `pnpm run serve`,
 * an SSH tunnel) every browser `Origin` would fail the same-origin check in
 * hooks.server.ts. This server has no TLS, so it tells the handler the scheme
 * is `http` through a header it overwrites on every request; a client cannot
 * choose it. Behind a TLS proxy, BDX_PUBLIC_ORIGIN corrects the scheme
 * (src/lib/server/security.ts `expectedOrigin`), as it did under Deno.
 */
import { createServer } from 'node:http';

const PROTOCOL_HEADER = 'x-beadsmith-protocol';
// handler.js reads its configuration when it is first imported.
process.env.PROTOCOL_HEADER = PROTOCOL_HEADER;
const { handler } = await import('./build/handler.js');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4321);

const server = createServer((req, res) => {
	req.headers[PROTOCOL_HEADER] = 'http';
	handler(req, res, () => {
		res.statusCode = 404;
		res.end();
	});
});

server.listen(port, host, () => console.log(`Listening on http://${host}:${port}`));

// Finish in-flight requests on `docker stop`, then exit.
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => {
		server.close(() => process.exit(0));
		server.closeIdleConnections();
		setTimeout(() => process.exit(0), 10_000).unref();
	});
}
