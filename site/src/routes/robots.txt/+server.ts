import { resolve } from '$app/paths';
import { SITE_URL } from '#lib/site.js';

export const prerender = true;

export function GET() {
	const sitemap = new URL(resolve('/sitemap.xml'), SITE_URL).href;
	return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${sitemap}\n`, {
		headers: { 'Content-Type': 'text/plain' }
	});
}
