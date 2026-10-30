<script lang="ts">
	/**
	 * The one window key listener. Owns the global map
	 * (`?`, `/`, `[`, `g`-jumps), feeds every key to the registry matcher, and
	 * renders the `?` overlay and the "g …" hint while a jump waits for its
	 * second key. Pages and dialogs add their own keys with `useHotkeys`.
	 */
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import XIcon from '@lucide/svelte/icons/x';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import {
		describeSequence,
		eventToken,
		isTypingTarget,
		liveScopes,
		matchToken,
		overlayGroups,
		SEQUENCE_TIMEOUT_MS,
		type HotkeyBinding
	} from '$lib/client/hotkeys';
	import { hotkeyScopes, setPendingKeys, useHotkeys } from '$lib/client/hotkeys.svelte';
	import {
		issueViewStorageKey,
		parseStoredIssueView,
		projectIssuesHref
	} from '$lib/client/issue-view';
	import { currentProject, currentViewer, projectList } from '$lib/client/projects.svelte';
	import { app_state } from '$lib/client/stores.svelte';

	const mac = $derived(
		typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
	);

	let pending = $state<string[]>([]);
	let pending_timer: ReturnType<typeof setTimeout> | undefined;
	/** Re-read the registry when the overlay opens, not on every key. */
	let overlay_tick = $state(0);

	const groups = $derived.by(() => {
		void overlay_tick;
		// The overlay is itself a dialog: list what the page would answer.
		return overlayGroups(
			hotkeyScopes().filter((scope) => !scope.modal),
			false
		);
	});

	/** Remember the last project route so `g i` works from /ready or /missions. */
	$effect(() => {
		const id = page.params.id;
		if (id) {
			app_state.last_project_id = id;
		}
	});

	function jumpProject(): string | null {
		const id = currentProject()?.id ?? app_state.last_project_id ?? projectList()[0]?.id ?? null;
		return id;
	}

	function issuesHref(id: string): string {
		let stored: string | null = null;
		try {
			stored = window.localStorage.getItem(issueViewStorageKey(id));
		} catch {
			stored = null;
		}
		const remembered = parseStoredIssueView(stored);
		return projectIssuesHref(id, remembered === 'list' ? 'list' : 'parade');
	}

	/** Focus the page's own filter box first, then the top bar search. */
	function focusSearch(): boolean {
		const candidates = [
			...document.querySelectorAll<HTMLInputElement>('main [data-hotkey="search"]'),
			...document.querySelectorAll<HTMLInputElement>('[data-hotkey="search"]')
		];
		const visible = candidates.find((input) => input.offsetParent !== null);
		if (visible === undefined) {
			app_state.openFirstMate();
			return true;
		}
		visible.focus();
		visible.select();
		return true;
	}

	function go(href: string) {
		void goto(href);
	}

	const GLOBAL: HotkeyBinding[] = [
		{
			keys: ['?'],
			label: 'Show keyboard shortcuts',
			group: 'General',
			run: () => {
				overlay_tick += 1;
				app_state.shortcuts_open = true;
			}
		},
		{ keys: ['/'], label: 'Search', group: 'General', run: focusSearch },
		{ keys: ['mod+k'], label: 'First Mate commands', group: 'General', display_only: true },
		{
			keys: ['['],
			label: 'Collapse or open the navigation rail',
			group: 'General',
			run: () => app_state.toggleRailForViewport()
		},
		{
			keys: ['Escape'],
			label: 'Leave a field',
			group: 'General',
			in_fields: true,
			hidden: true,
			run: (event) => {
				if (!isTypingTarget(event.target)) {
					return false;
				}
				(event.target as HTMLElement).blur();
			}
		},
		{ keys: ['g p'], label: 'Projects', group: 'Go to', run: () => go('/') },
		{
			keys: ['g i'],
			label: 'Issues in this project',
			group: 'Go to',
			run: () => {
				const id = jumpProject();
				go(id === null ? '/' : issuesHref(id));
			}
		},
		{
			keys: ['g b'],
			label: 'Board',
			group: 'Go to',
			run: () => {
				const id = jumpProject();
				go(id === null ? '/' : projectIssuesHref(id, 'board'));
			}
		},
		{ keys: ['g r'], label: 'Ready', group: 'Go to', run: () => go('/ready') },
		{ keys: ['g f'], label: 'First Mate', group: 'Go to', run: () => go('/first-mate') },
		{ keys: ['g m'], label: 'Missions', group: 'Go to', run: () => go('/missions') },
		{ keys: ['g a'], label: 'Activity log', group: 'Go to', run: () => go('/activity') },
		{ keys: ['g c'], label: 'Console', group: 'Go to', run: () => go('/console') },
		{
			keys: ['g t'],
			label: 'Todos',
			group: 'Go to',
			when: () => currentViewer()?.role === 'admin',
			run: () => go('/todos')
		}
	];

	useHotkeys(() => GLOBAL);

	function overlayOpen(): boolean {
		return document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null;
	}

	$effect(() => setPendingKeys(pending));

	function clearPending() {
		pending = [];
		if (pending_timer !== undefined) {
			clearTimeout(pending_timer);
			pending_timer = undefined;
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.defaultPrevented) {
			return;
		}
		const token = eventToken(event);
		if (token === null) {
			return;
		}
		if (pending.length > 0 && token === 'Escape') {
			// Esc only drops the armed chord; it does not also cancel a mode.
			clearPending();
			event.preventDefault();
			return;
		}
		const scopes = liveScopes(hotkeyScopes(), overlayOpen());
		const typing = isTypingTarget(event.target);
		let result = matchToken(scopes, pending, token, typing);
		if (result.kind === 'none' && pending.length > 0) {
			clearPending();
			result = matchToken(scopes, [], token, typing);
		}
		if (result.kind === 'pending') {
			event.preventDefault();
			pending = [...pending, token];
			if (pending_timer !== undefined) {
				clearTimeout(pending_timer);
			}
			pending_timer = setTimeout(clearPending, SEQUENCE_TIMEOUT_MS);
			return;
		}
		clearPending();
		if (result.kind === 'run' && result.binding.run?.(event) !== false) {
			event.preventDefault();
		}
	}

	/** Second keys the live scopes would accept after the pending prefix. */
	const pending_hints = $derived.by(() => {
		if (pending.length === 0) {
			return [];
		}
		const prefix = `${pending.join(' ')} `;
		const hints: { key: string; label: string }[] = [];
		for (const scope of liveScopes(hotkeyScopes(), false)) {
			for (const binding of scope.bindings) {
				if (binding.display_only || binding.run === undefined) continue;
				if (binding.when !== undefined && !binding.when()) continue;
				const sequence = binding.keys.find((keys) => keys.startsWith(prefix));
				const key = sequence?.slice(prefix.length);
				if (key !== undefined && !hints.some((hint) => hint.key === key)) {
					hints.push({ key, label: binding.label });
				}
			}
		}
		return hints;
	});
