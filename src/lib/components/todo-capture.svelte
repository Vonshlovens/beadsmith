<script lang="ts">
	/**
	 * agenda.dev-style capture field: "what's on your agenda?". The line is
	 * parsed locally on every keystroke (`$lib/todos/parse`) and the result
	 * shows as chips before anything is created, so the parse is never a
	 * surprise. Enter or ⌘/Ctrl+Enter submits; Esc clears, then leaves.
	 */
	import { flip } from 'svelte/animate';
	import { scale } from 'svelte/transition';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import PriorityChip from '$lib/components/priority-chip.svelte';
	import { dur, expand } from '$lib/client/motion';
	import { addDays, dueLabel, nextWeekday, toDateOnly } from '$lib/todos/dates';
	import { parseCapture, type ParsedCapture } from '$lib/todos/parse';

	interface Props {
		now: Date;
		busy?: boolean;
		onsubmit: (parsed: ParsedCapture) => void | Promise<void>;
		/** Bound by the page so `n` and `/` can focus the field. */
		input?: HTMLInputElement | null;
	}

	let { now, busy = false, onsubmit, input = $bindable(null) }: Props = $props();

	let text = $state('');
	let picked_date = $state<number | null>(null);
	let picked_priority = $state<number | null>(null);
	let panel_el = $state<HTMLElement | null>(null);
	const parsed = $derived(parseCapture(text, now));
	const can_submit = $derived(parsed.title !== '' && !busy);

	/** Quick dates, offered only while the line names none. */
	const suggestions = $derived([
		{ label: 'Today', value: toDateOnly(now) as string | null },
		{ label: 'Tomorrow', value: toDateOnly(addDays(now, 1)) as string | null },
		{ label: 'Next week', value: toDateOnly(nextWeekday(now, 1)) as string | null },
		{ label: 'No date', value: null as string | null }
	]);
	const show_dates = $derived(parsed.due_at === null);
	const priority = $derived(picked_priority ?? parsed.priority);

	/** The parse with the chips' choices applied. */
	const final = $derived<ParsedCapture>({
		...parsed,
		priority,
		due_at: parsed.due_at ?? (picked_date === null ? null : suggestions[picked_date].value)
	});

	async function submit() {
		if (!can_submit) {
			return;
		}
		const snapshot = final;
		await onsubmit(snapshot);
		text = '';
		picked_date = null;
		picked_priority = null;
		input?.focus({ preventScroll: true });
	}

	function stepPriority(delta: number) {
		picked_priority = Math.max(0, Math.min(4, priority + delta));
	}

	function onPanelKeydown(event: KeyboardEvent) {
		if (event.isComposing) {
			return;
		}
		if (show_dates && /^[1-4]$/.test(event.key)) {
			event.preventDefault();
			picked_date = picked_date === Number(event.key) - 1 ? null : Number(event.key) - 1;
		} else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault();
			stepPriority(event.key === 'ArrowLeft' ? -1 : 1);
		} else if (
			event.key === 'Enter' &&
			// Plain Enter on a chip button presses that chip; anywhere else it adds.
			(event.metaKey || event.ctrlKey || event.target === event.currentTarget)
		) {
			event.preventDefault();
			void submit();
		} else if (event.key === 'Escape' || event.key === 'ArrowUp') {
			event.preventDefault();
			event.stopPropagation();
			input?.focus({ preventScroll: true });
		} else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
			// The panel owns the keyboard: other letters must not reach the page's hotkeys.
			event.preventDefault();
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.isComposing) {
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			void submit();
		} else if (
			(event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) &&
			can_submit
		) {
			event.preventDefault();
			panel_el?.focus({ preventScroll: true });
		} else if (event.key === 'Escape' && text !== '') {
			// Clear first; a second Esc falls through to the global "leave a field".
			event.preventDefault();
			event.stopPropagation();
			text = '';
			picked_date = null;
			picked_priority = null;
		}
	}
</script>

