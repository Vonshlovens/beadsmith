import { describe, expect, it, vi } from 'vitest';
import { createS3Client, normalizeEndpoint, S3Error, signRequest, uriEncode } from './s3.js';

// Published AWS Signature Version 4 examples for S3 (docs: "Examples of the
// complete Version 4 signing process"), example credentials only.
const AWS_EXAMPLE = {
	access_key_id: 'AKIAIOSFODNN7EXAMPLE',
	secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
	region: 'us-east-1',
	now: new Date('2013-05-24T00:00:00Z'),
	payload_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
};

function signature(authorization: string): string | undefined {
	return /Signature=([0-9a-f]+)/.exec(authorization)?.[1];
}

describe('signRequest', () => {
	it('matches the AWS GET Object example', async () => {
		const headers = await signRequest({
			...AWS_EXAMPLE,
			method: 'GET',
			host: 'examplebucket.s3.amazonaws.com',
			path: '/test.txt',
			query: {},
			headers: { range: 'bytes=0-9' }
		});
		expect(signature(headers.authorization)).toBe(
			'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
		);
		expect(headers.authorization).toContain(
			'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date'
		);
	});

	it('matches the AWS ListObjects example', async () => {
		const headers = await signRequest({
			...AWS_EXAMPLE,
			method: 'GET',
			host: 'examplebucket.s3.amazonaws.com',
			path: '/',
			query: { 'max-keys': '2', prefix: 'J' },
			headers: {}
		});
		expect(signature(headers.authorization)).toBe(
			'34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7'
		);
	});
});

describe('uriEncode', () => {
	it('keeps unreserved characters and optionally slashes', () => {
		expect(uriEncode('a b/c~d', true)).toBe('a%20b/c~d');
		expect(uriEncode('a b/c', false)).toBe('a%20b%2Fc');
		expect(uriEncode('é', false)).toBe('%C3%A9');
	});
});

describe('normalizeEndpoint', () => {
	it('accepts scheme and host only', () => {
		expect(normalizeEndpoint('https://t3.storageapi.dev/')).toBe('https://t3.storageapi.dev');
		expect(normalizeEndpoint('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
		expect(normalizeEndpoint('https://u:p@host')).toBeUndefined();
		expect(normalizeEndpoint('https://host/path')).toBeUndefined();
		expect(normalizeEndpoint('ftp://host')).toBeUndefined();
		expect(normalizeEndpoint('not a url')).toBeUndefined();
	});
});

const CONFIG = {
	endpoint: 'https://t3.storageapi.dev',
	bucket: 'beads-backups-abc',
	region: 'auto',
	url_style: 'virtual-host' as const,
	access_key_id: 'AKIDTEST',
	secret_access_key: 'super-secret-value'
};

describe('createS3Client', () => {
	it('uses virtual-host URLs and signs the payload hash', async () => {
		const fetch_impl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
			return new Response(null, { status: 200 });
		});
		const client = createS3Client(CONFIG, { fetch: fetch_impl as typeof fetch });
		await client.put('beadsmith/run/db one.sql.gz', new Uint8Array([1, 2, 3]));
		const [url, init] = fetch_impl.mock.calls[0];
		expect(String(url)).toBe(
			'https://beads-backups-abc.t3.storageapi.dev/beadsmith/run/db%20one.sql.gz'
		);
		const headers = init?.headers as Record<string, string>;
		expect(headers.host).toBeUndefined();
		expect(headers['x-amz-content-sha256']).toBe(
			'039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81'
		);
		expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\//);
	});

	it('uses path-style URLs when configured', async () => {
		const fetch_impl = vi.fn(
			async (_url: RequestInfo | URL) => new Response('data', { status: 200 })
		);
		const client = createS3Client(
			{ ...CONFIG, endpoint: 'http://127.0.0.1:9000', url_style: 'path' },
			{ fetch: fetch_impl as typeof fetch }
		);
		expect(new TextDecoder().decode(await client.get('a/b'))).toBe('data');
		expect(String(fetch_impl.mock.calls[0][0])).toBe('http://127.0.0.1:9000/beads-backups-abc/a/b');
	});

	it('follows ListObjectsV2 continuation tokens and decodes keys', async () => {
		const pages = [
			`<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;2</NextContinuationToken>
			<Contents><Key>p/a&amp;b</Key></Contents><CommonPrefixes><Prefix>p/run1/</Prefix></CommonPrefixes></ListBucketResult>`,
			`<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>p/c</Key></Contents></ListBucketResult>`
		];
		const urls: string[] = [];
		const fetch_impl = vi.fn(async (url: RequestInfo | URL) => {
			urls.push(String(url));
			return new Response(pages.shift(), { status: 200 });
		});
		const client = createS3Client(CONFIG, { fetch: fetch_impl as typeof fetch });
		const result = await client.list('p/', '/');
		expect(result).toEqual({ keys: ['p/a&b', 'p/c'], prefixes: ['p/run1/'] });
		expect(urls[0]).toBe(
			'https://beads-backups-abc.t3.storageapi.dev/?delimiter=%2F&list-type=2&prefix=p%2F'
		);
		expect(urls[1]).toContain('continuation-token=t%262');
	});

	it('reports a sanitized error without credentials', async () => {
		const fetch_impl = vi.fn(
			async () =>
				new Response(
					'<Error><Code>SignatureDoesNotMatch</Code><Message>super-secret-value</Message></Error>',
					{ status: 403 }
				)
		);
		const client = createS3Client(CONFIG, { fetch: fetch_impl as typeof fetch });
		const error = await client.delete('k').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(S3Error);
		expect((error as S3Error).status).toBe(403);
		expect((error as S3Error).code).toBe('SignatureDoesNotMatch');
		expect(String((error as Error).message)).not.toContain('super-secret-value');
		expect(String((error as Error).message)).not.toContain('AKIDTEST');
	});

	it('maps network failures to status 0', async () => {
		const fetch_impl = vi.fn(async () => {
			throw new TypeError('dns failure for super-secret-value');
		});
		const client = createS3Client(CONFIG, { fetch: fetch_impl as typeof fetch });
		const error = (await client.get('k').catch((e: unknown) => e)) as S3Error;
		expect(error.status).toBe(0);
		expect(error.message).not.toContain('super-secret-value');
	});

	it('refuses an invalid endpoint', () => {
		expect(() => createS3Client({ ...CONFIG, endpoint: 'https://host/path' })).toThrow(S3Error);
	});
});
