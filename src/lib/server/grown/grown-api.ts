/**
 * The browser's side of grown things (ADR-0025 rules 5, 7 and 9): who the
 * request's viewer is, the request bodies the `/api/views`, `/api/surfaces`
 * and `/api/apps` routes accept, and how a stored thing becomes the summary
 * the pages show. Every kind shares these, so a rule changes in one place.
 * The store decides who may see or change what; these helpers only
 * translate.
 */
import { z } from 'zod';
import type { GrownRevisionView, GrownSummary } from '#lib/grown.js';
import { GrownError } from './errors.js';
import type {
	GrownAuthor,
	GrownKind,
	GrownRevision,
	GrownStore,
	GrownThing,
	GrownViewer
} from './store.js';

/**
 * The signed-in account asking, with its own role (rule 5). An Access
 * service token has no account, so it owns nothing and reads as a member
 * would: only published things.
 * @param locals The request's locals, set by `hooks.server.ts`.
 */
export function viewerFromLocals(locals: App.Locals): GrownViewer {
	return { account_id: locals.user?.id ?? '', role: locals.role ?? 'member' };
}

/**
 * The person writing a revision from the browser. A write needs an account
 * to attribute it to (an Access service token is refused, as for automations).
 * @param locals The request's locals.
 */
export function personAuthor(locals: App.Locals): GrownAuthor {
	if (locals.user === undefined) {
		throw new GrownError(
			'forbidden',
			'Changing a view, surface or app needs a signed-in admin account.'
		);
	}
	return { kind: 'person', account_id: locals.user.id, chat_id: null };
}

const name_schema = z.string().min(1);
const description_schema = z.string();

/**
 * Create: the store checks the slug, name and description limits and parses
 * the spec against the route's kind, which the body never names.
 */
export const grown_create_schema = z.strictObject({
	slug: z.string().min(1),
	name: name_schema,
	description: description_schema.optional(),
	spec: z.unknown()
});

/** Revise: any of name, description and spec; the rest carry over from the latest revision. */
export const grown_revise_schema = z
	.strictObject({
		name: name_schema.optional(),
		description: description_schema.optional(),
		spec: z.unknown().optional()
	})
	.refine(
		(body) => body.name !== undefined || body.description !== undefined || body.spec !== undefined,
		'change at least one of name, description or spec'
	);

const revision_number_schema = z.number().int().min(1);

export const grown_revert_schema = z.strictObject({ number: revision_number_schema });

/** Publish a revision; with no number, the latest. */
export const grown_publish_schema = z.strictObject({ number: revision_number_schema.optional() });

/**
 * A thing as this viewer sees it. The caller names the spec type its kind's
 * schema produced; the store validated the spec on write.
 * @param thing The store's thing (its revision is the one the viewer sees).
 * @param viewer The viewer it was read for.
 */
export function grownSummary<Spec>(thing: GrownThing, viewer: GrownViewer): GrownSummary<Spec> {
	const mine = thing.owner_id === viewer.account_id;
	const published = thing.published_revision_id !== null;
	return {
		slug: thing.slug,
		name: thing.revision.name,
		description: thing.revision.description,
		spec: thing.revision.spec as Spec,
		revision: thing.revision.number,
		author_kind: thing.revision.author_kind,
		mine,
		published,
		...(mine
			? { unpublished_changes: published && thing.published_revision_id !== thing.revision.id }
			: {}),
		created_at: thing.created_at,
		updated_at: thing.updated_at
	};
}

/**
 * One kept revision, for the owner's history.
 * @param revision The stored revision.
 * @param published_revision_id The thing's published revision, if any.
 */
export function grownRevisionView<Spec>(
	revision: GrownRevision,
	published_revision_id: string | null
): GrownRevisionView<Spec> {
	return {
		number: revision.number,
		name: revision.name,
		description: revision.description,
		spec: revision.spec as Spec,
		author_kind: revision.author_kind,
		...(revision.author_chat_id === null ? {} : { author_chat_id: revision.author_chat_id }),
		...(revision.reverted_from === null ? {} : { reverted_from: revision.reverted_from }),
		published: revision.id === published_revision_id,
		created_at: revision.created_at
	};
}

/**
 * The thing of `kind` called `slug` as this viewer sees it. Slugs are unique
 * across kinds, so a thing of another kind under the same slug, or one the
 * viewer may not see, is "not found" here: the views routes never read or
 * change a surface, and the surfaces routes never touch a view. Every route
 * calls this before any store write.
 * @param store The grown things store.
 * @param viewer The request's viewer.
 * @param kind The route's kind.
 * @param slug The thing's slug.
 */
export async function requireGrown(
	store: GrownStore,
	viewer: GrownViewer,
	kind: GrownKind,
	slug: string
): Promise<GrownThing> {
	const thing = await store.read(viewer, slug);
	if (thing === undefined || thing.kind !== kind) {
		throw new GrownError('not_found', `There is no ${kind} called "${slug}".`);
	}
	return thing;
}
