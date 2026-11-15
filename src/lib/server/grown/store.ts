/**
 * The grown things store (ADR-0025 rules 7 and 8): one revisioned store for
 * every tier (views, surfaces and apps, each kind with its own spec schema),
 * so there is one revision and visibility implementation rather than three. App-owned rows in `state.db`.
 *
 * - A thing belongs to its owner (the account that created it). It holds a
 *   slug, its kind and which revision, if any, is published.
 * - Name, description and spec live on revisions, which are append-only:
 *   create, revise and revert each insert one; revert copies an old one
 *   forward. The newest `GROWN_REVISIONS_KEPT` plus the published one are
 *   kept; older revisions are dropped whole, never edited.
 * - The owner reads the latest revision; everyone else reads the published
 *   one, or nothing. A revision First Mate writes never changes what members
 *   see until an admin publishes it.
 *
 * Specs are parsed against their kind's schema on every write and stored as
 * JSON; nothing here evaluates them (rule 4). Authorization lives here, not
 * in the routes, so the browser API and crew tools share one set of rules.
 */
import { randomBytes } from 'node:crypto';
import type { Client, InStatement } from '@libsql/client';
import type { z } from 'zod';
import type { AccountRole } from '../auth/roles.js';
import { GrownError } from './errors.js';
import { view_spec_schema, VIEW_SPEC_MAX_BYTES } from './view-spec.js';
import {
	surface_spec_schema,
	SURFACE_SPEC_MAX_BYTES,
	surfaceToolProblems,
	type SurfaceSpec
} from './surface-spec.js';
import { app_spec_schema, APP_SPEC_MAX_BYTES } from './app-spec.js';
import {
	GROWN_DESCRIPTION_MAX,
	GROWN_NAME_MAX,
	GROWN_SLUG_MAX,
	GROWN_SLUG_PATTERN
} from '#lib/grown.js';

interface KindDefinition {
	schema: z.ZodType;
	/** Most JSON bytes in one revision's spec. */
	max_bytes: number;
	/** Things of this kind one owner may keep. */
	per_owner: number;
	/**
	 * Checks the schema cannot make synchronously, run on the parsed spec;
	 * returns the problems, empty when there are none.
	 */
	check?: (spec: never) => Promise<string[]>;
}

/**
 * Every kind the store accepts, each with its spec schema; a write naming
 * any other kind is refused.
 */
export const GROWN_KINDS = {
	view: { schema: view_spec_schema, max_bytes: VIEW_SPEC_MAX_BYTES, per_owner: 200 },
	surface: {
		schema: surface_spec_schema,
		max_bytes: SURFACE_SPEC_MAX_BYTES,
		per_owner: 100,
		check: (spec: SurfaceSpec) => surfaceToolProblems(spec)
	},
	app: { schema: app_spec_schema, max_bytes: APP_SPEC_MAX_BYTES, per_owner: 50 }
} satisfies Record<string, KindDefinition>;

export type GrownKind = keyof typeof GROWN_KINDS;

export { GROWN_DESCRIPTION_MAX, GROWN_NAME_MAX, GROWN_SLUG_MAX, GROWN_SLUG_PATTERN };
export const GROWN_REVISIONS_KEPT = 50;

export type GrownAuthorKind = 'person' | 'first_mate';

/** Who wrote a revision. First Mate's revisions are attributed to the chat's owner. */
export interface GrownAuthor {
	kind: GrownAuthorKind;
	account_id: string;
	/** The First Mate chat, for `first_mate`; null for a person. */
	chat_id: string | null;
}

/** The signed-in account asking. Its role, never the owner's, decides (rule 5). */
export interface GrownViewer {
	account_id: string;
	role: AccountRole;
}

export interface GrownRevision {
	id: string;
	number: number;
	name: string;
	description: string;
	spec: unknown;
	author_kind: GrownAuthorKind;
	author_account_id: string;
	author_chat_id: string | null;
	/** The revision number a revert copied, or null. */
	reverted_from: number | null;
	created_at: string;
}

export interface GrownThing {
	id: string;
	kind: GrownKind;
	slug: string;
	owner_id: string;
	published_revision_id: string | null;
	latest_number: number;
	created_at: string;
	updated_at: string;
	/** The revision this viewer sees: the latest for the owner, else the published one. */
	revision: GrownRevision;
}

