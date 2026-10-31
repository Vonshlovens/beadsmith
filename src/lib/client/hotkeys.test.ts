import { describe, expect, it, vi } from 'vitest';
import {
	describeSequence,
	eventToken,
	isTypingTarget,
	liveScopes,
	matchToken,
	overlayGroups,
	type HotkeyBinding,
	type HotkeyScope
} from './hotkeys.js';

function binding(keys: string[], extra: Partial<HotkeyBinding> = {}): HotkeyBinding {
	return { keys, label: keys.join(','), group: 'General', run: vi.fn(), ...extra };
}

describe('eventToken', () => {
	it('keeps printable characters as typed and spells out named keys', () => {
		expect(eventToken({ key: 'j' })).toBe('j');
		expect(eventToken({ key: '?', shiftKey: true })).toBe('?');
		expect(eventToken({ key: 'G', shiftKey: true })).toBe('G');
		expect(eventToken({ key: 'ArrowDown' })).toBe('ArrowDown');
		expect(eventToken({ key: 'Enter', shiftKey: true })).toBe('shift+Enter');
		expect(eventToken({ key: 'k', metaKey: true })).toBe('mod+k');
		expect(eventToken({ key: 'K', ctrlKey: true, shiftKey: true })).toBe('mod+k');
		expect(eventToken({ key: ' ' })).toBe('Space');
	});

	it('ignores lone modifiers and IME composition', () => {
		expect(eventToken({ key: 'Shift', shiftKey: true })).toBeNull();
		expect(eventToken({ key: 'Meta', metaKey: true })).toBeNull();
		expect(eventToken({ key: 'j', isComposing: true })).toBeNull();
	});
});

describe('matchToken', () => {
	const jump = binding(['g i']);
	const next = binding(['j', 'ArrowDown']);
	const blur = binding(['Escape'], { in_fields: true });
	const scopes: HotkeyScope[] = [{ id: 1, bindings: [jump, next, blur] }];

	it('runs single keys and either alternative', () => {
		expect(matchToken(scopes, [], 'j', false)).toEqual({ kind: 'run', binding: next });
		expect(matchToken(scopes, [], 'ArrowDown', false)).toEqual({ kind: 'run', binding: next });
	});

	it('waits on a prefix, then completes the sequence', () => {
		expect(matchToken(scopes, [], 'g', false)).toEqual({ kind: 'pending' });
		expect(matchToken(scopes, ['g'], 'i', false)).toEqual({ kind: 'run', binding: jump });
		expect(matchToken(scopes, ['g'], 'z', false)).toEqual({ kind: 'none' });
	});

	it('never hijacks typing unless a binding opts in', () => {
		expect(matchToken(scopes, [], 'j', true)).toEqual({ kind: 'none' });
		expect(matchToken(scopes, [], 'g', true)).toEqual({ kind: 'none' });
		expect(matchToken(scopes, [], 'Escape', true)).toEqual({ kind: 'run', binding: blur });
	});

	it('prefers the newest scope and skips disabled or display-only bindings', () => {
		const page_next = binding(['j']);
		const off = binding(['k'], { when: () => false });
		const shown = binding(['mod+k'], { display_only: true });
		const stack = liveScopes(
			[
				{ id: 1, bindings: [next] },
				{ id: 2, bindings: [page_next, off, shown] }
			],
			false
		);
		expect(matchToken(stack, [], 'j', false)).toEqual({ kind: 'run', binding: page_next });
		expect(matchToken(stack, [], 'k', false)).toEqual({ kind: 'none' });
		expect(matchToken(stack, [], 'mod+k', false)).toEqual({ kind: 'none' });
	});
});

describe('liveScopes', () => {
	const page_scope: HotkeyScope = { id: 1, bindings: [binding(['j'])] };
	const dialog_scope: HotkeyScope = { id: 2, bindings: [binding(['d'])], modal: true };

	it('lets an open dialog own the keyboard', () => {
		expect(liveScopes([page_scope, dialog_scope], true)).toEqual([dialog_scope]);
		expect(liveScopes([dialog_scope, page_scope], false)).toEqual([dialog_scope]);
	});

	it('goes quiet while a dialog or menu it does not own is open', () => {
		expect(liveScopes([page_scope], true)).toEqual([]);
		expect(liveScopes([page_scope], false)).toEqual([page_scope]);
	});
});

describe('overlayGroups', () => {
	it('groups live bindings in a fixed order, newest first, without duplicates', () => {
		const global_next = binding(['j'], { label: 'global next', group: 'Lists' });
		const page_next = binding(['j'], { label: 'page next', group: 'Lists' });
		const help = binding(['?'], { label: 'help' });
		const hidden = binding(['Escape'], { hidden: true });
		const groups = overlayGroups(
			[
				{ id: 1, bindings: [help, global_next, hidden] },
				{ id: 2, bindings: [page_next] }
			],
			false
		);
		expect(groups.map((entry) => entry.group)).toEqual(['General', 'Lists']);
		expect(groups[1]!.bindings.map((entry) => entry.label)).toEqual(['page next']);
		expect(groups[0]!.bindings.map((entry) => entry.label)).toEqual(['help']);
	});
});

describe('describeSequence', () => {
	it('renders keys the way the overlay shows them', () => {
		expect(describeSequence('g i', true)).toEqual(['g', 'i']);
		expect(describeSequence('mod+k', true)).toEqual(['⌘k']);
		expect(describeSequence('mod+k', false)).toEqual(['Ctrl+k']);
		expect(describeSequence('ArrowDown', true)).toEqual(['↓']);
		expect(describeSequence('Escape', true)).toEqual(['esc']);
		expect(describeSequence('?', true)).toEqual(['?']);
	});
});

describe('isTypingTarget', () => {
	function fake(tag: string, type?: string, editable = false) {
		const element = {
			tagName: tag,
			type,
			isContentEditable: editable,
			closest: (selector: string) => {
				const fields = ['INPUT', 'TEXTAREA', 'SELECT'];
				return selector.includes('input') && fields.includes(tag) ? element : null;
			}
		};
		return element as unknown as EventTarget;
	}

	it('treats text fields as typing and buttons or checkboxes as not', () => {
		expect(isTypingTarget(fake('INPUT', 'search'))).toBe(true);
		expect(isTypingTarget(fake('INPUT'))).toBe(true);
		expect(isTypingTarget(fake('TEXTAREA'))).toBe(true);
		expect(isTypingTarget(fake('DIV', undefined, true))).toBe(true);
		expect(isTypingTarget(fake('INPUT', 'checkbox'))).toBe(false);
		expect(isTypingTarget(fake('BUTTON'))).toBe(false);
		expect(isTypingTarget(null)).toBe(false);
	});
});
