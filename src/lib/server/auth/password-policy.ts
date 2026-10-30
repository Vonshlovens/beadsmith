/**
 * Password length rules (ADR-0011). They sit in a file of their own so the
 * recovery command, which Deno runs without SvelteKit, applies the same
 * limits as `service.ts` without importing it.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
