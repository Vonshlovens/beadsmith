import { createClient, type Client } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import {
	createGrownStore,
	GROWN_DESCRIPTION_MAX,
	GROWN_KINDS,
	GROWN_NAME_MAX,
	GROWN_REVISIONS_KEPT,
	type GrownAuthor,
	type GrownStore,
	type GrownViewer
} from './store.js';
import { GrownError } from './errors.js';

let client: Client;
let store: GrownStore;

const owner: GrownViewer = { account_id: 'u_owner', role: 'admin' };
const other_admin: GrownViewer = { account_id: 'u_admin2', role: 'admin' };
const member: GrownViewer = { account_id: 'u_member', role: 'member' };
const person: GrownAuthor = { kind: 'person', account_id: 'u_owner', chat_id: null };
const mate: GrownAuthor = { kind: 'first_mate', account_id: 'u_owner', chat_id: 'mc_one' };

const blocked = { scope: 'all', filters: { status: ['blocked'] } };
const review = { scope: 'all', filters: { label: 'review' }, presentation: 'board' };

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createGrownStore(client);
});

function create(slug = 'blocked', spec: unknown = blocked, viewer = owner) {
	return store.create(viewer, { kind: 'view', slug, name: 'Blocked', spec, author: person });
}

async function refusal(promise: Promise<unknown>): Promise<GrownError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof GrownError) return error;
		throw error;
	}
	throw new Error('expected a GrownError');
}

