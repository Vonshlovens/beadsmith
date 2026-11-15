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

export type GrownAuthorKind = 'person' | 'first_mate';

/**
 * The bridge's actions (ADR-0025 rule 6): only ones that reuse existing
 * authority, todo changes and mission launches through dispatch. The server's
 * allowlist (`src/lib/server/grown/bridge.ts`) is keyed by these names, and
 * the browser reads them too: an app's host must tell an action, which waits
 * for the host confirmation, from a read, which does not.
 */
export const BRIDGE_ACTION_NAMES = [
	'create_todo',
	'update_todo',
	'complete_todo',
	'file_issue',
	'comment_issue',
	'tackle_issue',
	'discuss_issue'
] as const;

export type BridgeActionName = (typeof BRIDGE_ACTION_NAMES)[number];

/** True when `name` is one of the bridge's actions. */
export function isBridgeAction(name: string): name is BridgeActionName {
	return (BRIDGE_ACTION_NAMES as readonly string[]).includes(name);
}

/**
 * A grown thing as this viewer sees it, whatever its kind: the owner sees
 * the latest revision, anyone else the published one. Owner-only facts (the
 * latest number, whether the published revision is behind) are present only
 * for the owner. Each kind names its own spec shape (`ViewSummary`,
 * `SurfaceSummary`).
 */
export interface GrownSummary<Spec> {
	slug: string;
	name: string;
	description: string;
	spec: Spec;
	/** The revision shown. */
	revision: number;
	/** Who wrote the shown revision. */
	author_kind: GrownAuthorKind;
	/** True when the viewer owns it, and so may change, revert and publish it. */
	mine: boolean;
	/** True when members can see a revision of it. */
	published: boolean;
	/**
	 * Owner only: true when a revision newer than the published one exists,
	 * which members do not see until it is published.
	 */
	unpublished_changes?: boolean;
	created_at: string;
	updated_at: string;
}

/** One kept revision, in the owner's history. */
export interface GrownRevisionView<Spec> {
	number: number;
	name: string;
	description: string;
	spec: Spec;
	author_kind: GrownAuthorKind;
	/** The First Mate chat that wrote it. */
	author_chat_id?: string;
	/** The revision a revert copied forward. */
	reverted_from?: number;
	/** True for the revision members see. */
	published: boolean;
	created_at: string;
}
