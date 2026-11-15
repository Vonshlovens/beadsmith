<script lang="ts">
	/**
	 * Save the project page's current filters as a new saved view (ADR-0025
	 * rule 1). It writes the same record First Mate's `define_view` writes,
	 * through `/api/views`, so a view saved here and one First Mate made
	 * behave alike. The form shows what will be captured in the words the
	 * Views pages use, so the reader knows before saving. The view is private
	 * to its owner until they publish it.
	 */
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import BookmarkSimpleIcon from 'phosphor-svelte/lib/BookmarkSimpleIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { api, errorMessage } from '#lib/client/api.js';
	import { tip } from '#lib/client/tooltip.js';
	import { describeViewSpec, slugFromName } from '#lib/client/views.js';
	import {
		GROWN_DESCRIPTION_MAX,
		GROWN_NAME_MAX,
		GROWN_SLUG_MAX,
		GROWN_SLUG_PATTERN
	} from '#lib/grown.js';
	import type { ViewSpecShape, ViewSummary } from '#lib/views.js';

	interface Props {
		open: boolean;
		spec: ViewSpecShape;
		project_name: string;
		/** Called with the new view once it is saved. */
		onsaved: (view: ViewSummary) => void;
	}

	let { open = $bindable(false), spec, project_name, onsaved }: Props = $props();

	let name = $state('');
	let slug = $state('');
	let slug_touched = $state(false);
	let description = $state('');
	let tried = $state(false);
	let submitting = $state(false);
	let server_error = $state<string | null>(null);

	// Each opening starts a fresh form.
	$effect(() => {
		if (open) {
			name = '';
			slug = '';
			slug_touched = false;
			description = '';
			tried = false;
			server_error = null;
		}
	});

	const facts = $derived(describeViewSpec(spec, () => project_name));
	const effective_slug = $derived(slug_touched ? slug.trim() : slugFromName(name));
	const name_error = $derived(
		name.trim().length === 0
			? 'Give the view a name.'
			: name.trim().length > GROWN_NAME_MAX
				? `At most ${GROWN_NAME_MAX} characters.`
				: undefined
	);
	const slug_error = $derived(
		effective_slug.length === 0
			? 'Give it an address: letters and digits, like "blocked-on-review".'
			: effective_slug.length > GROWN_SLUG_MAX || !GROWN_SLUG_PATTERN.test(effective_slug)
				? `Lowercase letters and digits in dash-separated words, at most ${GROWN_SLUG_MAX}.`
				: undefined
	);

	async function save(event: SubmitEvent) {
		event.preventDefault();
		tried = true;
		if (name_error || slug_error || submitting) return;
		submitting = true;
		server_error = null;
		try {
			const { view } = await api.createView({
				slug: effective_slug,
				name: name.trim(),
				description: description.trim() || undefined,
				spec
			});
			open = false;
			toast.success(`Saved ${view.name}`, {
				description: 'Only you see it until you publish it.',
				action: { label: 'Open', onClick: () => void goto(`/views/${view.slug}`) }
			});
			onsaved(view);
		} catch (error) {
			// Shown in the form, which keeps everything typed (a taken slug, say).
			server_error = errorMessage(error);
		} finally {
			submitting = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="ui-dialog save-view-dialog" showCloseButton={false}>
		<form class="form" onsubmit={save} novalidate>
			<div class="modal-hd">
				<BookmarkSimpleIcon size={15} aria-hidden="true" />
				<Dialog.Title class="hd-title">Save view</Dialog.Title>
				<span class="ti">{project_name}</span>
				<span class="spacer"></span>
				<button
					class="btn btn-sm btn-ghost btn-icon"
					type="button"
					aria-label="Close"
					{@attach tip('Close (esc)')}
					onclick={() => (open = false)}
				>
					<XIcon size={14} />
				</button>
			</div>

			<div class="modal-bd">
				<Dialog.Description class="facts">
					{#each facts as fact (fact)}<span>{fact}</span>{/each}
				</Dialog.Description>

				<label class="field mt-4">
					<span class="lbl">Name</span>
					<!-- svelte-ignore a11y_autofocus -->
					<input
						class="input"
						class:is-invalid={tried && name_error !== undefined}
						type="text"
						autocomplete="off"
						autofocus
						maxlength={GROWN_NAME_MAX}
						bind:value={name}
						aria-invalid={tried && name_error !== undefined}
						aria-describedby={tried && name_error ? 'sv-name-err' : undefined}
					/>
					{#if tried && name_error}<span class="err" id="sv-name-err">{name_error}</span>{/if}
				</label>

				<label class="field mt-3">
					<span class="lbl">Address</span>
					<span class="slug">
						<span class="faint mono-num">/views/</span>
						<input
							class="input mono-num"
							class:is-invalid={tried && slug_error !== undefined}
							type="text"
							autocomplete="off"
							spellcheck="false"
							maxlength={GROWN_SLUG_MAX}
							value={effective_slug}
							oninput={(event) => {
								slug_touched = true;
								slug = event.currentTarget.value;
							}}
							aria-invalid={tried && slug_error !== undefined}
							aria-describedby={tried && slug_error ? 'sv-slug-err' : undefined}
						/>
					</span>
					{#if tried && slug_error}<span class="err" id="sv-slug-err">{slug_error}</span>{/if}
				</label>

				<label class="field mt-3">
					<span class="lbl">Description <span class="faint">(optional)</span></span>
					<textarea
						class="input"
						rows="2"
						maxlength={GROWN_DESCRIPTION_MAX}
						bind:value={description}></textarea>
				</label>

				{#if server_error}
					<p class="banner banner-err mt-4" role="alert">{server_error}</p>
				{/if}
			</div>

			<div class="modal-ft">
				<span class="why faint">Only you see it until you publish it.</span>
				<span class="spacer"></span>
				<button class="btn btn-sm" type="button" onclick={() => (open = false)}>Cancel</button>
				<button class="btn btn-sm btn-primary" type="submit" disabled={submitting}>
					{submitting ? 'Saving…' : 'Save view'}
				</button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<style>
	:global(.save-view-dialog) {
		--dialog-w: 480px;
	}
	.form {
		display: contents;
	}
	.modal-hd :global(svg) {
		color: var(--tx-dim);
		flex: none;
	}
	.modal-hd :global(.hd-title) {
		font-size: var(--t-sm);
		font-weight: 600;
		color: var(--tx-hi);
		white-space: nowrap;
	}
	.ti {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--tx-mid);
		font-size: var(--t-sm);
	}
	.spacer {
		flex: 1;
	}
	:global(.save-view-dialog .facts) {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1) var(--s-3);
		margin: 0;
		font-size: var(--t-xs);
		color: var(--tx-mid);
	}
	.slug {
		display: flex;
		align-items: center;
		gap: var(--s-1);
	}
	.slug .input {
		flex: 1;
		min-width: 0;
	}
	.err {
		font-size: var(--t-xs);
		color: var(--danger-tx);
	}
	.why {
		font-size: var(--t-xs);
		min-width: 0;
	}
	.banner {
		margin-bottom: 0;
	}
</style>
