/**
 * Crew app tools (ADR-0025 rules 3, 5, 6, 7, 8 and 9): First Mate writes
 * sandboxed apps (model-written HTML, CSS and JavaScript) by conversation,
 * through the same grown things store the `/api/apps` routes use, with the
 * rules every grown tool shares (`grown-tools.ts`).
 *
 * - `define_app` takes the document as plain text and leaves every check to
 *   the store's parse (document size, library allowlist), so a bad spec
 *   comes back with the browser API's message and there is one validator.
 *   The server never parses or runs the document (rule 4); it is data.
 * - The description teaches the bridge (MCP Apps JSON-RPC over
 *   `postMessage`) and the library allowlist from the same constants the
 *   host and the frame route use, so a new read or library teaches the model
 *   without a second copy to keep in step.
 * - A document is up to 256 KB and a tool result at most `RESULT_MAX_CHARS`,
 *   whose long fields are cut to 2,000 characters. So no app result carries
 *   the document as a JSON field (it would come back cut and look whole):
 *   summaries give its size, and `app_history` with a revision `number`
 *   returns that revision's document as plain text, a page at a time, which
 *   is how the model reads an app back before revising it.
 * - There is no publish or share tool (rule 7): an app First Mate writes is
 *   owner-private until an admin publishes it from the browser.
 */
import { z } from 'zod';
import {
	APP_CALL_WINDOW_MS,
	APP_CALLS_IN_FLIGHT,
	APP_CALLS_PER_WINDOW,
	APP_FRAME_MAX_HEIGHT,
	APP_FRAME_MIN_HEIGHT,
	MCP_APPS_PROTOCOL_VERSION
} from '#lib/client/app-bridge.js';
import { BRIDGE_FRAME_MAX_BYTES, type AppSpecShape } from '#lib/apps.js';
import {
	GROWN_DESCRIPTION_MAX,
	GROWN_NAME_MAX,
	type GrownRevision,
	type GrownThing,
	type GrownViewer
} from '../grown/store.js';
import { APP_DOCUMENT_MAX_BYTES } from '../grown/app-spec.js';
import { APP_LIBRARIES, APP_LIBRARY_NAMES } from '../grown/app-libraries.js';
import { BRIDGE_READ_NAMES, BRIDGE_READS, BRIDGE_VIEW_TOOL } from '../grown/bridge.js';
import { grownRevisionView, requireGrown } from '../grown/grown-api.js';
import {
	CrewText,
	CrewToolError,
	RESULT_MAX_CHARS,
	defineTool,
	type CrewTool
} from './registry.js';
import {
	compactGrown,
	defineGrown,
	GROWN_WRITE_PERMISSION,
	grown,
	grownRevertTool,
	grownSlugSchema,
	grownStore,
	grownUrl,
	viewerOf
} from './grown-tools.js';

/** Revisions `app_history` lists unless asked for more. */
const HISTORY_DEFAULT = 10;

/**
 * Characters of a document one `app_history` page returns: the result limit
 * less room for the header line, so a page is never cut by the bound.
 */
export const APP_DOCUMENT_PAGE_CHARS = RESULT_MAX_CHARS - 1_000;

/** An app's spec as results show it: the document's size, never the document. */
function specSummary(spec: AppSpecShape) {
	return {
		libraries: spec.libraries,
		document_bytes: Buffer.byteLength(spec.html, 'utf8'),
		document_chars: spec.html.length
	};
}

/** An app as every tool result shows it: the browser's summary, less the document. */
function appSummary(thing: GrownThing, viewer: GrownViewer) {
	const { spec, ...summary } = compactGrown<AppSpecShape>(thing, viewer);
	return { ...summary, ...specSummary(spec) };
}

/** One kept revision, less its document. */
function revisionSummary(revision: GrownRevision, published_revision_id: string | null) {
	const { spec, ...view } = grownRevisionView<AppSpecShape>(revision, published_revision_id);
	return { ...view, ...specSummary(spec) };
}

const NEEDS_PROJECT = BRIDGE_READ_NAMES.filter((name) => BRIDGE_READS[name].needs_project);

const LIBRARY_GUIDE = APP_LIBRARY_NAMES.map(
	(name) => `- ${name} (${APP_LIBRARIES[name].type}): ${APP_LIBRARIES[name].summary}`
).join('\n');

