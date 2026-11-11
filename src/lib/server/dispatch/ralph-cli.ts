/**
 * The vocabulary of ralph's command line (`ralph <mode> --harness …`),
 * shared by the request schema, the loop payload and the `/v1` client.
 * Kept free of imports so validation can read it without pulling in the
 * client and its stream readers.
 */

/** ralph's loop commands: `ralph run`, `plan`, `build` and `reverse`. */
export const RALPH_MODES = ['run', 'plan', 'build', 'reverse'] as const;
export type RalphMode = (typeof RALPH_MODES)[number];

/** Agent CLIs ralph can drive (`--harness`). */
export const RALPH_HARNESSES = ['claude', 'codex', 'opencode', 'gh'] as const;
export type RalphHarness = (typeof RALPH_HARNESSES)[number];
