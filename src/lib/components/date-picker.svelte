<script lang="ts">
	/**
	 * Pick a day from the app's own calendar, in place of `<input type=date>`,
	 * whose picker the browser draws (and draws differently in every one).
	 * bits-ui owns the grid's keyboard model: arrows move a day or a week,
	 * PageUp/PageDown a month, Enter picks, Esc closes and returns focus.
	 *
	 * The value is a local calendar day, `YYYY-MM-DD`, like the input's.
	 */
	import { Calendar, Popover } from 'bits-ui';
	import { getLocalTimeZone, parseDate, today, type DateValue } from '@internationalized/date';
	import CalendarBlankIcon from 'phosphor-svelte/lib/CalendarBlankIcon';
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';

	interface Props {
		/** `YYYY-MM-DD`, or empty for none. */
		value?: string;
		/** Called with the picked day. */
		onpick: (day: string) => void;
		label?: string;
		/** Trigger text while nothing is picked. */
		placeholder?: string;
	}

	let { value = '', onpick, label = 'Pick a date', placeholder = 'Pick a date…' }: Props = $props();

	let open = $state(false);

	function toDate(raw: string): DateValue | undefined {
		try {
			return raw ? parseDate(raw) : undefined;
		} catch {
			return undefined;
		}
	}

	const current = $derived(toDate(value));
	const shown = $derived(
		current
			? current.toDate(getLocalTimeZone()).toLocaleDateString(undefined, {
					weekday: 'short',
					month: 'short',
					day: 'numeric'
				})
			: placeholder
	);

	function pick(next: DateValue | undefined) {
		if (!next) return;
		open = false;
		onpick(next.toString());
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger class="btn btn-sm dp-trigger" aria-label="{label}{current ? `: ${shown}` : ''}">
		<CalendarBlankIcon size={14} aria-hidden="true" />
		<span>{shown}</span>
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			class="ui-menu dp-pop"
			sideOffset={6}
			collisionPadding={8}
			align="start"
			onOpenAutoFocus={(event) => event.preventDefault()}
		>
			<Calendar.Root
				type="single"
				value={current}
				onValueChange={pick}
				placeholder={current ?? today(getLocalTimeZone())}
				weekdayFormat="short"
				fixedWeeks
				initialFocus
				class="dp-cal"
			>
				{#snippet children({ months, weekdays })}
					<Calendar.Header class="dp-hd">
						<Calendar.PrevButton class="btn btn-sm btn-ghost btn-icon" aria-label="Previous month">
							<CaretLeftIcon size={14} />
						</Calendar.PrevButton>
						<Calendar.Heading class="dp-heading" />
						<Calendar.NextButton class="btn btn-sm btn-ghost btn-icon" aria-label="Next month">
							<CaretRightIcon size={14} />
						</Calendar.NextButton>
					</Calendar.Header>
					{#each months as month (month.value.toString())}
						<Calendar.Grid class="dp-grid">
							<Calendar.GridHead>
								<Calendar.GridRow class="dp-row">
									{#each weekdays as day (day)}
										<Calendar.HeadCell class="dp-wd">{day.slice(0, 2)}</Calendar.HeadCell>
									{/each}
								</Calendar.GridRow>
							</Calendar.GridHead>
							<Calendar.GridBody>
								{#each month.weeks as week (week[0]?.toString())}
									<Calendar.GridRow class="dp-row">
										{#each week as date (date.toString())}
											<Calendar.Cell {date} month={month.value} class="dp-cell">
												<Calendar.Day class="dp-day" />
											</Calendar.Cell>
										{/each}
									</Calendar.GridRow>
								{/each}
							</Calendar.GridBody>
						</Calendar.Grid>
					{/each}
				{/snippet}
			</Calendar.Root>
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>

<style>
	:global(.dp-trigger) {
		gap: 6px;
	}
	:global(.dp-pop) {
		z-index: 70;
		min-width: 0;
		width: auto;
		padding: var(--s-3);
	}
	:global(.dp-hd) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-2);
		margin-bottom: var(--s-2);
	}
	:global(.dp-heading) {
		font-size: var(--t-sm);
		font-weight: 600;
		color: var(--tx-hi);
	}
	:global(.dp-grid) {
		border-collapse: collapse;
	}
	:global(.dp-wd) {
		width: 34px;
		height: 24px;
		font-size: var(--t-xs);
		font-weight: 400;
		color: var(--tx-dim);
	}
	:global(.dp-cell) {
		padding: 1px;
	}
	:global(.dp-day) {
		display: grid;
		place-items: center;
		width: 32px;
		height: 30px;
		border-radius: var(--r-1);
		font-size: var(--t-sm);
		color: var(--tx);
		cursor: pointer;
		font-variant-numeric: tabular-nums;
	}
	:global(.dp-day:hover) {
		background: var(--s4);
		color: var(--tx-hi);
	}
	:global(.dp-day[data-outside-month]) {
		color: var(--tx-faint);
	}
	:global(.dp-day[data-today]) {
		box-shadow: inset 0 0 0 1px var(--line-3);
		font-weight: 600;
	}
	:global(.dp-day[data-selected]) {
		background: var(--em-500);
		color: var(--on-em);
		font-weight: 600;
		box-shadow: none;
	}
	:global(.dp-day[data-disabled]) {
		color: var(--tx-faint);
		cursor: not-allowed;
	}
	:global(.dp-day[data-focused]),
	:global(.dp-day:focus-visible) {
		outline: 2px solid var(--em-400);
		outline-offset: 1px;
	}
</style>
