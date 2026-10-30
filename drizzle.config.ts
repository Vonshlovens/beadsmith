import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle schema config for the local state DB.
 *
 * The runtime does NOT use drizzle-kit push/migrate — `state/db.ts` creates the
 * tables idempotently with `CREATE TABLE IF NOT EXISTS`. This config exists so
 * `src/lib/server/state/schema.ts` stays the reviewable source of truth and so
 * schema drift can be inspected with drizzle-kit tooling.
 */
export default defineConfig({
	dialect: 'sqlite',
	schema: './src/lib/server/state/schema.ts',
	out: './drizzle'
});
