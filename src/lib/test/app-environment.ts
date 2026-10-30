/**
 * Stand-in for SvelteKit's generated `$app/environment`, aliased in by
 * `vitest.config.ts`. Tests run under node with no DOM, which is exactly the
 * server case the real module reports.
 */
export const browser = false;
export const building = false;
export const dev = false;
export const version = 'test';
