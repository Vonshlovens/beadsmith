<script lang="ts">
	/**
	 * Global overlay host. The palette console lives in
	 * `first-mate-console.svelte`; this file owns ⌘K, the palette dialog, the
	 * File/Tackle dialogs that must outlive it, the issue agent dialog, and the
	 * keyboard host (`?` overlay and `g` jumps), so the shell mounts one thing.
	 */
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import AgentDialog from '$lib/components/agent-dialog.svelte';
	import FileIssueDialog from '$lib/components/file-issue-dialog.svelte';
	import FirstMateConsole from '$lib/components/first-mate-console.svelte';
	import HotkeyHost from '$lib/components/hotkey-host.svelte';
	import TackleIssueDialog from '$lib/components/tackle-issue-dialog.svelte';
	import { FIRST_MATE_PATH, firstMatePageHref, isFirstMateHotkey } from '$lib/client/first-mate';
	import type { FirstMateView } from '$lib/client/first-mate';
	import { app_state } from '$lib/client/stores.svelte';

	const on_auth = $derived(page.url.pathname === '/auth');
	const on_page = $derived(page.url.pathname === FIRST_MATE_PATH);

	let mate_query = $state('');
	let mate_view = $state<FirstMateView | null>(null);
	const open_href = $derived(firstMatePageHref(mate_query, mate_view));

	let file_open = $state(false);
	let file_project_id = $state('');
	let tackle_open = $state(false);
	let tackle_project_id = $state('');
	let tackle_issue_id = $state('');
	let tackle_issue_title = $state('');

	function onOpenChange(next: boolean) {
		app_state.first_mate_open = next;
	}

	function closePalette() {
		app_state.closeFirstMate();
	}

	async function onNavigate(href: string) {
		closePalette();
		await goto(href);
	}

	function onFile(project_id: string) {
		file_project_id = project_id;
		closePalette();
		file_open = true;
	}

	function onTackle(target: { project_id: string; issue_id: string; issue_title: string }) {
		tackle_project_id = target.project_id;
		tackle_issue_id = target.issue_id;
		tackle_issue_title = target.issue_title;
		closePalette();
		tackle_open = true;
	}

	function onStateChange(state: { query: string; view: FirstMateView | null }) {
		mate_query = state.query;
		mate_view = state.view;
	}

	async function openPage(event: MouseEvent) {
		event.preventDefault();
		const href = open_href;
		closePalette();
		await goto(href);
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (on_page || on_auth) {
			return;
		}
		if (!isFirstMateHotkey(event)) {
			return;
		}
		event.preventDefault();
		if (app_state.first_mate_open) {
			closePalette();
			return;
		}
		app_state.openFirstMate();
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if !on_auth}
	<HotkeyHost />
	<AgentDialog />
	<Dialog.Root open={app_state.first_mate_open} {onOpenChange}>
		<Dialog.Content class="ui-dialog ui-dialog-palette" showCloseButton={false}>
			{#if app_state.first_mate_open}
				<FirstMateConsole
					variant="palette"
					active={app_state.first_mate_open}
					{title}
					{onNavigate}
					{onFile}
					{onTackle}
					{onStateChange}
				/>
			{/if}
		</Dialog.Content>
	</Dialog.Root>
{/if}

{#snippet title(heading: string)}
	<Dialog.Title class="lbl">{heading}</Dialog.Title>
	<a class="open-page" href={open_href} onclick={openPage}>Open page</a>
{/snippet}

{#if file_project_id}
	<FileIssueDialog project_id={file_project_id} bind:open={file_open} />
{/if}
{#if tackle_issue_id && tackle_project_id}
	<TackleIssueDialog
		project_id={tackle_project_id}
		issue_id={tackle_issue_id}
		issue_title={tackle_issue_title}
		bind:open={tackle_open}
		show_trigger={false}
	/>
{/if}

<style>
	.open-page {
		font-size: var(--t-xs);
		color: var(--tx-dim);
		text-decoration: none;
	}
	.open-page:hover {
		color: var(--tx-hi);
	}
</style>