describe('grown store', () => {
	it('creates a private view with its first revision and the parsed spec', async () => {
		const thing = await create();
		expect(thing).toMatchObject({
			kind: 'view',
			slug: 'blocked',
			owner_id: 'u_owner',
			published_revision_id: null,
			latest_number: 1,
			revision: { number: 1, name: 'Blocked', author_kind: 'person', reverted_from: null }
		});
		expect(thing.revision.spec).toEqual({
			scope: 'all',
			filters: { status: ['blocked'] },
			sort: 'updated',
			presentation: 'list'
		});
	});

	it('refuses an invalid spec, unknown kind, bad slug and long text', async () => {
		expect((await refusal(create('x', { scope: 'all', sql: 'SELECT 1' }))).code).toBe(
			'bad_request'
		);
		expect(
			(
				await refusal(
					store.create(owner, { kind: 'script', slug: 'x', name: 'x', spec: {}, author: person })
				)
			).message
		).toContain('Unknown kind');
		for (const slug of ['', 'Has-Caps', 'trailing-', 'a--b', 'x'.repeat(65), '../etc']) {
			expect((await refusal(create(slug))).code).toBe('bad_request');
		}
		expect(
			(
				await refusal(
					store.create(owner, {
						kind: 'view',
						slug: 'x',
						name: 'n'.repeat(GROWN_NAME_MAX + 1),
						spec: blocked,
						author: person
					})
				)
			).message
		).toContain(`${GROWN_NAME_MAX}`);
		expect(
			(
				await refusal(
					store.create(owner, {
						kind: 'view',
						slug: 'x',
						name: 'x',
						description: 'd'.repeat(GROWN_DESCRIPTION_MAX + 1),
						spec: blocked,
						author: person
					})
				)
			).code
		).toBe('bad_request');
	});

	it('refuses a spec over its size limit', async () => {
		// The view's field limits alone keep its spec well under 4 KB, so lower
		// the budget to prove the byte check refuses rather than truncates.
		const view = GROWN_KINDS.view as { max_bytes: number };
		const saved = view.max_bytes;
		view.max_bytes = 64;
		try {
			const error = await refusal(
				create('huge', { scope: 'all', filters: { q: 'q'.repeat(100) } })
			);
			expect(error.code).toBe('bad_request');
			expect(error.message).toContain('bytes of JSON');
		} finally {
			view.max_bytes = saved;
		}
		expect(await store.read(owner, 'huge')).toBeUndefined();
	});

	it('keeps slugs unique across owners', async () => {
		await create();
		const error = await refusal(create('blocked', blocked, other_admin));
		expect(error.code).toBe('conflict');
	});

	it('enforces the per-owner limit', async () => {
		const limit = GROWN_KINDS.view.per_owner;
		for (let i = 0; i < limit; i += 1) await create(`v${i}`);
		const error = await refusal(create('one-more'));
		expect(error.code).toBe('conflict');
		expect(error.message).toContain(`${limit}`);
		// Another owner is unaffected.
		await expect(create('theirs', blocked, other_admin)).resolves.toBeDefined();
	});

	it('creating and revising are admin-only', async () => {
		expect((await refusal(create('mine', blocked, member))).code).toBe('forbidden');
		await create();
		expect(
			(await refusal(store.revise(member, 'blocked', { name: 'x', author: person }))).code
		).toBe('not_found');
	});

	it('revises, reverts and keeps the history append-only', async () => {
		await create();
		await store.revise(owner, 'blocked', { spec: review, author: mate });
		const reverted = await store.revert(owner, 'blocked', 1, person);
		expect(reverted.latest_number).toBe(3);
		expect(reverted.revision).toMatchObject({ number: 3, reverted_from: 1, author_kind: 'person' });
		expect(reverted.revision.spec).toMatchObject({ filters: { status: ['blocked'] } });
		const history = await store.history(owner, 'blocked');
		expect(history.map((r) => [r.number, r.author_kind, r.author_chat_id])).toEqual([
			[3, 'person', null],
			[2, 'first_mate', 'mc_one'],
			[1, 'person', null]
		]);
		expect(history[1].spec).toMatchObject({ presentation: 'board' });
		expect((await refusal(store.revert(owner, 'blocked', 9, person))).code).toBe('not_found');
	});

	it('a member cannot read a private view; the published revision is all others see', async () => {
		await create();
		expect(await store.read(member, 'blocked')).toBeUndefined();
		expect(await store.read(other_admin, 'blocked')).toBeUndefined();
		expect(await store.list(member)).toEqual([]);
		expect((await refusal(store.history(member, 'blocked'))).code).toBe('not_found');

		await store.publish(owner, 'blocked');
		await store.revise(owner, 'blocked', { name: 'Blocked v2', spec: review, author: mate });

		const seen = await store.read(member, 'blocked');
		expect(seen?.revision).toMatchObject({ number: 1, name: 'Blocked' });
		expect((await store.read(owner, 'blocked'))?.revision).toMatchObject({
			number: 2,
			name: 'Blocked v2'
		});
		expect((await store.list(member, 'view')).map((t) => t.slug)).toEqual(['blocked']);
		// Seeing a published thing does not let anyone else change it.
		expect(
			(await refusal(store.revise(other_admin, 'blocked', { name: 'x', author: person }))).code
		).toBe('forbidden');
		expect((await refusal(store.history(member, 'blocked'))).code).toBe('forbidden');
		expect((await refusal(store.publish(other_admin, 'blocked', 2))).code).toBe('forbidden');
	});

	it('publishes a chosen revision; any admin unpublishes, a member cannot', async () => {
		await create();
		await store.revise(owner, 'blocked', { spec: review, author: mate });
		const published = await store.publish(owner, 'blocked', 1);
		expect(published.published_revision_id).toBe(
			(await store.history(owner, 'blocked')).find((r) => r.number === 1)?.id
		);
		expect((await refusal(store.unpublish(member, 'blocked'))).code).toBe('forbidden');
		expect(await store.unpublish(other_admin, 'blocked')).toBeUndefined();
		expect(await store.read(member, 'blocked')).toBeUndefined();
		expect((await store.read(owner, 'blocked'))?.published_revision_id).toBeNull();
		// Unpublishing a private thing someone else owns reveals nothing.
		expect((await refusal(store.unpublish(other_admin, 'blocked'))).code).toBe('not_found');
	});

	it('keeps the newest revisions plus the published one', async () => {
		await create();
		await store.publish(owner, 'blocked');
		for (let i = 0; i < GROWN_REVISIONS_KEPT + 5; i += 1) {
			await store.revise(owner, 'blocked', { name: `Blocked ${i}`, author: mate });
		}
		const history = await store.history(owner, 'blocked');
		const numbers = history.map((r) => r.number);
		expect(numbers).toHaveLength(GROWN_REVISIONS_KEPT + 1);
		expect(numbers[0]).toBe(GROWN_REVISIONS_KEPT + 6);
		expect(numbers.at(-1)).toBe(1);
		expect(numbers.at(-2)).toBe(7);
		expect((await store.read(member, 'blocked'))?.revision.number).toBe(1);
	});

	it('deletes a thing and its revisions, owner only', async () => {
		await create();
		await store.publish(owner, 'blocked');
		expect((await refusal(store.remove(other_admin, 'blocked'))).code).toBe('forbidden');
		await store.remove(owner, 'blocked');
		expect(await store.read(owner, 'blocked')).toBeUndefined();
		const left = await client.execute('SELECT COUNT(*) AS n FROM grown_revisions');
		expect(Number((left.rows[0] as Record<string, unknown>).n)).toBe(0);
		await expect(create()).resolves.toBeDefined();
	});
});
