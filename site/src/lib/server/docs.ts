/**
 * The site's docs are the repository's own Markdown, rendered at build time,
 * so they cannot drift from the code. DOCS chooses which files are published
 * and in what order; anything else a doc links to (specs, source files,
 * unpublished docs) goes to the file on GitHub.
 */

import { posix } from 'node:path';
import { resolve } from '$app/paths';
import { Marked, type Tokens } from 'marked';
import { repoFile } from '#lib/site.js';

export interface DocEntry {
	slug: string;
	/** Path from the repository root. */
	path: string;
	group: string;
	summary: string;
	/** Overrides the file's own `# heading`. */
	title?: string;
}

export const DOCS: DocEntry[] = [
	{
		slug: 'overview',
		path: 'README.md',
		group: 'Start',
		title: 'Overview',
		summary:
			'What Beadsmith is, the quickstart, connecting your own Beads projects, and which bd releases it reads.'
	},
	{
		slug: 'configuration',
		path: 'docs/configuration.md',
		group: 'Run it',
		summary: 'Every environment variable and secret file, and running from source.'
	},
	{
		slug: 'server-deployment',
		path: 'docs/server-deployment.md',
		group: 'Run it',
		title: 'Server deployment',
		summary: 'One Beadsmith service next to, or on a private path to, an existing Dolt sql-server.'
	},
	{
		slug: 'backups',
		path: 'docs/backups.md',
		group: 'Run it',
		summary: 'Scheduled dumps of every project to an S3-compatible bucket, encryption, and restore.'
	},
	{
		slug: 'new-project',
		path: 'docs/new-project.md',
		group: 'Run it',
		summary: 'Creating a Beads project on a Dolt server you run for your own machines.'
	},
	{
		slug: 'keyboard',
		path: 'docs/keyboard.md',
		group: 'Use it',
		summary: 'Every shortcut. Press ? on any page for the keys it answers.'
	},
	{
		slug: 'agents',
		path: 'docs/file-tackle-dispatch.md',
		group: 'Use it',
		title: 'Agents: File and Tackle',
		summary:
			'Sending an issue to an agent: what Beadsmith records, and the signed webhook a runner receives.'
	},
	{
		slug: 'agent-access',
		path: 'docs/agent-access.md',
		group: 'Use it',
		title: 'Agent API access',
		summary: 'How an agent without a browser reads the same catalog a signed-in person sees.'
	},
	{
		slug: 'contract',
		path: 'docs/contract.md',
		group: 'Design',
		title: 'Product and security contract',
		summary: 'What the service does today and the security properties it keeps.'
	},
	{
		slug: 'public-access',
		path: 'docs/public-access.md',
		group: 'Design',
		title: 'Access and project authorization',
		summary: 'Authentication as built, and the per-project authorization design ahead of it.'
	}
];

// Paths below are relative to this file: src/lib/server -> the repository root.
const ROOT = '../../../../';

const SOURCES = import.meta.glob(['../../../../README.md', '../../../../docs/*.md'], {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

const IMAGES = import.meta.glob('../../../../docs/images/*.{png,jpg,jpeg,webp,gif,svg}', {
	query: '?url',
	import: 'default',
	eager: true
}) as Record<string, string>;

function source(path: string): string {
	const text = SOURCES[ROOT + path];
	if (text === undefined) {
		throw new Error(`docs: ${path} is in DOCS but was not found`);
	}
	return text;
}

export interface Heading {
	id: string;
	text: string;
}

export interface RenderedDoc {
	entry: DocEntry;
	title: string;
	html: string;
	/** Second-level headings, for the contents list. */
	sections: Heading[];
	sourceUrl: string;
}

/** GitHub's heading anchors, so links written for GitHub land here too. */
function slugger() {
	const seen = new Map<string, number>();
	return (text: string): string => {
		const base = text
			.toLowerCase()
			.trim()
			.replace(/[^\p{L}\p{N}\s_-]/gu, '')
			.replace(/\s/g, '-');
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		return count === 0 ? base : `${base}-${count}`;
	};
}

function decodeEntities(html: string): string {
	return html
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Where a link written in the repository should point on the site: a
 * published doc becomes its page, an image under docs/images its built asset,
 * any other repository path the file on GitHub.
 */
function rewriteHref(href: string, from: string): string {
	if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) {
		return href;
	}
	const [path, hash] = href.split('#', 2);
	const target = posix.normalize(posix.join(posix.dirname(from), path)).replace(/\/$/, '');
	const anchor = hash ? `#${hash}` : '';

	const doc = DOCS.find((entry) => entry.path === target);
	if (doc) {
		return resolve('/docs/[slug]', { slug: doc.slug }) + anchor;
	}
	const image = IMAGES[ROOT + target];
	if (image) {
		return image;
	}
	return repoFile(target) + anchor;
}

export function renderDoc(entry: DocEntry): RenderedDoc {
	const slug = slugger();
	const sections: Heading[] = [];

	const marked = new Marked({
		gfm: true,
		renderer: {
			heading({ tokens, depth }) {
				const html = this.parser.parseInline(tokens);
				const text = decodeEntities(this.parser.parseInline(tokens, this.parser.textRenderer));
				const id = slug(text);
				if (depth === 2) {
					sections.push({ id, text });
				}
				return `<h${depth} id="${escapeAttr(id)}">${html}</h${depth}>\n`;
			},
			link({ href, title, tokens }) {
				const text = this.parser.parseInline(tokens);
				const target = rewriteHref(href, entry.path);
				const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
				return `<a href="${escapeAttr(target)}"${titleAttr}>${text}</a>`;
			},
			image({ href, title, text }) {
				const target = rewriteHref(href, entry.path);
				const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
				return `<img src="${escapeAttr(target)}" alt="${escapeAttr(text)}"${titleAttr} loading="lazy" />`;
			},
			codespan({ text }) {
				// Long names (BEADS_DOLT_PASSWORD_FILE, /run/secrets/…) may wrap
				// after _ and /, so a table of them still fits the column.
				const html = escapeHtml(decodeEntities(text)).replace(/([_/])(?=.)/g, '$1<wbr>');
				return `<code>${html}</code>`;
			}
		}
	});

	const tokens = marked.lexer(source(entry.path));

	// The file's `# Title` becomes the page title rather than part of the body.
	let title = entry.title;
	const first = tokens.findIndex((token) => token.type !== 'space');
	if (tokens[first]?.type === 'heading' && (tokens[first] as Tokens.Heading).depth === 1) {
		title ??= (tokens[first] as Tokens.Heading).text;
		tokens.splice(first, 1);
	}

	const html = marked
		.parser(tokens)
		// A lone name in a table's first column stays whole; the cell beside it wraps.
		.replace(
			/(<tr>\s*<td>)<code>(.*?)<\/code>(<\/td>)/g,
			(_, open, code, close) => `${open}<code>${code.replace(/<wbr>/g, '')}</code>${close}`
		)
		// Wide tables scroll inside the column instead of widening the page.
		.replace(/<table>/g, '<div class="table-scroll"><table>')
		.replace(/<\/table>/g, '</table></div>');

	return {
		entry,
		title: title ?? entry.slug,
		html,
		sections,
		sourceUrl: repoFile(entry.path)
	};
}

export function docTitle(entry: DocEntry): string {
	if (entry.title) {
		return entry.title;
	}
	const heading = /^#\s+(.+)$/m.exec(source(entry.path));
	return heading ? heading[1].trim() : entry.slug;
}
