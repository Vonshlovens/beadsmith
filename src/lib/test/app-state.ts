/**
 * Stand-in for SvelteKit's `$app/state`, aliased in by `vitest.config.ts`
 * for component render tests: a page at the site root with no data, which is
 * what a server render outside a request sees.
 */
export const page = {
	url: new URL('http://beadsmith.test/'),
	params: {} as Record<string, string>,
	route: { id: null as string | null },
	status: 200,
	error: null,
	data: {} as Record<string, unknown>,
	form: null,
	state: {}
};

export const navigating = { from: null, to: null, type: null };
export const updated = { current: false, check: async () => false };
