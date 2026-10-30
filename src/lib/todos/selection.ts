/**
 * Visual-mode selection, tuxedo's `v`: the anchor is the row
 * under the cursor when `v` was pressed, moving the cursor extends the range
 * between them, and `space` flips single rows in or out of that range.
 */
export interface Visual {
	anchor: string;
	/** Rows flipped by `space`, relative to the anchor..cursor range. */
	flipped: ReadonlySet<string>;
}

export function startVisual(anchor: string): Visual {
	return { anchor, flipped: new Set() };
}

/** Ids between `a` and `b` inclusive, in list order; just the ones found. */
export function rangeBetween(ids: readonly string[], a: string, b: string): string[] {
	const from = ids.indexOf(a);
	const to = ids.indexOf(b);
	if (from === -1 || to === -1) {
		return to === -1 ? (from === -1 ? [] : [a]) : [b];
	}
	return ids.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** The selected ids, in list order. */
export function selectedIds(visual: Visual, ids: readonly string[], cursor: string): string[] {
	const range = new Set(rangeBetween(ids, visual.anchor, cursor));
	for (const id of visual.flipped) {
		if (range.has(id)) range.delete(id);
		else if (ids.includes(id)) range.add(id);
	}
	return ids.filter((id) => range.has(id));
}

/** `space`: flip the row under the cursor. */
export function flipRow(visual: Visual, id: string): Visual {
	const flipped = new Set(visual.flipped);
	if (flipped.has(id)) flipped.delete(id);
	else flipped.add(id);
	return { ...visual, flipped };
}

/** Move a cursor id by `delta` rows, clamped to the list. */
export function moveCursor(
	ids: readonly string[],
	current: string | null,
	delta: number
): string | null {
	if (ids.length === 0) {
		return null;
	}
	const at = current === null ? -1 : ids.indexOf(current);
	if (at === -1) {
		return delta >= 0 ? ids[0] : ids[ids.length - 1];
	}
	return ids[Math.min(ids.length - 1, Math.max(0, at + delta))];
}
