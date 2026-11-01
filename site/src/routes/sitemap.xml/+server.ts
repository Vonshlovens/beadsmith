import { resolve } from '$app/paths';
import { DOCS } from '#lib/server/docs.js';
import { SITE_URL } from '#lib/site.js';

export const prerender = true;

export function GET() {
	const paths = [
		resolve('/'),
		resolve('/docs'),
		...DOCS.map(({ slug }) => resolve('/docs/[slug]', { slug }))
	];
	const urls = paths.map((path) => `\t<url><loc>${new URL(path, SITE_URL).href}</loc></url>`);
	const body = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		...urls,
		'</urlset>',
		''
	].join('\n');

	return new Response(body, { headers: { 'Content-Type': 'application/xml' } });
}