export interface CreateGrownInput {
	kind: string;
	slug: string;
	name: string;
	description?: string;
	spec: unknown;
	author: GrownAuthor;
}

export interface ReviseGrownInput {
	name?: string;
	description?: string;
	spec?: unknown;
	author: GrownAuthor;
}

export interface GrownStore {
	/** Admin-only (rule 7). The viewer becomes the owner; the new thing is private. */
	create(viewer: GrownViewer, input: CreateGrownInput): Promise<GrownThing>;
	/** The thing by slug as this viewer sees it, or undefined when they may not see it. */
	read(viewer: GrownViewer, slug: string): Promise<GrownThing | undefined>;
	/** The viewer's own things and every published one, newest change first. */
	list(viewer: GrownViewer, kind?: GrownKind): Promise<GrownThing[]>;
	/** Every kept revision, newest first. Owner-only. */
	history(viewer: GrownViewer, slug: string): Promise<GrownRevision[]>;
	/** A new revision with the given fields changed. Owner-only. */
	revise(viewer: GrownViewer, slug: string, input: ReviseGrownInput): Promise<GrownThing>;
	/** A new revision copying revision `number` forward. Owner-only. */
	revert(
		viewer: GrownViewer,
		slug: string,
		number: number,
		author: GrownAuthor
	): Promise<GrownThing>;
	/** Show revision `number` (default: the latest) to members. The owner, an admin. */
	publish(viewer: GrownViewer, slug: string, number?: number): Promise<GrownThing>;
	/**
	 * Hide the thing from everyone but its owner. Any admin. Returns the thing
	 * as the viewer now sees it: undefined when it was someone else's.
	 */
	unpublish(viewer: GrownViewer, slug: string): Promise<GrownThing | undefined>;
	/** Delete the thing and every revision. Owner-only. */
	remove(viewer: GrownViewer, slug: string): Promise<void>;
}

export const GROWN_SCHEMA_SQL: string[] = [
	`CREATE TABLE IF NOT EXISTS grown_things (
		id TEXT PRIMARY KEY,
		kind TEXT NOT NULL,
		slug TEXT NOT NULL UNIQUE,
		owner_id TEXT NOT NULL,
		published_revision_id TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS grown_things_owner ON grown_things (owner_id, kind)`,
	`CREATE TABLE IF NOT EXISTS grown_revisions (
		id TEXT PRIMARY KEY,
		thing_id TEXT NOT NULL REFERENCES grown_things(id) ON DELETE CASCADE,
		number INTEGER NOT NULL,
		name TEXT NOT NULL,
		description TEXT NOT NULL,
		spec_json TEXT NOT NULL,
		author_kind TEXT NOT NULL,
		author_account_id TEXT NOT NULL,
		author_chat_id TEXT,
		reverted_from INTEGER,
		created_at TEXT NOT NULL,
		UNIQUE (thing_id, number)
	)`
];

function newId(prefix: string): string {
	return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function kindOf(kind: string): GrownKind {
	if (!Object.hasOwn(GROWN_KINDS, kind)) {
		throw new GrownError(
			'bad_request',
			`Unknown kind "${kind}". Kinds: ${Object.keys(GROWN_KINDS).join(', ')}.`
		);
	}
	return kind as GrownKind;
}

function checkSlug(slug: string): void {
	if (slug.length === 0 || slug.length > GROWN_SLUG_MAX || !GROWN_SLUG_PATTERN.test(slug)) {
		throw new GrownError(
			'bad_request',
			`A slug is 1 to ${GROWN_SLUG_MAX} lowercase letters and digits in dash-separated words, like "blocked-on-review".`
		);
	}
}

function checkName(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length === 0 || trimmed.length > GROWN_NAME_MAX) {
		throw new GrownError('bad_request', `A name is 1 to ${GROWN_NAME_MAX} characters.`);
	}
	return trimmed;
}

function checkDescription(description: string): string {
	const trimmed = description.trim();
	if (trimmed.length > GROWN_DESCRIPTION_MAX) {
		throw new GrownError(
			'bad_request',
			`A description is at most ${GROWN_DESCRIPTION_MAX} characters; this is ${trimmed.length}.`
		);
	}
	return trimmed;
}

/**
 * Parse a spec against its kind's schema and size limit, returning the
 * canonical JSON stored (defaults filled in, keys in schema order).
 */