/** A whole small app: start the bridge, read ready work, list it, size the frame. */
const EXAMPLE = `<main><h1>Ready</h1><ul id="list"></ul></main>
<script>
let next = 1; const waiting = new Map();
addEventListener('message', (e) => {
  if (e.source !== parent || !waiting.has(e.data?.id)) return;
  waiting.get(e.data.id)(e.data); waiting.delete(e.data.id);
});
const call = (method, params) => new Promise((done) => {
  const id = next++; waiting.set(id, done);
  parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
});
const notify = (method, params) => parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
(async () => {
  await call('ui/initialize', {});
  notify('ui/notifications/initialized', {});
  const { result } = await call('tools/call', { name: 'ready_work', arguments: { limit: 20 } });
  for (const issue of result.isError ? [] : result.structuredContent.issues) {
    const li = document.createElement('li'); li.textContent = issue.title; list.append(li);
  }
  notify('ui/notifications/size-changed', { height: document.body.scrollHeight });
})();
</script>`;

const DEFINE_DESCRIPTION = [
	'Create a sandboxed app (your own HTML, CSS and JavaScript, for what the catalog surface',
	'components cannot show), or revise one of yours under the same slug. Prefer',
	'define_surface when its components fit. Send the whole document each time; an omitted',
	'description carries over. Every change is a new revision the owner can revert. Apps you',
	'write are private to the chat owner until an admin publishes them in the browser.',
	'Returns the app and its URL; give the captain the link. To revise, read the current',
	'document back with app_history and a revision number.',
	'',
	'`spec` is `{ "html": "<document>", "libraries": [<names>] }`. `html` is a fragment or a',
	`whole document with inline <style> and <script>, at most ${APP_DOCUMENT_MAX_BYTES / 1024} KB. It runs in a`,
	'sandboxed iframe with an opaque origin and no network: fetch, XHR, WebSocket and external',
	'scripts, styles, fonts and images are all blocked (images only as data: URLs), and there',
	'are no forms, popups, navigation, cookies or storage (localStorage throws). The host',
	'writes the head (charset, viewport, libraries) first; the frame has class="dark" on',
	'<html> in dark mode.',
	'',
	'`libraries` are inlined before the document, in order; the default is ["beadsmith-tokens"].',
	'They are the only code an app can use beyond its own:',
	LIBRARY_GUIDE,
	'Style with these tokens (var(--tx), var(--line), …) so the app matches Beadsmith in both',
	'themes.',
	'',
	`The bridge is MCP Apps (protocol ${MCP_APPS_PROTOCOL_VERSION}): JSON-RPC 2.0 sent with`,
	"parent.postMessage(message, '*'); answers arrive as message events whose source is parent.",
	'- request ui/initialize: answers { protocolVersion, hostInfo, hostContext: { theme:',
	'  "light"|"dark", displayMode, platform, viewer: { role: "admin"|"member" } } }. Then send',
	'  the notification ui/notifications/initialized.',
	'- request tools/call { name, arguments }: answers an MCP CallToolResult { content: [{ type:',
	'  "text", text }], structuredContent?, isError }. A refusal is isError with its reason in',
	`  the text. name is one of ${[...BRIDGE_READ_NAMES, BRIDGE_VIEW_TOOL].join(', ')}; arguments`,
	`  are that crew tool's own input, and ${NEEDS_PROJECT.join(', ')} must name \`project\` (an`,
	`  app has no chat project). ${BRIDGE_VIEW_TOOL} { slug } runs a saved view.`,
	'- notification ui/notifications/size-changed { height }: sets the frame height',
	`  (${APP_FRAME_MIN_HEIGHT} to ${APP_FRAME_MAX_HEIGHT} px).`,
	'- request ping: answers {}.',
	'Calls run as whoever opens the app, so a member sees what a member may read and',
	'list_todos is refused to a member. Apps read only: they cannot change anything.',
	`At most ${APP_CALLS_PER_WINDOW} calls per ${APP_CALL_WINDOW_MS / 1000} s and ${APP_CALLS_IN_FLIGHT} in flight; a message is at most`,
	`${BRIDGE_FRAME_MAX_BYTES / 1024} KB. Load data once and on a user's request, not in a loop.`,
	'',
	`Example html: ${EXAMPLE}`
].join('\n');

