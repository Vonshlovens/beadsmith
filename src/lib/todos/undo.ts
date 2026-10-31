/**
 * Undo stack for the tuxedo list view. An entry is the set of
 * field values to restore, so undoing a complete, archive, priority change,
 * reorder, edit or add is always "PATCH these ids back". Capped like tuxedo
 * (50 levels); the oldest entry falls off.
 */
export const UNDO_LIMIT = 50;

/** Fields an undo may write back (the PATCH fields the list view changes). */
export interface Restore {
	title?: string;
	priority?: number;
	due_at?: string | null;
	tags?: string[];
	status?: 'open' | 'done' | 'archived';
	sort_key?: number;
}

export interface UndoEntry {
	/** What was done, for the "undid …" toast. */
	label: string;
	restores: { id: string; fields: Restore }[];
}

export class UndoStack {
	private entries: UndoEntry[] = [];

	constructor(private readonly limit = UNDO_LIMIT) {}

	get size(): number {
		return this.entries.length;
	}

	push(entry: UndoEntry): void {
		if (entry.restores.length === 0) {
			return;
		}
		this.entries.push(entry);
		if (this.entries.length > this.limit) {
			this.entries.shift();
		}
	}

	/** The newest entry, removed; undefined when there is nothing to undo. */
	pop(): UndoEntry | undefined {
		return this.entries.pop();
	}

	/** Drop `entry` wherever it sits (a change that failed after newer ones landed). */
	remove(entry: UndoEntry): void {
		this.entries = this.entries.filter((item) => item !== entry);
	}

	clear(): void {
		this.entries = [];
	}
}

/**
 * Snapshot of `keys` from `todo`, to restore later.
 * @param todo The todo before the change.
 * @param keys Which fields the change touches.
 */
export function snapshot<K extends keyof Restore>(
	todo: { id: string } & Required<Pick<Restore, K>>,
	keys: readonly K[]
): { id: string; fields: Restore } {
	const fields: Restore = {};
	for (const key of keys) {
		(fields as Record<string, unknown>)[key] = todo[key];
	}
	return { id: todo.id, fields };
}