export async function parseGrownSpec(
	kind: GrownKind,
	spec: unknown
): Promise<{ spec: unknown; json: string }> {
	const definition: KindDefinition = GROWN_KINDS[kind];
	const parsed = definition.schema.safeParse(spec);
	const problems = parsed.success
		? ((await definition.check?.(parsed.data as never)) ?? [])
		: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'spec'}: ${issue.message}`);
	if (!parsed.success || problems.length > 0) {
		throw new GrownError(
			'bad_request',
			`The ${kind} spec is invalid: ${problems.slice(0, 5).join('; ')}.`
		);
	}
	const json = JSON.stringify(parsed.data);
	const bytes = Buffer.byteLength(json, 'utf8');
	if (bytes > definition.max_bytes) {
		throw new GrownError(
			'bad_request',
			`A ${kind} spec is at most ${definition.max_bytes} bytes of JSON; this is ${bytes}. Simplify it.`
		);
	}
	return { spec: parsed.data, json };
}

function requireAdmin(viewer: GrownViewer, what: string): void {
	if (viewer.role !== 'admin') {
		throw new GrownError('forbidden', `Only an admin can ${what}.`);
	}
}

function str(value: unknown): string {
	return String(value);
}

function optStr(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function toRevision(row: Record<string, unknown>): GrownRevision {
	return {
		id: str(row.id),
		number: Number(row.number),
		name: str(row.name),
		description: str(row.description),
		spec: JSON.parse(str(row.spec_json)),
		author_kind: row.author_kind === 'first_mate' ? 'first_mate' : 'person',
		author_account_id: str(row.author_account_id),
		author_chat_id: optStr(row.author_chat_id),
		reverted_from: row.reverted_from === null ? null : Number(row.reverted_from),
		created_at: str(row.created_at)
	};
}

const REVISION_COLUMNS = `r.id, r.number, r.name, r.description, r.spec_json, r.author_kind,
	r.author_account_id, r.author_chat_id, r.reverted_from, r.created_at`;

/**
 * Things joined to the revision a viewer sees: the latest for the owner,
 * the published one for anyone else. `?1` is the viewer's account id.
 */
const VISIBLE_SELECT = `SELECT t.id AS thing_id, t.kind, t.slug, t.owner_id,
		t.published_revision_id, t.created_at AS thing_created_at, t.updated_at,
		(SELECT MAX(number) FROM grown_revisions WHERE thing_id = t.id) AS latest_number,
		${REVISION_COLUMNS}
	FROM grown_things t
	JOIN grown_revisions r ON r.id = CASE
		WHEN t.owner_id = ?1 THEN (
			SELECT id FROM grown_revisions WHERE thing_id = t.id ORDER BY number DESC LIMIT 1
		)
		ELSE t.published_revision_id
	END`;

function toThing(row: Record<string, unknown>): GrownThing {
	return {
		id: str(row.thing_id),
		kind: str(row.kind) as GrownKind,
		slug: str(row.slug),
		owner_id: str(row.owner_id),
		published_revision_id: optStr(row.published_revision_id),
		latest_number: Number(row.latest_number),
		created_at: str(row.thing_created_at),
		updated_at: str(row.updated_at),
		revision: toRevision(row)
	};
}

interface ThingRow {
	id: string;
	kind: GrownKind;
	owner_id: string;
	published_revision_id: string | null;
}

export function createGrownStore(client: Client, now: () => Date = () => new Date()): GrownStore {
	async function visible(viewer: GrownViewer, slug: string): Promise<GrownThing | undefined> {
		const result = await client.execute({
			sql: `${VISIBLE_SELECT} WHERE t.slug = ?2`,
			args: [viewer.account_id, slug]
		});
		const row = result.rows[0];
		return row === undefined ? undefined : toThing(row as Record<string, unknown>);
	}

	/**
	 * The thing for an owner-only change. Someone who can see it but does not
	 * own it is refused; someone who cannot see it learns nothing.
	 */
	async function owned(viewer: GrownViewer, slug: string, what: string): Promise<ThingRow> {
		const result = await client.execute({
			sql: 'SELECT id, kind, owner_id, published_revision_id FROM grown_things WHERE slug = ?',
			args: [slug]
		});
		const row = result.rows[0] as Record<string, unknown> | undefined;
		const is_owner = row !== undefined && str(row.owner_id) === viewer.account_id;
		if (row === undefined || (!is_owner && row.published_revision_id === null)) {
			throw new GrownError('not_found', `There is nothing called "${slug}".`);
		}
		if (!is_owner) {
			throw new GrownError('forbidden', `Only its owner can ${what} "${slug}".`);
		}
		requireAdmin(viewer, what);
		return {
			id: str(row.id),
			kind: str(row.kind) as GrownKind,
			owner_id: str(row.owner_id),
			published_revision_id: optStr(row.published_revision_id)
		};
	}

	async function revision(thing_id: string, number?: number): Promise<GrownRevision | undefined> {
		const result = await client.execute({
			sql:
				number === undefined
					? `SELECT ${REVISION_COLUMNS} FROM grown_revisions r
						WHERE r.thing_id = ? ORDER BY r.number DESC LIMIT 1`
					: `SELECT ${REVISION_COLUMNS} FROM grown_revisions r
						WHERE r.thing_id = ? AND r.number = ?`,
			args: number === undefined ? [thing_id] : [thing_id, number]
		});
		const row = result.rows[0];
		return row === undefined ? undefined : toRevision(row as Record<string, unknown>);
	}

	/**
	 * The statements that add the next revision, stamp the thing and drop
	 * revisions past the kept window. Run in one batch, so they apply together;
	 * the number is taken inside the insert, so concurrent writers never share
	 * one (and `UNIQUE (thing_id, number)` would refuse it if they did).
	 */
	function appendStatements(
		thing_id: string,
		revision: {
			name: string;
			description: string;
			json: string;
			author: GrownAuthor;
			reverted_from: number | null;
		},
		stamp: string
	): InStatement[] {
		return [
			{
				sql: `INSERT INTO grown_revisions (id, thing_id, number, name, description, spec_json,
						author_kind, author_account_id, author_chat_id, reverted_from, created_at)
					SELECT ?2, ?1, COALESCE(MAX(number), 0) + 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
					FROM grown_revisions WHERE thing_id = ?1
					HAVING EXISTS (SELECT 1 FROM grown_things WHERE id = ?1)`,
				args: [
					thing_id,
					newId('gr'),
					revision.name,
					revision.description,
					revision.json,
					revision.author.kind,
					revision.author.account_id,
					revision.author.kind === 'first_mate' ? revision.author.chat_id : null,
					revision.reverted_from,
					stamp
				]
			},
			{
				sql: 'UPDATE grown_things SET updated_at = ? WHERE id = ?',
				args: [stamp, thing_id]
			},
			{
				// Keep the newest revisions and the published one; drop older ones whole.
				sql: `DELETE FROM grown_revisions
					WHERE thing_id = ?1
					AND number <= (SELECT MAX(number) FROM grown_revisions WHERE thing_id = ?1) - ?2
					AND id IS NOT (SELECT published_revision_id FROM grown_things WHERE id = ?1)`,
				args: [thing_id, GROWN_REVISIONS_KEPT]
			}
		];
	}

	async function afterWrite(viewer: GrownViewer, slug: string): Promise<GrownThing> {
		const thing = await visible(viewer, slug);
		if (thing === undefined) throw new Error('grown thing vanished after write');
		return thing;
	}

	return {
		async create(viewer, input) {
			requireAdmin(viewer, 'create views, surfaces or apps');
			const kind = kindOf(input.kind);
			checkSlug(input.slug);
			const name = checkName(input.name);
			const description = checkDescription(input.description ?? '');
			const { json } = await parseGrownSpec(kind, input.spec);
			const stamp = now().toISOString();
			const id = newId('gt');
			const limit = GROWN_KINDS[kind].per_owner;
			let inserted;
			try {
				// The per-owner count is checked inside the insert, so the limit
				// holds against concurrent creates; the revision insert follows it
				// in the same batch and adds nothing when the thing was refused.
				[inserted] = await client.batch(
					[
						{
							sql: `INSERT INTO grown_things
									(id, kind, slug, owner_id, published_revision_id, created_at, updated_at)
								SELECT ?1, ?2, ?3, ?4, NULL, ?5, ?5
								WHERE (SELECT COUNT(*) FROM grown_things WHERE owner_id = ?4 AND kind = ?2) < ?6`,
							args: [id, kind, input.slug, viewer.account_id, stamp, limit]
						},
						...appendStatements(
							id,
							{ name, description, json, author: input.author, reverted_from: null },
							stamp
						)
					],
					'write'
				);
			} catch (error) {
				if (String(error).includes('UNIQUE')) {
					throw new GrownError('conflict', `The slug "${input.slug}" is taken. Pick another.`);
				}
				throw error;
			}
			if (inserted.rowsAffected === 0) {
				throw new GrownError(
					'conflict',
					`You have ${limit} ${kind}s, the most one account may keep. Delete one first.`
				);
			}
			return afterWrite(viewer, input.slug);
		},

		read: visible,

		async list(viewer, kind) {
			const where = ['(t.owner_id = ?1 OR t.published_revision_id IS NOT NULL)'];
			const args: string[] = [viewer.account_id];
			if (kind !== undefined) {
				where.push('t.kind = ?2');
				args.push(kind);
			}
			const result = await client.execute({
				sql: `${VISIBLE_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.updated_at DESC, t.slug`,
				args
			});
			return result.rows.map((row) => toThing(row as Record<string, unknown>));
		},

		async history(viewer, slug) {
			const thing = await owned(viewer, slug, 'see the history of');
			const result = await client.execute({
				sql: `SELECT ${REVISION_COLUMNS} FROM grown_revisions r
					WHERE r.thing_id = ? ORDER BY r.number DESC`,
				args: [thing.id]
			});
			return result.rows.map((row) => toRevision(row as Record<string, unknown>));
		},

		async revise(viewer, slug, input) {
			const thing = await owned(viewer, slug, 'change');
			const current = await revision(thing.id);
			if (current === undefined) throw new Error('grown thing has no revision');
			const name = input.name === undefined ? current.name : checkName(input.name);
			const description =
				input.description === undefined ? current.description : checkDescription(input.description);
			const json =
				input.spec === undefined
					? JSON.stringify(current.spec)
					: (await parseGrownSpec(thing.kind, input.spec)).json;
			await client.batch(
				appendStatements(
					thing.id,
					{ name, description, json, author: input.author, reverted_from: null },
					now().toISOString()
				),
				'write'
			);
			return afterWrite(viewer, slug);
		},

		async revert(viewer, slug, number, author) {
			const thing = await owned(viewer, slug, 'revert');
			const old = await revision(thing.id, number);
			if (old === undefined) {
				throw new GrownError(
					'not_found',
					`"${slug}" has no revision ${number}. Its history lists the ones kept.`
				);
			}
			// Re-parse, so a revert never restores a spec today's schema refuses.
			const { json } = await parseGrownSpec(thing.kind, old.spec);
			await client.batch(
				appendStatements(
					thing.id,
					{ name: old.name, description: old.description, json, author, reverted_from: number },
					now().toISOString()
				),
				'write'
			);
			return afterWrite(viewer, slug);
		},

		async publish(viewer, slug, number) {
			const thing = await owned(viewer, slug, 'publish');
			const target = await revision(thing.id, number);
			if (target === undefined) {
				throw new GrownError('not_found', `"${slug}" has no revision ${number}.`);
			}
			await client.execute({
				sql: 'UPDATE grown_things SET published_revision_id = ?, updated_at = ? WHERE id = ?',
				args: [target.id, now().toISOString(), thing.id]
			});
			return afterWrite(viewer, slug);
		},

		async unpublish(viewer, slug) {
			requireAdmin(viewer, 'unpublish');
			const result = await client.execute({
				sql: `UPDATE grown_things SET published_revision_id = NULL, updated_at = ?
					WHERE slug = ? AND (owner_id = ? OR published_revision_id IS NOT NULL)`,
				args: [now().toISOString(), slug, viewer.account_id]
			});
			if (result.rowsAffected === 0) {
				throw new GrownError('not_found', `There is nothing called "${slug}".`);
			}
			return visible(viewer, slug);
		},

		async remove(viewer, slug) {
			const thing = await owned(viewer, slug, 'delete');
			await client.batch(
				[
					{ sql: 'DELETE FROM grown_revisions WHERE thing_id = ?', args: [thing.id] },
					{ sql: 'DELETE FROM grown_things WHERE id = ?', args: [thing.id] }
				],
				'write'
			);
		}
	};
}
