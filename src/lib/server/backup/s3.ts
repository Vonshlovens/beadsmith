/**
 * Minimal S3-compatible client (AWS Signature Version 4) for backups:
 * PUT, GET, ListObjectsV2, and DELETE over `fetch`. Works with Railway
 * Buckets, AWS S3, R2, MinIO, and other S3 APIs. Credentials stay in memory;
 * errors never include them or the request signature.
 */

export type S3UrlStyle = 'virtual-host' | 'path';

export interface S3Config {
	/** Scheme and host, e.g. `https://t3.storageapi.dev`. No path. */
	endpoint: string;
	bucket: string;
	/** Signing region; `auto` for providers that ignore it. */
	region: string;
	url_style: S3UrlStyle;
	access_key_id: string;
	secret_access_key: string;
}

export interface S3ListResult {
	keys: string[];
	/** Common prefixes when listing with a delimiter. */
	prefixes: string[];
}

export interface S3Client {
	put(key: string, body: Uint8Array, content_type?: string): Promise<void>;
	get(key: string): Promise<Uint8Array>;
	list(prefix: string, delimiter?: string): Promise<S3ListResult>;
	delete(key: string): Promise<void>;
}

export interface S3ClientDeps {
	fetch?: typeof fetch;
	now?: () => Date;
}

/** Sanitized S3 failure: status, provider error code, and operation only. */
export class S3Error extends Error {
	readonly status: number;
	readonly code: string | undefined;

	constructor(operation: string, status: number, code: string | undefined) {
		super(
			status === 0
				? `Storage ${operation} failed: the endpoint could not be reached.`
				: `Storage ${operation} failed with HTTP ${status}${code === undefined ? '' : ` (${code})`}.`
		);
		this.name = 'S3Error';
		this.status = status;
		this.code = code;
	}
}

const encoder = new TextEncoder();
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function toHex(bytes: ArrayBuffer | Uint8Array): string {
	return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) =>
		b.toString(16).padStart(2, '0')
	).join('');
}

/** SHA-256 hex digest. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
	const bytes = typeof data === 'string' ? encoder.encode(data) : data;
	return toHex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
	const imported = await crypto.subtle.importKey(
		'raw',
		key as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	return new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(data)));
}

/** RFC 3986 encoding as SigV4 requires; `/` kept when encoding a path. */
export function uriEncode(value: string, keep_slash: boolean): string {
	let out = '';
	for (const byte of encoder.encode(value)) {
		const ch = String.fromCharCode(byte);
		if (/[A-Za-z0-9\-_.~]/.test(ch) || (keep_slash && ch === '/')) {
			out += ch;
		} else {
			out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
		}
	}
	return out;
}

export interface SignInput {
	method: string;
	/** Host header value. */
	host: string;
	/** Unencoded absolute path, e.g. `/bucket/key` or `/key`. */
	path: string;
	query: Record<string, string>;
	/** Extra headers to sign (lower-case names). */
	headers: Record<string, string>;
	payload_sha256: string;
	access_key_id: string;
	secret_access_key: string;
	region: string;
	now: Date;
}

/**
 * Compute SigV4 headers for an S3 request.
 * @returns Headers to send, including `authorization`.
 */
export async function signRequest(input: SignInput): Promise<Record<string, string>> {
	const amz_date = input.now
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}/, '');
	const date = amz_date.slice(0, 8);
	const headers: Record<string, string> = {
		...input.headers,
		host: input.host,
		'x-amz-content-sha256': input.payload_sha256,
		'x-amz-date': amz_date
	};
	const names = Object.keys(headers)
		.map((name) => name.toLowerCase())
		.sort();
	const canonical_headers = names
		.map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, ' ')}\n`)
		.join('');
	const signed_headers = names.join(';');
	const canonical_query = Object.keys(input.query)
		.sort()
		.map((key) => `${uriEncode(key, false)}=${uriEncode(input.query[key], false)}`)
		.join('&');
	const canonical_request = [
		input.method,
		uriEncode(input.path, true),
		canonical_query,
		canonical_headers,
		signed_headers,
		input.payload_sha256
	].join('\n');
	const scope = `${date}/${input.region}/s3/aws4_request`;
	const string_to_sign = [
		'AWS4-HMAC-SHA256',
		amz_date,
		scope,
		await sha256Hex(canonical_request)
	].join('\n');
	let key = await hmac(encoder.encode(`AWS4${input.secret_access_key}`), date);
	key = await hmac(key, input.region);
	key = await hmac(key, 's3');
	key = await hmac(key, 'aws4_request');
	const signature = toHex(await hmac(key, string_to_sign));
	return {
		...headers,
		authorization: `AWS4-HMAC-SHA256 Credential=${input.access_key_id}/${scope}, SignedHeaders=${signed_headers}, Signature=${signature}`
	};
}

function decodeXml(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

function xmlValues(xml: string, tag: string): string[] {
	const out: string[] = [];
	const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
	for (const match of xml.matchAll(pattern)) out.push(decodeXml(match[1]));
	return out;
}

/** Validate and normalize an endpoint to `scheme://host[:port]`. */
export function normalizeEndpoint(endpoint: string): string | undefined {
	try {
		const url = new URL(endpoint);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
		if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
			return undefined;
		}
		if (url.pathname !== '/' && url.pathname !== '') return undefined;
		return `${url.protocol}//${url.host}`;
	} catch {
		return undefined;
	}
}

