/**
 * Keyboard shortcuts: one matcher for the whole app.
 *
 * A binding names one or more key sequences. A sequence is space-separated
 * tokens, so `g i` is "g, then i". A token is the `KeyboardEvent.key` of a
 * printable character as typed (`?`, `/`, `G`), or a named key (`Escape`,
 * `ArrowDown`, `Enter`) with an optional `shift+` prefix. `mod+` stands for
 * Ctrl or ⌘ and `alt+` for Option/Alt on any token.
 *
 * Bindings live in scopes. The host (hotkey-host.svelte) asks the newest
 * scope first, so a page or dialog overrides the global map. A modal scope
 * hides everything registered before it. Nothing fires while focus is in a
 * field unless the binding opts in, and nothing but a modal scope's own
 * bindings fires while a dialog or menu is open.
 */

export type HotkeyGroup = 'General' | 'Go to' | 'Lists' | 'Issue' | 'Board' | 'Agent' | 'Todo list';

export interface HotkeyBinding {
	/** Alternatives; each is a space-separated sequence, e.g. `['j', 'ArrowDown']` or `['g i']`. */
	keys: readonly string[];
	/** What the overlay says it does. */
	label: string;
	group: HotkeyGroup;
	/** Return `false` to let the key through (nothing to act on). */
	run?: (event: KeyboardEvent) => void | boolean;
	/** Fire even while focus is in an input or textarea. */
	in_fields?: boolean;
	/** Listed in the overlay only; another handler owns the key (e.g. ⌘K). */
	display_only?: boolean;
	/** Never listed in the overlay. */
	hidden?: boolean;
	/** Bindings for this group are only live while this returns true. */
	when?: () => boolean;
}

export interface HotkeyScope {
	id: number;
	bindings: readonly HotkeyBinding[];
	/** Hide every scope below this one (a dialog that owns the keyboard). */
	modal?: boolean;
}

/** How long a prefix like `g` waits for its second key. */
export const SEQUENCE_TIMEOUT_MS = 1200;

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS']);

/** The subset of a keyboard event the matcher reads. */
export interface KeyLike {
	key: string;
	shiftKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	isComposing?: boolean;
}

/**
 * Normalize an event to a token. Printable keys keep their typed character,
 * so Shift is already folded in (`?`, `G`); named keys spell Shift out.
 *
 * @param event - The keydown.
 * @returns The token, or null for a lone modifier or an IME composition.
 */
export function eventToken(event: KeyLike): string | null {
	if (event.isComposing || MODIFIER_KEYS.has(event.key) || event.key === 'Dead') {
		return null;
	}
	const printable = event.key.length === 1;
	let token = printable && event.key !== ' ' ? event.key : event.key === ' ' ? 'Space' : event.key;
	if (!printable && event.shiftKey) {
		token = `shift+${token}`;
	}
	if (event.altKey) {
		token = `alt+${token}`;
	}
	if (event.ctrlKey || event.metaKey) {
		token = `mod+${printable ? event.key.toLowerCase() : token}`;
	}
	return token;
}

/**
 * Split a binding sequence into tokens.
 *
 * @param sequence - e.g. `g i`.
 */
export function sequenceTokens(sequence: string): string[] {
	return sequence.split(' ').filter((token) => token.length > 0);
}

const NON_TEXT_INPUTS = new Set([
	'checkbox',
	'radio',
	'button',
	'submit',
	'reset',
	'range',
	'color'
]);

/**
 * Focus is somewhere the reader types, so a letter must stay a letter.
 * Written against the element shape, not DOM globals, so it runs in tests.
 *
 * @param target - The keydown's target.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
	const element = target as {
		closest?: (selector: string) => (Element & { type?: string }) | null;
		isContentEditable?: boolean;
	} | null;
	if (element === null || typeof element.closest !== 'function') {
		return false;
	}
	if (element.isContentEditable === true) {
		return true;
	}
	const field = element.closest(
		'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
	);
	if (field === null) {
		return false;
	}
	if (field.tagName === 'INPUT') {
		return !NON_TEXT_INPUTS.has((field.type ?? 'text').toLowerCase());
	}
	return true;
}

/**
 * Scopes that may answer right now, newest first. An active modal scope (an
 * open dialog that owns the keyboard) answers alone. While some other dialog
 * or menu is open, nothing answers.
 *
 * @param scopes - Every registered scope, oldest first.
 * @param overlay_open - A dialog, alertdialog, or menu is open.
 */
