/**
 * Limits every grown thing shares (ADR-0025 rule 8), whatever its kind. The
 * store in `src/lib/server/grown/store.ts` enforces them on every write; the
 * browser imports the same values so a form can say what fits before it
 * asks the server.
 */

export const GROWN_NAME_MAX = 80;
export const GROWN_SLUG_MAX = 64;
/** Lowercase letters and digits in dash-separated words, like "blocked-on-review". */
export const GROWN_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const GROWN_DESCRIPTION_MAX = 500;
