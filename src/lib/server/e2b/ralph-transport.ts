/**
 * Reach `ralph serve` inside a Sand sandbox (ADR-0019 rule 3). ralph listens
 * on the sandbox's loopback only, so Beadsmith never opens a port: each
 * request is a `curl` to loopback run over the E2B process channel Beadsmith
 * already holds, as a command in the sandbox's default user's shell.
 *
 * - JSON calls run to completion with `exec`; curl appends the HTTP status
 *   on its own last line, which becomes the Response's status.
 * - The event stream runs with `follow`, which hands stdout over as it
 *   arrives; the chunks become the Response's body, and the stream ends when
 *   curl does (ralph's `end` frame, or a dropped channel).
 *
 * Nothing from the request reaches the shell unquoted: the path is
 * re-checked against the ADR-0019 allowlist here (a second gate after the
 * client's), headers are limited to the three the client sends with values
 * of a known shape, and a body travels base64-encoded in an environment
 * variable.
 */
import { ralphRouteAllowed, type RalphFetch, type RalphRequest } from '../dispatch/ralph.js';
import type { SandboxRef } from './sandbox.js';

/** The port `ralph serve` listens on inside the sandbox (ralph's default). */
export const RALPH_SERVE_PORT = 7420;

const HEADER_VALUES: Record<string, RegExp> = {
	accept: /^(application\/json|text\/event-stream)$/,
	'content-type': /^application\/json$/,
	'last-event-id': /^[0-9]{1,15}$/
};

/** Separates curl's status line from the body (a body may lack a final newline). */
const STATUS_MARK = '\n__beadsmith_status=';

function curlCommand(request: RalphRequest, stream: boolean): string {
	if (!ralphRouteAllowed(request.method, request.path)) {
		throw new Error('Beadsmith does not call that ralph route.');
	}
	// A stream lasts as long as the loop; a JSON call answers at once.
	const args = ['curl', '-sS', ...(stream ? [] : ['--max-time', '30']), '-X', request.method];
	for (const [name, value] of Object.entries(request.headers)) {
		const pattern = HEADER_VALUES[name.toLowerCase()];
		if (pattern === undefined || !pattern.test(value)) {
			throw new Error(`Refusing ralph request header ${name}.`);
		}
		args.push('-H', `'${name}: ${value}'`);
	}
	if (stream) args.push('-N', '--fail');
	else args.push('-w', `'${STATUS_MARK.replace('\n', '\\n')}%{http_code}'`);
	if (request.body !== undefined) args.push('--data-binary', '@-');
	args.push(`'http://127.0.0.1:${RALPH_SERVE_PORT}${request.path}'`);
	const curl = args.join(' ');
	return request.body === undefined ? curl : `printf %s "$RALPH_BODY" | base64 -d | ${curl}`;
}

/** Split curl's output into the body and the status it appended. */
export function parseCurlOutput(stdout: string): { status: number; body: string } | undefined {
	const at = stdout.lastIndexOf(STATUS_MARK);
	if (at === -1) return undefined;
	const status = Number(stdout.slice(at + STATUS_MARK.length).trim());
	if (!Number.isInteger(status) || status < 100 || status > 599) return undefined;
	return { status, body: stdout.slice(0, at) };
}

/** A {@link RalphFetch} that runs each request as a curl inside `sandbox`. */
export function sandboxRalphFetch(sandbox: SandboxRef): RalphFetch {
	return async (request) => {
		const stream = request.headers.accept === 'text/event-stream';
		const command = curlCommand(request, stream);
		const envs =
			request.body === undefined
				? undefined
				: { RALPH_BODY: Buffer.from(request.body).toString('base64') };
		if (!stream) {
			const { exit_code, stdout } = await sandbox.exec(command, envs);
			const answer = exit_code === 0 ? parseCurlOutput(stdout) : undefined;
			// curl could not connect (ralph serve not up yet) or answered nonsense.
			if (answer === undefined) throw new Error(`ralph serve did not answer (curl ${exit_code}).`);
			return new Response(answer.status === 204 ? null : answer.body, {
				status: answer.status,
				headers: { 'content-type': 'application/json' }
			});
		}
		const encoder = new TextEncoder();
		const controller = new AbortController();
		request.signal?.addEventListener('abort', () => controller.abort(), { once: true });
		let open = true;
		const body = new ReadableStream<Uint8Array>({
			start(sink) {
				const close = () => {
					if (open) sink.close();
					open = false;
				};
				sandbox
					.follow(
						command,
						(chunk) => {
							if (open) sink.enqueue(encoder.encode(chunk));
						},
						controller.signal
					)
					// However curl ends, the body ends; the reader sees no `end` frame
					// unless ralph sent one, and reports a disconnect.
					.then(close, close);
			},
			cancel() {
				open = false;
				controller.abort();
			}
		});
		return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
	};
}