/** Create a client bound to one bucket. */
export function createS3Client(config: S3Config, deps: S3ClientDeps = {}): S3Client {
	const fetch_impl = deps.fetch ?? fetch;
	const now = deps.now ?? (() => new Date());
	const endpoint = normalizeEndpoint(config.endpoint);
	if (endpoint === undefined) throw new S3Error('configuration', 0, 'InvalidEndpoint');
	const base = new URL(endpoint);

	function target(key: string): { url: string; host: string; path: string } {
		if (config.url_style === 'virtual-host') {
			const host = `${config.bucket}.${base.host}`;
			const path = `/${key}`;
			return { url: `${base.protocol}//${host}${uriEncode(path, true)}`, host, path };
		}
		const path = `/${config.bucket}${key === '' ? '' : `/${key}`}`;
		return { url: `${base.protocol}//${base.host}${uriEncode(path, true)}`, host: base.host, path };
	}

	async function send(
		operation: string,
		method: string,
		key: string,
		options: {
			query?: Record<string, string>;
			body?: Uint8Array;
			headers?: Record<string, string>;
		} = {}
	): Promise<Response> {
		const query = options.query ?? {};
		const { url, host, path } = target(key);
		const payload_sha256 =
			options.body === undefined ? EMPTY_SHA256 : await sha256Hex(options.body);
		const headers = await signRequest({
			method,
			host,
			path,
			query,
			headers: options.headers ?? {},
			payload_sha256,
			access_key_id: config.access_key_id,
			secret_access_key: config.secret_access_key,
			region: config.region,
			now: now()
		});
		const query_string = Object.keys(query)
			.sort()
			.map((name) => `${uriEncode(name, false)}=${uriEncode(query[name], false)}`)
			.join('&');
		// Host is set by fetch from the URL; sending it explicitly is refused.
		const { host: _host, ...send_headers } = headers;
		let response: Response;
		try {
			response = await fetch_impl(query_string === '' ? url : `${url}?${query_string}`, {
				method,
				headers: send_headers,
				body: options.body as BodyInit | undefined
			});
		} catch {
			throw new S3Error(operation, 0, undefined);
		}
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new S3Error(operation, response.status, xmlValues(text, 'Code')[0]);
		}
		return response;
	}

	return {
		async put(key, body, content_type = 'application/octet-stream') {
			const response = await send('upload', 'PUT', key, {
				body,
				headers: { 'content-type': content_type }
			});
			await response.body?.cancel();
		},

		async get(key) {
			const response = await send('download', 'GET', key);
			return new Uint8Array(await response.arrayBuffer());
		},

		async list(prefix, delimiter) {
			const keys: string[] = [];
			const prefixes: string[] = [];
			let token: string | undefined;
			do {
				const query: Record<string, string> = { 'list-type': '2', prefix };
				if (delimiter !== undefined) query.delimiter = delimiter;
				if (token !== undefined) query['continuation-token'] = token;
				const xml = await (await send('list', 'GET', '', { query })).text();
				for (const contents of xmlValues(xml, 'Contents')) keys.push(...xmlValues(contents, 'Key'));
				for (const common of xmlValues(xml, 'CommonPrefixes')) {
					prefixes.push(...xmlValues(common, 'Prefix'));
				}
				token =
					xmlValues(xml, 'IsTruncated')[0] === 'true'
						? xmlValues(xml, 'NextContinuationToken')[0]
						: undefined;
			} while (token !== undefined);
			return { keys, prefixes };
		},

		async delete(key) {
			const response = await send('delete', 'DELETE', key);
			await response.body?.cancel();
		}
	};
}
