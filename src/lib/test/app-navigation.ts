/**
 * Stand-in for SvelteKit's `$app/navigation`, aliased in by
 * `vitest.config.ts` so component render tests can import components that
 * navigate. Rendering never navigates; a call here means a test drove an
 * event handler it should not have.
 */
function unavailable(name: string): never {
	throw new Error(`$app/navigation ${name}() is not available in component render tests`);
}

export const goto = (..._args: unknown[]): Promise<void> => unavailable('goto');
export const invalidate = (..._args: unknown[]): Promise<void> => unavailable('invalidate');
export const invalidateAll = (): Promise<void> => unavailable('invalidateAll');
