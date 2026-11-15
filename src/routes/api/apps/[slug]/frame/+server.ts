/**
 * An app's document, for the host page's `<iframe sandbox="allow-scripts">`
 * (ADR-0025 rule 3). The store decides which revision this viewer sees (the
 * owner the latest, anyone else the published one, or nothing), exactly as
 * for every other app route, so a member never loads an unpublished
 * document. The response carries the app's own CSP, not the page's: it
 * sandboxes the document into an opaque origin even when opened directly and
 * blocks every network request, so the code can reach Beadsmith only over
 * the host's postMessage bridge.
 *
 * `?theme=dark` selects the dark tokens; the host page passes the theme it
 * resolved, since the frame cannot read the page's preference itself.
 */
import type { RequestHandler } from './$types';
import { getGrownStore } from '#lib/server/state/db.js';
import { errorFromException } from '#lib/server/security.js';
import { requireGrown, viewerFromLocals } from '#lib/server/grown/grown-api.js';
import { APP_FRAME_CSP, appDocument, type AppSpec } from '#lib/server/grown/app-spec.js';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	const viewer = viewerFromLocals(locals);
	try {
		const thing = await requireGrown(await getGrownStore(), viewer, 'app', params.slug);
		const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
		return new Response(appDocument(thing.revision.spec as AppSpec, theme), {
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Content-Security-Policy': APP_FRAME_CSP,
				// The owner's next revision must show on reload, and a member's
				// cached copy must not outlive an unpublish.
				'Cache-Control': 'no-store'
			}
		});
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
