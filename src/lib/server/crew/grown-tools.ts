/**
 * What every kind's grown thing crew tools share (ADR-0025 rules 5, 7, 8
 * and 9), so views and surfaces follow one rule set: the chat owner is the
 * viewer, First Mate and the chat are the author, a store refusal becomes a
 * message the model reads, writes need the `/api/views` and `/api/surfaces`
 * writes' admin permission, and history and revert work the same for every
 * kind. The store decides who may see or change what; nothing here adds a
 * rule of its own. There is deliberately no publish or share helper (rule 7).
 */
import { z } from 'zod';
import type { Permission } from '../auth/roles.js';
import { getGrownStore } from '../state/db.js';
import { GrownError } from '../grown/errors.js';
import {
	GROWN_SLUG_MAX,
	GROWN_SLUG_PATTERN,
	type GrownAuthor,
	type GrownKind,
	type GrownStore,
	type GrownThing,
	type GrownViewer
} from '../grown/store.js';
import { grownRevisionView, grownSummary, requireGrown } from '../grown/grown-api.js';
import {
	CrewToolError,
	defineTool,
	type CrewContext,
	type CrewDeps,
	type CrewTool
} from './registry.js';

/** Writes need what the browser's writes need: the request gate's admin default. */
export const GROWN_WRITE_PERMISSION: Permission = { console: ['manage'] };

/** Revisions a history tool returns unless asked for more. */
const HISTORY_DEFAULT = 10;

/**
 * A slug input, described for the kind it names.
 * @param kind The tool's kind, for the description.
 */
export function grownSlugSchema(kind: GrownKind) {
	return z
		.string()
		.max(GROWN_SLUG_MAX)
		.regex(GROWN_SLUG_PATTERN, 'lowercase letters and digits in dash-separated words')
		.describe(`The ${kind}'s slug, like "blocked-on-review"; its page is /views/<slug>.`);
}

export function grownStore(deps: CrewDeps): Promise<GrownStore> {
	return (deps.grown ?? getGrownStore)();
}

/** The chat's owner with the owner's own role (rule 5). */
export function viewerOf(ctx: CrewContext): GrownViewer {
	return { account_id: ctx.account_id, role: ctx.role };
}

/** First Mate in this chat, attributed to the chat's owner (rule 8). */
export function firstMate(ctx: CrewContext): GrownAuthor {
	return { kind: 'first_mate', account_id: ctx.account_id, chat_id: ctx.chat_id };
}

/**
 * The page a grown thing renders on, which the create and revise tools
 * return (rule 9). Views and surfaces share `/views/<slug>`: slugs are
 * unique across kinds, and the catalogue lists both.
 */
export function grownUrl(slug: string): string {
	return `/views/${slug}`;
}

/** Run a store call, turning its refusal into a message the model reads. */
export async function grown<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof GrownError) throw new CrewToolError(error.message);
		throw error;
	}
}

/** A thing as the tool results show it: the browser's summary plus its URL. */
export function compactGrown<Spec>(thing: GrownThing, viewer: GrownViewer) {
	return { ...grownSummary<Spec>(thing, viewer), url: grownUrl(thing.slug) };
}

/**
 * Create a thing of `kind`, or revise the viewer's own under the same slug.
 * A slug another kind holds is refused as taken; one another owner holds is
 * refused by the store.
 * @returns Which write happened and the thing as the viewer now sees it.
 */
export async function defineGrown(
	ctx: CrewContext,
	deps: CrewDeps,
	kind: GrownKind,
	input: { slug: string; name: string; description?: string; spec: unknown }
): Promise<{ written: 'created' | 'revised'; thing: GrownThing; viewer: GrownViewer }> {
	const store = await grownStore(deps);
	const viewer = viewerOf(ctx);
	return grown(async () => {
		const existing = await store.read(viewer, input.slug);
		if (existing !== undefined && existing.kind !== kind) {
			throw new GrownError('conflict', `The slug "${input.slug}" is taken. Pick another.`);
		}
		const fields = {
			name: input.name,
			description: input.description,
			spec: input.spec,
			author: firstMate(ctx)
		};
		const thing =
			existing === undefined
				? await store.create(viewer, { kind, slug: input.slug, ...fields })
				: await store.revise(viewer, input.slug, fields);
		return { written: existing === undefined ? 'created' : 'revised', thing, viewer };
	});
}

/**
 * `<kind>_history`: the owner's kept revisions, newest first.
 * @param kind The kind it reads; another kind's slug is "not found".
 * @param name The tool's name.
 * @param description What the model reads.
 */
export function grownHistoryTool(kind: GrownKind, name: string, description: string): CrewTool {
	return defineTool({
		name,
		description,
		input: z.strictObject({
			slug: grownSlugSchema(kind),
			limit: z.number().int().min(1).max(50).default(HISTORY_DEFAULT)
		}),
		permission: GROWN_WRITE_PERMISSION,
		async handler(ctx, input, deps) {
			const viewer = viewerOf(ctx);
			return grown(async () => {
				const store = await grownStore(deps);
				const thing = await requireGrown(store, viewer, kind, input.slug);
				const revisions = await store.history(viewer, input.slug);
				return {
					slug: thing.slug,
					url: grownUrl(thing.slug),
					revisions: revisions
						.slice(0, input.limit)
						.map((revision) => grownRevisionView(revision, thing.published_revision_id)),
					...(revisions.length > input.limit
						? { note: `${revisions.length - input.limit} older revisions not shown.` }
						: {})
				};
			});
		}
	});
}

/**
 * `revert_<kind>`: copy an earlier revision forward as a new one.
 * @param kind The kind it changes; another kind's slug is "not found".
 * @param name The tool's name.
 * @param description What the model reads.
 */
export function grownRevertTool(kind: GrownKind, name: string, description: string): CrewTool {
	return defineTool({
		name,
		description,
		input: z.strictObject({
			slug: grownSlugSchema(kind),
			number: z.number().int().min(1).describe('The revision number to restore.')
		}),
		permission: GROWN_WRITE_PERMISSION,
		async handler(ctx, input, deps) {
			const viewer = viewerOf(ctx);
			return grown(async () => {
				const store = await grownStore(deps);
				await requireGrown(store, viewer, kind, input.slug);
				const thing = await store.revert(viewer, input.slug, input.number, firstMate(ctx));
				return { reverted_to: input.number, [kind]: compactGrown(thing, viewer) };
			});
		}
	});
}
