/**
 * todo.txt-flavoured text for a todo: the row line, what
 * `yy` / `yb` copy, and the text the edit prompt starts from. Priority P0–P4
 * maps onto tuxedo's `(A)`–`(E)`. Edit text uses capture syntax, so the
 * existing {@link parseCapture} reads it back.
 */
export interface LineTodo {
	title: string;
	priority: number;
	due_at: string | null;
	tags: string[];
	status: string;
	completed_at: string | null;
}

export function priorityLetter(priority: number): string {
	return String.fromCharCode(65 + Math.min(4, Math.max(0, priority)));
}

function dateOnly(iso: string | null): string {
	return iso === null ? '' : iso.slice(0, 10);
}

/** `x 2026-10-28 (B) title +tag due:2026-11-03` — the raw line. */
export function rawLine(todo: LineTodo): string {
	const parts: string[] = [];
	if (todo.status === 'done') {
		parts.push('x', dateOnly(todo.completed_at));
	}
	parts.push(`(${priorityLetter(todo.priority)})`, todo.title, ...todo.tags);
	if (todo.due_at !== null) {
		parts.push(`due:${todo.due_at}`);
	}
	return parts.filter((part) => part !== '').join(' ');
}

/** `yb`: the title alone, without priority, tags or dates. */
export function bodyLine(todo: Pick<LineTodo, 'title'>): string {
	return todo.title;
}

/** Edit-prompt text: `title p1 due:2026-11-03 +tag`. */
export function editLine(todo: LineTodo): string {
	const parts = [todo.title, `p${todo.priority}`];
	if (todo.due_at !== null) parts.push(`due:${todo.due_at}`);
	parts.push(...todo.tags);
	return parts.join(' ');
}

/** Cycle P0 → P1 → … → P4 → P0. */
export function nextPriority(priority: number): number {
	return (Math.min(4, Math.max(0, priority)) + 1) % 5;
}

/**
 * Add `tag` if the todo lacks it, else remove it (tuxedo's `c` / `+`).
 * Case-insensitive; the sigil is added when missing.
 */
export function toggleTag(tags: readonly string[], tag: string, sigil: '+' | '@'): string[] {
	const bare = tag.trim().replace(/^[+@]/, '');
	if (bare === '') return [...tags];
	const full = `${sigil}${bare}`;
	const at = tags.findIndex((existing) => existing.toLowerCase() === full.toLowerCase());
	return at === -1 ? [...tags, full] : tags.filter((_, index) => index !== at);
}
