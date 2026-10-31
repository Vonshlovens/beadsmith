<script lang="ts" module>
	/** True once any markdown body has mounted, i.e. the app has hydrated. */
	let hydrated = false;
</script>

<script lang="ts">
	/**
	 * Long markdown bodies get the prose exception: system sans at
	 * 13.5px/1.6. Everything else in the product stays mono.
	 */
	import { renderMarkdown, renderPlain } from '$lib/client/markdown';

	interface Props {
		source: string | undefined;
		class?: string;
		/** Text shown when the field is empty. */
		placeholder?: string;
	}

	let { source, class: class_name = '', placeholder = 'Nothing written yet.' }: Props = $props();

	/*
	 * Svelte does not repair `{@html}` mismatches while hydrating, so the
	 * first client render must match the server's plain-text stand-in or the
	 * raw markdown stays on screen for good. Render the real thing once this
	 * component has mounted; after the first hydration, later mounts (client
	 * navigations) skip the stand-in.
	 */
	let mounted = $state(hydrated);
	$effect(() => {
		mounted = true;
		hydrated = true;
	});

	const html = $derived(
		!source || !source.trim() ? '' : mounted ? renderMarkdown(source) : renderPlain(source)
	);
</script>

{#if html}
	<div class="prose {class_name}">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised by DOMPurify -->
		{@html html}
	</div>
{:else}
	<p class="hint">{placeholder}</p>
{/if}
