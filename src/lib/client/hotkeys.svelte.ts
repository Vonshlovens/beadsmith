/**
 * The live shortcut registry. Components declare their
 * keys with `useHotkeys`; `hotkey-host.svelte` listens once on the window and
 * the `?` overlay lists whatever is live. Matching rules are in `hotkeys.ts`.
 */
import { untrack } from 'svelte';
import type { HotkeyBinding, HotkeyScope } from './hotkeys.js';

let next_id = 1;
/** Scopes that must outrank the host's global map (a page that rebinds `/`, `[`). */
let next_front_id = 1_000_000;
let scopes = $state.raw<HotkeyScope[]>([]);

/** Every registered scope, oldest first. */
export function hotkeyScopes(): readonly HotkeyScope[] {
	return scopes;
}

// Both run inside effects; reading `scopes` untracked keeps a registration
// from depending on the registry it writes.
function upsert(scope: HotkeyScope) {
	const others = untrack(() => scopes).filter((existing) => existing.id !== scope.id);
	scopes = [...others, scope].sort((left, right) => left.id - right.id);
}

function remove(id: number) {
	scopes = untrack(() => scopes).filter((scope) => scope.id !== id);
}

/**
 * Register a component's shortcuts for as long as it is mounted. Call during
 * component init. The getter is re-read when the state it touches changes,
 * and the scope keeps its place in the stack.
 *
 * @param get_bindings - The bindings; may read reactive state.
 * @param options.modal - While true, only this scope answers (an open dialog).
 * @param options.front - Rank above every ordinary scope, the host's global map
 *   included, so this scope may rebind a global key (`/`, `[`) while it is mounted.
 */
export function useHotkeys(
	get_bindings: () => readonly HotkeyBinding[],
	options: { modal?: () => boolean; front?: boolean } = {}
): void {
	const id = options.front ? next_front_id++ : next_id++;
	$effect(() => {
		upsert({ id, bindings: get_bindings(), modal: options.modal?.() ?? false });
	});
	$effect(() => {
		return () => remove(id);
	});
}

let pending_keys = $state.raw<readonly string[]>([]);

/** Tokens of the chord waiting for its next key (empty when none). */
export function pendingKeys(): readonly string[] {
	return pending_keys;
}

/** The host publishes its pending chord here so a mode chip can show it. */
export function setPendingKeys(keys: readonly string[]): void {
	pending_keys = keys;
}
