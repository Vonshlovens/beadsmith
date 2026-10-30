import { describe, expect, it } from 'vitest';
import {
	eventToken,
	liveScopes,
	matchToken,
	type HotkeyBinding,
	type HotkeyScope,
	SEQUENCE_TIMEOUT_MS
} from '$lib/client/hotkeys';
import { LIST_ACTIONS, listBindings, modeLabel, paletteEntries, type ListMode } from './keymap.js';

function setup(mode: ListMode, live: (id: string) => boolean = () => true) {
	const ran: string[] = [];
	const go: HotkeyBinding[] = ['g p', 'g i', 'g t', 'g a'].map((keys) => ({
		keys: [keys],
		label: keys,
		group: 'Go to',
		run: () => void ran.push(keys)
	}));
	const handlers = Object.fromEntries(
		LIST_ACTIONS.map((action) => [action.id, () => void ran.push(action.id)])
	);
	const scopes: HotkeyScope[] = [
		{ id: 1, bindings: go },
		{ id: 2, bindings: listBindings(handlers, () => mode, live) }
	];
	/** Type tokens the way hotkey-host does; the last outcome: what ran, or pending/none. */
	function type(...tokens: string[]): string {
		let pending: string[] = [];
		let outcome = 'none';
		for (const token of tokens) {
			let result = matchToken(liveScopes(scopes, false), pending, token, false);
			if (result.kind === 'none' && pending.length > 0) {
				result = matchToken(liveScopes(scopes, false), [], token, false);
			}
			if (result.kind === 'pending') {
				pending = [...pending, token];
				outcome = 'pending';
				continue;
			}
			pending = [];
			if (result.kind === 'run') {
				result.binding.run?.({} as KeyboardEvent);
				outcome = ran[ran.length - 1];
			} else {
				outcome = 'none';
			}
		}
		return outcome;
	}
	return { type, ran };
}

describe('chord resolution', () => {
	it('gg reaches the list while g t still goes to Todos', () => {
		const { type } = setup('normal');
		expect(type('g', 'g')).toBe('first');
		expect(type('g', 't')).toBe('g t');
		expect(type('g')).toBe('pending');
	});

	it('resolves the two-key chords', () => {
		const { type } = setup('normal');
		expect(type('d', 'd')).toBe('archive');
		expect(type('y', 'y')).toBe('copy_line');
		expect(type('y', 'b')).toBe('copy_body');
		expect(type('f', 'p')).toBe('filter_project');
		expect(type('f', 'c')).toBe('filter_context');
		expect(type('f', 'f')).toBe('filter_saved');
		expect(type('f', 's')).toBe('save');
	});

	it('abandons a chord on a key that completes nothing', () => {
		const { type } = setup('normal');
		expect(type('d', 'x')).toBe('toggle');
		expect(SEQUENCE_TIMEOUT_MS).toBeGreaterThan(0);
	});

	it('maps single keys', () => {
		const { type } = setup('normal');
		expect(type('j')).toBe('down');
		expect(type('ArrowUp')).toBe('up');
		expect(type('G')).toBe('last');
		expect(type('J')).toBe('move_down');
		expect(type('K')).toBe('move_up');
		expect(type('S')).toBe('save');
		expect(type(':')).toBe('palette');
		expect(type('mod+d')).toBe('half_down');
		expect(type('mod+u')).toBe('half_up');
	});

	it('n adds, unless a search is committed, when it steps to the next match', () => {
		expect(setup('normal', () => true).type('n')).toBe('match_next');
		expect(setup('normal', (id) => id !== 'match_next').type('n')).toBe('add');
		expect(setup('normal').type('o')).toBe('add');
	});

	it('is mode aware', () => {
		expect(setup('visual').type('Space')).toBe('flip');
		expect(setup('normal').type('Space')).toBe('none');
		expect(setup('visual').type('J')).toBe('none');
		expect(setup('normal').type('Enter')).toBe('none');
		expect(setup('pick').type('Enter')).toBe('pick_commit');
		expect(setup('pick').type('x')).toBe('none');
		expect(setup('search').type('j')).toBe('none');
	});

	it('names the real keyboard events', () => {
		expect(eventToken({ key: 'd', ctrlKey: true })).toBe('mod+d');
		expect(eventToken({ key: 'G', shiftKey: true })).toBe('G');
		expect(eventToken({ key: ' ' })).toBe('Space');
	});
});

describe('palette and chip', () => {
	it('filters by words and leaves out movement', () => {
		expect(paletteEntries('sort').map((e) => e.id)).toContain('sort');
		expect(paletteEntries('').some((e) => e.id === 'down')).toBe(false);
		expect(paletteEntries('zzzz')).toEqual([]);
		expect(paletteEntries('save search')[0].id).toBe('save');
	});

	it('offers only commands live in the mode, never the hidden ones', () => {
		const ids = paletteEntries('').map((e) => e.id);
		expect(ids).not.toContain('pick_commit');
		expect(paletteEntries('keep the filter')).toEqual([]);
		expect(paletteEntries('', 'visual').map((e) => e.id)).not.toContain('add');
		expect(paletteEntries('', 'pick').map((e) => e.id)).toEqual(['cancel']);
		expect(ids).toContain('archive_done');
		expect(paletteEntries('match', 'normal', (id) => !id.startsWith('match'))).toEqual([]);
	});

	it('maps A to archive-all and keeps s sort, S save', () => {
		expect(setup('normal').type('A')).toBe('archive_done');
		expect(setup('normal').type('a')).toBe('archive_view');
		expect(setup('normal').type('s')).toBe('sort');
		expect(setup('normal').type('S')).toBe('save');
		expect(setup('visual').type('A')).toBe('none');
	});

	it('labels modes and armed chords', () => {
		expect(modeLabel('normal', [])).toBe('NORMAL');
		expect(modeLabel('visual', [])).toBe('VISUAL');
		expect(modeLabel('search', [])).toBe('SEARCH');
		expect(modeLabel('normal', ['d'])).toBe('d…');
	});

	it('has no duplicate key within a mode', () => {
		for (const mode of ['normal', 'visual', 'pick'] as const) {
			const seen = new Map<string, string>();
			for (const action of LIST_ACTIONS.filter((a) => a.modes.includes(mode))) {
				for (const key of action.keys) {
					const clash = seen.get(key);
					// `n` is deliberately two actions: match_next only while searching.
					if (clash !== undefined && !(key === 'n')) {
						throw new Error(`${key} is both ${clash} and ${action.id} in ${mode}`);
					}
					seen.set(key, action.id);
				}
			}
		}
	});
});