export function liveScopes(scopes: readonly HotkeyScope[], overlay_open: boolean): HotkeyScope[] {
	const newest_first = [...scopes].reverse();
	const modal = newest_first.find((scope) => scope.modal === true);
	if (modal !== undefined) {
		return [modal];
	}
	return overlay_open ? [] : newest_first;
}

/** Bindings worth listing, grouped in a stable order, newest scope winning per key. */
export function overlayGroups(
	scopes: readonly HotkeyScope[],
	overlay_open: boolean
): { group: HotkeyGroup; bindings: HotkeyBinding[] }[] {
	const order: HotkeyGroup[] = [
		'General',
		'Go to',
		'Lists',
		'Issue',
		'Board',
		'Agent',
		'Todo list'
	];
	const seen = new Set<string>();
	const picked: HotkeyBinding[] = [];
	for (const scope of liveScopes(scopes, overlay_open)) {
		for (const binding of scope.bindings) {
			if (binding.hidden || (binding.when !== undefined && !binding.when())) {
				continue;
			}
			const key = binding.keys.join('|');
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			picked.push(binding);
		}
	}
	return order
		.map((group) => ({ group, bindings: picked.filter((binding) => binding.group === group) }))
		.filter((entry) => entry.bindings.length > 0);
}

export type MatchResult =
	{ kind: 'run'; binding: HotkeyBinding } | { kind: 'pending' } | { kind: 'none' };

/**
 * Match one token against the live bindings, given a pending prefix.
 *
 * @param scopes - Live scopes, newest first (from `liveScopes`).
 * @param pending - Tokens typed so far in an unfinished sequence.
 * @param token - This key's token.
 * @param typing - Focus is in a field.
 */
export function matchToken(
	scopes: readonly HotkeyScope[],
	pending: readonly string[],
	token: string,
	typing: boolean
): MatchResult {
	const typed = [...pending, token];
	let prefix = false;
	for (const scope of scopes) {
		for (const binding of scope.bindings) {
			if (binding.display_only || binding.run === undefined) {
				continue;
			}
			if (typing && !binding.in_fields) {
				continue;
			}
			if (binding.when !== undefined && !binding.when()) {
				continue;
			}
			for (const sequence of binding.keys) {
				const tokens = sequenceTokens(sequence);
				if (tokens.length < typed.length) {
					continue;
				}
				const head_matches = typed.every((part, index) => tokens[index] === part);
				if (!head_matches) {
					continue;
				}
				if (tokens.length === typed.length) {
					return { kind: 'run', binding };
				}
				prefix = true;
			}
		}
	}
	return prefix ? { kind: 'pending' } : { kind: 'none' };
}

/**
 * Human label for one sequence, for the overlay and tooltips.
 *
 * @param sequence - e.g. `g i`, `mod+k`, `ArrowDown`.
 * @param mac - Show ⌘ rather than Ctrl.
 */
export function describeSequence(sequence: string, mac: boolean): string[] {
	const names: Record<string, string> = {
		ArrowDown: '↓',
		ArrowUp: '↑',
		ArrowLeft: '←',
		ArrowRight: '→',
		Enter: '⏎',
		Escape: 'esc',
		Space: 'space',
		Backspace: '⌫',
		Home: 'home',
		End: 'end'
	};
	return sequenceTokens(sequence).map((token) => {
		const parts = token.split('+');
		const key = parts.pop() ?? token;
		const mods = parts.map((mod) => {
			if (mod === 'mod') return mac ? '⌘' : 'Ctrl+';
			if (mod === 'alt') return mac ? '⌥' : 'Alt+';
			if (mod === 'shift') return '⇧';
			return mod;
		});
		const shown =
			names[key] ??
			(key.length === 1 ? (key.toLowerCase() === key ? key : `⇧${key.toLowerCase()}`) : key);
		return `${mods.join('')}${shown}`;
	});
}
