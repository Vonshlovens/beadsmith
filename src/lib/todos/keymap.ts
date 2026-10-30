/**
 * The tuxedo list view's key map: one table drives the
 * hotkey bindings (so keys appear in the `?` overlay), the `:` palette, and
 * docs/keyboard.md. Pure; the view supplies handlers.
 *
 * Chords: `g g` (first row) shares the `g` prefix with the app's go-to chords
 * (`g t`, `g p` …). The matcher waits for the second key, so `g` then `g`
 * reaches the list and `g` then `t` goes to Todos; no go-to chord is `g g`.
 * Within the list's own keys `d d`, `y y`, `y b`, `f p`, `f c`, `f f`, `f s`
 * are the same kind of two-key chord, armed for 1.2 s (the app-wide window).
 */
import type { HotkeyBinding } from '$lib/client/hotkeys';

export type ListMode = 'normal' | 'visual' | 'search' | 'insert' | 'command' | 'pick';

/** Modes in which the single-key table is live. */
export type KeyMode = 'normal' | 'visual' | 'pick';

export interface ListAction {
	id: string;
	keys: readonly string[];
	label: string;
	modes: readonly KeyMode[];
	/** Left out of the `:` palette (movement). */
	palette?: false;
	/** Not listed in the `?` overlay. */
	hidden?: true;
}

const N: readonly KeyMode[] = ['normal'];
const NV: readonly KeyMode[] = ['normal', 'visual'];
const ALL: readonly KeyMode[] = ['normal', 'visual', 'pick'];

export const LIST_ACTIONS: readonly ListAction[] = [
	{ id: 'down', keys: ['j', 'ArrowDown'], label: 'Next todo', modes: ALL, palette: false },
	{ id: 'up', keys: ['k', 'ArrowUp'], label: 'Previous todo', modes: ALL, palette: false },
	{ id: 'first', keys: ['g g', 'Home'], label: 'First todo', modes: NV, palette: false },
	{ id: 'last', keys: ['G', 'End'], label: 'Last todo', modes: NV, palette: false },
	{ id: 'half_down', keys: ['mod+d'], label: 'Half page down', modes: NV, palette: false },
	{ id: 'half_up', keys: ['mod+u'], label: 'Half page up', modes: NV, palette: false },
	{ id: 'pick_commit', keys: ['Enter'], label: 'Keep the filter', modes: ['pick'], hidden: true },
	{ id: 'match_next', keys: ['n'], label: 'Next search match', modes: N },
	{ id: 'match_prev', keys: ['N'], label: 'Previous search match', modes: N },
	{ id: 'add', keys: ['n', 'o'], label: 'Add a todo', modes: N },
	{ id: 'edit', keys: ['e', 'i'], label: 'Edit the todo', modes: N },
	{ id: 'toggle', keys: ['x'], label: 'Complete or reopen (selection in visual)', modes: NV },
	{ id: 'archive', keys: ['d d'], label: 'Archive (selection in visual)', modes: NV },
	{ id: 'archive_done', keys: ['A'], label: 'Archive every completed todo (undoable)', modes: N },
	{ id: 'priority', keys: ['p'], label: 'Cycle priority P0 → P4 (selection in visual)', modes: NV },
	{ id: 'move_down', keys: ['J'], label: 'Move down within its sort tie', modes: N },
	{ id: 'move_up', keys: ['K'], label: 'Move up within its sort tie', modes: N },
	{ id: 'context', keys: ['c'], label: 'Add or remove an @context', modes: NV },
	{ id: 'project', keys: ['+'], label: 'Add or remove a +project', modes: NV },
	{ id: 'copy_line', keys: ['y y'], label: 'Copy the todo.txt line', modes: NV },
	{ id: 'copy_body', keys: ['y b'], label: 'Copy the title only', modes: NV },
	{ id: 'undo', keys: ['u'], label: 'Undo (50 levels)', modes: NV },
	{ id: 'visual', keys: ['v'], label: 'Visual (multi-select) mode', modes: NV },
	{
		id: 'flip',
		keys: ['Space'],
		label: 'Add or drop this row in the selection',
		modes: ['visual']
	},
	{ id: 'search', keys: ['/'], label: 'Search', modes: N },
	{ id: 'sort', keys: ['s'], label: 'Cycle sort: urgency, due, priority, manual', modes: N },
	{ id: 'save', keys: ['S', 'f s'], label: 'Save the search', modes: N },
	{ id: 'filter_project', keys: ['f p'], label: 'Filter by +project (j/k cycles)', modes: N },
	{ id: 'filter_context', keys: ['f c'], label: 'Filter by @context (j/k cycles)', modes: N },
	{ id: 'filter_saved', keys: ['f f'], label: 'Pick a saved search (j/k cycles)', modes: N },
	{ id: 'show_done', keys: ['H'], label: 'Show or hide done todos', modes: N },
	{ id: 'archive_view', keys: ['a'], label: 'Archive view (done, by date)', modes: N },
	{ id: 'sidebar', keys: ['['], label: 'Toggle the filter sidebar', modes: N },
	{ id: 'detail', keys: [']'], label: 'Toggle the detail pane', modes: N },
	{ id: 'density', keys: ['D'], label: 'Cycle density', modes: N },
	{ id: 'numbers', keys: ['L'], label: 'Toggle line numbers', modes: N },
	{ id: 'palette', keys: [':', 'mod+p'], label: 'Command palette', modes: N },
	{ id: 'route', keys: ['r'], label: 'Route to a project', modes: N },
	{
		id: 'cancel',
		keys: ['Escape'],
		label: 'Cancel a chord or mode; clear search and filter',
		modes: ALL
	}
];

