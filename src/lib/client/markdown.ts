/**
 * Markdown rendering for long issue bodies.
 *
 * `marked` produces HTML, `dompurify` sanitises it, and only then does it
 * reach `{@html}`. DOMPurify needs a real DOM, so server-rendered output falls
 * back to escaped plain text and the full rendering appears on hydration.
 */
import { browser } from '$app/environment';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

/**
 * GFM task items. marked emits a disabled `<input type=checkbox>`, which the
 * sanitiser strips (inputs are forbidden), leaving `[ ]` lists as plain
 * bullets. Render a styled box instead so done/not-done survives.
 *
 * @param checked - Whether the task is ticked.
 */
export function taskBox(checked: boolean): string {
	const label = checked ? 'done' : 'not done';
	return `<span class="md-task${checked ? ' is-done' : ''}" role="img" aria-label="${label}"></span>`;
}

marked.use({
	renderer: {
		checkbox({ checked }) {
			return taskBox(checked);
		}
	}
});

/**
 * Escape a string for literal inclusion in HTML.
 *
 * @param value - Raw text.
 */
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Turn heading text into a stable anchor fragment.
 *
 * @param text - Heading text.
 */
export function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9\s-]/g, '')
			.replace(/\s+/g, '-')
			.slice(0, 64) || 'section'
	);
}

/**
 * Give every heading in already-sanitised HTML a stable id, so the modal's
 * table of contents can link into the body.
 *
 * @param html - Sanitised HTML.
 */
function addHeadingIds(html: string): string {
	const template = document.createElement('template');
	template.innerHTML = html;
	const headings = template.content.querySelectorAll('h1, h2, h3, h4, h5, h6');
	for (const heading of headings) {
		if (!heading.id) {
			heading.id = `md-${slugify(heading.textContent ?? '')}`;
		}
	}
	return template.innerHTML;
}

/**
 * The escaped, unformatted stand-in used during SSR and hydration.
 *
 * @param source - Markdown source.
 */
export function renderPlain(source: string): string {
	return `<p style="white-space:pre-wrap">${escapeHtml(source)}</p>`;
}

/**
 * Render markdown to sanitised HTML.
 *
 * @param source - Markdown source, possibly empty.
 */
export function renderMarkdown(source: string | undefined): string {
	if (!source || !source.trim()) {
		return '';
	}

	if (!browser) {
		return renderPlain(source);
	}

	const raw = marked.parse(source, { async: false }) as string;
	// `template` is forbidden because addHeadingIds re-parses this string in a
	// <template>, and {@html} parses it once more; a surviving <template> makes
	// that round trip an mXSS vector.
	const clean = DOMPurify.sanitize(raw, {
		USE_PROFILES: { html: true },
		FORBID_TAGS: ['style', 'form', 'input', 'button', 'template'],
		FORBID_ATTR: ['style']
	});
	return addHeadingIds(clean);
}

export interface TocEntry {
	id: string;
	text: string;
	depth: number;
}

/**
 * Extract a table of contents straight from the markdown source.
 *
 * @param source - Markdown source.
 */
export function extractToc(source: string | undefined): TocEntry[] {
	if (!source) {
		return [];
	}

	const entries: TocEntry[] = [];
	for (const line of source.split('\n')) {
		const match = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
		if (!match) {
			continue;
		}
		const text = match[2].replace(/[*_`]/g, '').trim();
		entries.push({ id: `md-${slugify(text)}`, text, depth: match[1].length });
	}
	return entries;
}