export const define_app = defineTool({
	name: 'define_app',
	description: DEFINE_DESCRIPTION,
	input: z.strictObject({
		slug: grownSlugSchema('app'),
		name: z.string().min(1).max(GROWN_NAME_MAX),
		description: z.string().max(GROWN_DESCRIPTION_MAX).optional(),
		spec: z
			.record(z.string(), z.unknown())
			.describe('{ html, libraries? } as the tool description sets out.')
	}),
	permission: GROWN_WRITE_PERMISSION,
	async handler(ctx, input, deps) {
		const { written, thing, viewer } = await defineGrown(ctx, deps, 'app', input);
		return { written, app: appSummary(thing, viewer) };
	}
});

export const list_apps = defineTool({
	name: 'list_apps',
	description:
		'List sandboxed apps: the chat owner’s own (latest revision) and the ones members can ' +
		'see (published revision), newest change first, with their URLs, libraries and document ' +
		'sizes. For an app’s document, use app_history with a revision number.',
	input: z.strictObject({}),
	async handler(ctx, _input, deps) {
		const viewer = viewerOf(ctx);
		const things = await grown(async () => (await grownStore(deps)).list(viewer, 'app'));
		return { apps: things.map((thing) => appSummary(thing, viewer)) };
	}
});

/**
 * One page of a revision's document: a JSON header line (where the page
 * sits, and the offset of the next one), then the document text unescaped,
 * so the model reads code as code and nothing in it is cut by the bound.
 */
function documentPage(thing: GrownThing, revision: GrownRevision, offset: number): CrewText {
	const spec = revision.spec as AppSpecShape;
	const total = spec.html.length;
	if (offset >= total) {
		throw new CrewToolError(
			`Revision ${revision.number}'s document is ${total} characters; offset ${offset} is past its end.`
		);
	}
	const end = Math.min(total, offset + APP_DOCUMENT_PAGE_CHARS);
	const header = {
		slug: thing.slug,
		url: grownUrl(thing.slug),
		revision: revision.number,
		libraries: spec.libraries,
		chars: [offset, end],
		total_chars: total,
		...(end < total
			? { next_offset: end, note: 'The document continues; call again with next_offset.' }
			: {})
	};
	return new CrewText(`${JSON.stringify(header)}\n${spec.html.slice(offset, end)}`);
}

export const app_history = defineTool({
	name: 'app_history',
	description:
		'The kept revisions of one of the chat owner’s apps, newest first: number, who wrote it, ' +
		'its libraries and size, and whether members see it. With a revision `number`, returns ' +
		'that revision’s document instead: a JSON header line, then the HTML as plain text, ' +
		`${APP_DOCUMENT_PAGE_CHARS} characters at a time; a header with next_offset means call ` +
		'again with that `offset` for the rest. Read the newest revision whole before revising. ' +
		'Use a number with revert_app.',
	input: z.strictObject({
		slug: grownSlugSchema('app'),
		limit: z.number().int().min(1).max(50).default(HISTORY_DEFAULT),
		number: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe('A revision whose document to return, instead of the list.'),
		offset: z
			.number()
			.int()
			.min(0)
			.default(0)
			.describe('With number: the character to start the page at.')
	}),
	permission: GROWN_WRITE_PERMISSION,
	async handler(ctx, input, deps) {
		const viewer = viewerOf(ctx);
		return grown(async () => {
			const store = await grownStore(deps);
			const thing = await requireGrown(store, viewer, 'app', input.slug);
			const revisions = await store.history(viewer, input.slug);
			if (input.number !== undefined) {
				const revision = revisions.find((entry) => entry.number === input.number);
				if (revision === undefined) {
					throw new CrewToolError(
						`The app "${thing.slug}" has no revision ${input.number}. Its newest is ${thing.latest_number}.`
					);
				}
				return documentPage(thing, revision, input.offset);
			}
			return {
				slug: thing.slug,
				url: grownUrl(thing.slug),
				revisions: revisions
					.slice(0, input.limit)
					.map((revision) => revisionSummary(revision, thing.published_revision_id)),
				...(revisions.length > input.limit
					? { note: `${revisions.length - input.limit} older revisions not shown.` }
					: {})
			};
		});
	}
});

export const revert_app = grownRevertTool(
	'app',
	'revert_app',
	'Restore one of the chat owner’s apps to an earlier revision (from app_history). The ' +
		'revert is itself a new revision, so nothing is lost. What members see changes only when ' +
		'an admin publishes.',
	appSummary
);

export const APP_TOOLS: CrewTool[] = [define_app, list_apps, app_history, revert_app];