<div class="cap">
	<form
		class="cap-box"
		onsubmit={(event) => {
			event.preventDefault();
			void submit();
		}}
	>
		<PlusIcon size={14} strokeWidth={1.6} aria-hidden="true" />
		<input
			bind:this={input}
			bind:value={text}
			class="cap-input"
			type="text"
			autocomplete="off"
			spellcheck="false"
			maxlength="400"
			placeholder="what's on your agenda?"
			aria-label="Add a todo"
			aria-describedby="cap-hint"
			onkeydown={onKeydown}
		/>
		<button class="btn btn-sm btn-primary" type="submit" disabled={!can_submit}>Add</button>
	</form>

	{#if parsed.tokens.length > 0 || parsed.title !== ''}
		<div class="cap-preview" transition:expand={{ duration: 200 }} aria-live="polite">
			<div class="cap-row">
				{#if parsed.title !== ''}
					<span class="cap-title" in:scale={{ start: 0.96, duration: dur(160) }}
						>{parsed.title}</span
					>
				{:else}
					<span class="cap-title cap-title-empty">add a title</span>
				{/if}
				{#each parsed.tokens as token (token.kind + token.source)}
					<span
						class="cap-chip cap-{token.kind}"
						animate:flip={{ duration: dur(200) }}
						in:scale={{ start: 0.8, duration: dur(200) }}
						out:scale={{ start: 0.8, duration: dur(140) }}
						title="{token.source} → {token.value}"
					>
						{#if token.kind === 'priority'}
							<PriorityChip {priority} />
						{:else if token.kind === 'due'}
							<CalendarIcon size={11} strokeWidth={1.6} aria-hidden="true" />
							{dueLabel(token.value, now)}
							<span class="cap-iso mono-num">{token.value}</span>
						{:else}
							{token.value}
						{/if}
					</span>
				{/each}
				<!-- Choices made in the refine panel, when the line itself names none. -->
				{#if picked_priority !== null && !parsed.tokens.some((token) => token.kind === 'priority')}
					<span
						class="cap-chip cap-priority"
						in:scale={{ start: 0.8, duration: dur(200) }}
						out:scale={{ start: 0.8, duration: dur(140) }}
					>
						<PriorityChip {priority} />
					</span>
				{/if}
				{#if parsed.due_at === null && final.due_at !== null}
					<span
						class="cap-chip cap-due"
						in:scale={{ start: 0.8, duration: dur(200) }}
						out:scale={{ start: 0.8, duration: dur(140) }}
					>
						<CalendarIcon size={11} strokeWidth={1.6} aria-hidden="true" />
						{dueLabel(final.due_at, now)}
						<span class="cap-iso mono-num">{final.due_at}</span>
					</span>
				{/if}
			</div>
		</div>
	{/if}
	{#if can_submit}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			class="cap-refine"
			role="group"
			aria-label="Refine: date and priority"
			tabindex="0"
			bind:this={panel_el}
			onkeydown={onPanelKeydown}
			transition:expand={{ duration: 180 }}
		>
			<div class="cap-refine-in">
				{#if show_dates}
					{#each suggestions as suggestion, index (suggestion.label)}
						<button
							class="cap-sug"
							class:is-on={picked_date === index}
							type="button"
							tabindex="-1"
							aria-pressed={picked_date === index}
							onclick={() => (picked_date = picked_date === index ? null : index)}
						>
							<kbd>{index + 1}</kbd>
							{suggestion.label}
						</button>
					{/each}
				{/if}
				<span class="cap-step" aria-label="Priority">
					<button
						class="cap-arrow"
						type="button"
						tabindex="-1"
						aria-label="More urgent"
						disabled={priority === 0}
						onclick={() => stepPriority(-1)}>‹</button
					>
					<PriorityChip {priority} />
					<button
						class="cap-arrow"
						type="button"
						tabindex="-1"
						aria-label="Less urgent"
						disabled={priority === 4}
						onclick={() => stepPriority(1)}>›</button
					>
				</span>
				<span class="cap-refine-hint"
					>↓ here · {show_dates ? '1–4 date · ' : ''}←→ priority · ⌘↵ add</span
				>
			</div>
		</div>
	{/if}
	<p id="cap-hint" class="cap-hint">
		<span class="mono-num">p0–p4</span> priority ·
		<span>today, tomorrow, fri, next week, in 3 days, 2026-11-03</span>
		due · <span>+project @context</span> tags · Enter adds, ↓ refines
	</p>
</div>

<style>
	.cap {
		margin-bottom: var(--s-5);
	}
	.cap-box {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding: var(--s-2) var(--s-2) var(--s-2) var(--s-3);
		background: var(--s2);
		border: 1px solid var(--line-2);
		border-radius: var(--r-2);
		color: var(--tx-dim);
		transition:
			border-color 0.12s ease,
			box-shadow 0.12s ease;
	}
	.cap-box:focus-within {
		border-color: var(--em-500);
		box-shadow: var(--glow-edge);
		color: var(--tx-hi);
	}
	.cap-input {
		flex: 1;
		min-width: 0;
		height: 28px;
		background: transparent;
		border: 0;
		outline: none;
		color: var(--tx-hi);
		font: inherit;
		font-size: var(--t-base);
	}
	.cap-input::placeholder {
		color: var(--tx-faint);
	}
	.cap-preview {
		overflow: hidden;
	}
	.cap-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
		padding: var(--s-3) var(--s-1) 0;
	}
	.cap-title {
		color: var(--tx-hi);
		font-size: var(--t-sm);
		font-weight: 600;
		margin-right: var(--s-1);
		overflow-wrap: anywhere;
	}
	.cap-title-empty {
		color: var(--tx-faint);
		font-weight: 400;
	}
	.cap-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 20px;
		padding: 0 7px;
		border: 1px solid var(--line);
		border-radius: var(--r-1);
		background: var(--s2);
		color: var(--tx-mid);
		font-size: var(--t-xs);
		letter-spacing: 0.04em;
	}
	.cap-priority {
		padding: 0;
		border: 0;
		background: transparent;
	}
	.cap-tag {
		color: var(--cyan-tx);
		border-color: var(--cyan-line);
	}
	.cap-iso {
		color: var(--tx-dim);
	}
	.cap-refine {
		overflow: hidden;
		outline: none;
		border-radius: var(--r-1);
	}
	.cap-refine:focus-visible .cap-refine-in {
		border-color: var(--em-500);
	}
	.cap-refine-in {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
		margin-top: var(--s-2);
		padding: var(--s-2);
		border: 1px dashed var(--line-2);
		border-radius: var(--r-1);
	}
	.cap-sug {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 22px;
		padding: 0 8px;
		border: 1px solid var(--line);
		border-radius: var(--r-1);
		background: var(--s2);
		color: var(--tx-mid);
		font: inherit;
		font-size: var(--t-xs);
		cursor: pointer;
	}
	.cap-sug:hover {
		border-color: var(--line-3);
		color: var(--tx-hi);
	}
	.cap-sug.is-on {
		border-color: var(--em-500);
		color: var(--tx-hi);
		background: var(--s4);
	}
	.cap-sug kbd {
		font: inherit;
		color: var(--tx-dim);
	}
	.cap-step {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-left: var(--s-2);
	}
	.cap-arrow {
		width: 20px;
		height: 20px;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: var(--r-1);
		background: var(--s2);
		color: var(--tx-mid);
		cursor: pointer;
		line-height: 1;
	}
	.cap-arrow:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.cap-refine-hint {
		margin-left: auto;
		color: var(--tx-dim);
		font-size: var(--t-xs);
	}
	.cap-hint {
		margin: var(--s-2) var(--s-1) 0;
		color: var(--tx-dim);
		font-size: var(--t-xs);
		line-height: 1.6;
	}
	@media (max-width: 600px) {
		.cap-hint {
			display: none;
		}
	}
</style>