</script>

<svelte:window onkeydown={onKeydown} />

{#if pending.length > 0}
	<div class="seq" role="status" aria-live="polite">
		<span class="kbd">{pending.join(' ')}</span>
		{#each pending_hints as hint (hint.key)}
			<span class="seq-hint"><b>{hint.key}</b> {hint.label}</span>
		{/each}
	</div>
{/if}

<Dialog.Root bind:open={app_state.shortcuts_open}>
	<Dialog.Content class="ui-dialog keys-dialog" showCloseButton={false}>
		<div class="modal-hd">
			<Dialog.Title class="lbl">Keyboard shortcuts</Dialog.Title>
			<span class="spacer"></span>
			<span class="xs faint">Paused while you type</span>
			<button
				class="btn btn-sm btn-ghost btn-icon"
				type="button"
				aria-label="Close"
				title="Close (esc)"
				onclick={() => (app_state.shortcuts_open = false)}
			>
				<XIcon size={14} strokeWidth={1.4} />
			</button>
		</div>
		<div class="modal-bd keys-grid">
			{#each groups as entry (entry.group)}
				<section class="keys-group" aria-label={entry.group}>
					<h2 class="lbl">{entry.group}</h2>
					<dl>
						{#each entry.bindings as binding (binding.keys.join('|'))}
							<div class="keys-row">
								<dt>
									{#each binding.keys as sequence, index (sequence)}
										{#if index > 0}<span class="faint">/</span>{/if}
										{#each describeSequence(sequence, mac) as part, at (at)}
											<kbd class="kbd">{part}</kbd>
										{/each}
									{/each}
								</dt>
								<dd>{binding.label}</dd>
							</div>
						{/each}
					</dl>
				</section>
			{/each}
		</div>
	</Dialog.Content>
</Dialog.Root>

<style>
	.seq {
		position: fixed;
		left: 50%;
		bottom: var(--s-5);
		transform: translateX(-50%);
		z-index: 70;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 4px var(--s-3);
		max-width: min(640px, calc(100vw - 32px));
		padding: 8px 12px;
		background: var(--s3);
		border: 1px solid var(--line-2);
		border-radius: var(--r-2);
		box-shadow: var(--shadow-tip);
		font-size: var(--t-xs);
		color: var(--tx-mid);
	}
	.seq-hint b {
		color: var(--tx-hi);
		font-weight: 600;
	}
	:global(.keys-dialog) {
		--dialog-w: 760px;
	}
	.keys-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: var(--s-4) var(--s-5);
	}
	.keys-group h2 {
		margin-bottom: var(--s-2);
	}
	.keys-group dl {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.keys-row {
		display: flex;
		align-items: baseline;
		gap: var(--s-3);
		font-size: var(--t-xs);
	}
	.keys-row dt {
		flex: none;
		min-width: 64px;
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		align-items: center;
	}
	.keys-row dd {
		margin: 0;
		color: var(--tx);
	}
	kbd.kbd {
		font-family: var(--font);
		font-size: 10px;
	}
</style>