/** What a handler may return: `false` lets the key through. */
export type ActionHandler = () => void | boolean;

/**
 * Hotkey bindings for the table. Order matters inside a scope (first live
 * match wins), and the table lists `n` next-match before `n` add; `match_next`
 * is only live while a search is committed.
 *
 * @param handlers - Action id → handler; actions without one are skipped.
 * @param mode - The current mode.
 * @param live - Extra per-action gate (`match_next` needs a search; `route` needs a routable row).
 */
export function listBindings(
	handlers: Record<string, ActionHandler | undefined>,
	mode: () => ListMode,
	live: (id: string) => boolean = () => true
): HotkeyBinding[] {
	const out: HotkeyBinding[] = [];
	for (const action of LIST_ACTIONS) {
		const run = handlers[action.id];
		if (run === undefined) continue;
		out.push({
			keys: action.keys,
			label: action.label,
			group: 'Todo list',
			hidden: action.hidden === true,
			run,
			when: () => (action.modes as readonly ListMode[]).includes(mode()) && live(action.id)
		});
	}
	return out;
}

export interface PaletteEntry {
	id: string;
	label: string;
	keys: string;
}

/**
 * Palette rows matching `query` (every word a substring of label or id).
 * Only actions live in `mode` are offered, and never the hidden ones (the
 * palette opens from NORMAL, so "Keep the filter" is not a command), and
 * only those `live` allows (no "Next search match" without a search).
 */
export function paletteEntries(
	query: string,
	mode: KeyMode = 'normal',
	live: (id: string) => boolean = () => true
): PaletteEntry[] {
	const words = query
		.toLowerCase()
		.split(/\s+/)
		.filter((word) => word !== '');
	return LIST_ACTIONS.filter(
		(action) =>
			action.palette !== false &&
			action.hidden !== true &&
			action.id !== 'palette' &&
			action.modes.includes(mode) &&
			live(action.id)
	)
		.filter((action) => {
			const haystack = `${action.label} ${action.id.replace(/_/g, ' ')}`.toLowerCase();
			return words.every((word) => haystack.includes(word));
		})
		.map((action) => ({ id: action.id, label: action.label, keys: action.keys[0] }));
}

/** Text for the mode chip. */
export function modeLabel(mode: ListMode, pending: readonly string[]): string {
	if (pending.length > 0) {
		return `${pending.join('')}…`;
	}
	return {
		normal: 'NORMAL',
		visual: 'VISUAL',
		search: 'SEARCH',
		insert: 'INSERT',
		command: 'COMMAND',
		pick: 'FILTER'
	}[mode];
}
