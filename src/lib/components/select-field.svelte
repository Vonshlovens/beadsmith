<script lang="ts" generics="T extends string">
	/**
	 * The app's dropdown, in place of a native `<select>` whose open list is
	 * drawn by the browser and ignores the theme. bits-ui owns the behaviour
	 * (keyboard, typeahead, focus return, a hidden input for forms); the
	 * trigger keeps the `.select` field look so forms line up.
	 *
	 *   <SelectField bind:value items={[{ value: 'p1', label: 'P1' }]} />
	 */
	import { Select } from 'bits-ui';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import CheckIcon from 'phosphor-svelte/lib/CheckIcon';

	interface SelectItem {
		value: T;
		label: string;
		/** Secondary text on the right of the option, such as a database name. */
		hint?: string;
		disabled?: boolean;
	}

	interface Props {
		value: T;
		items: SelectItem[];
		onValueChange?: (value: T) => void;
		/**
		 * The parent owns the value: a pick only calls `onValueChange`, and the
		 * trigger keeps showing `value` until the parent changes it.
		 */
		controlled?: boolean;
		/** Extra class on the trigger (`select-sm`, a width). */
		class?: string;
		id?: string;
		name?: string;
		required?: boolean;
		disabled?: boolean;
		placeholder?: string;
		'aria-label'?: string;
		'aria-describedby'?: string;
	}

	let {
		value = $bindable(),
		items,
		onValueChange,
		controlled = false,
		class: class_name = '',
		id,
		name,
		required = false,
		disabled = false,
		placeholder = 'Choose…',
		'aria-label': aria_label,
		'aria-describedby': aria_describedby
	}: Props = $props();

	const selected = $derived(items.find((item) => item.value === value));
</script>

<Select.Root
	type="single"
	{value}
	{items}
	{name}
	{required}
	{disabled}
	onValueChange={(next) => {
		if (!controlled) {
			value = next as T;
		}
		onValueChange?.(next as T);
	}}
>
	<Select.Trigger
		class="select select-trigger {class_name}"
		{id}
		aria-label={aria_label}
		aria-describedby={aria_describedby}
	>
		<span class="st-value" class:is-placeholder={!selected}>{selected?.label ?? placeholder}</span>
		<CaretDownIcon class="st-caret" size={12} weight="bold" aria-hidden="true" />
	</Select.Trigger>
	<Select.Portal>
		<Select.Content class="ui-menu select-menu" sideOffset={4} collisionPadding={8}>
			<Select.Viewport class="select-viewport">
				{#each items as item (item.value)}
					<Select.Item
						class="select-opt"
						value={item.value}
						label={item.label}
						disabled={item.disabled}
					>
						{#snippet children({ selected: is_selected })}
							<span class="so-check" aria-hidden="true">
								{#if is_selected}<CheckIcon size={12} weight="bold" />{/if}
							</span>
							<span class="so-label">{item.label}</span>
							{#if item.hint}<span class="so-hint">{item.hint}</span>{/if}
						{/snippet}
					</Select.Item>
				{/each}
			</Select.Viewport>
		</Select.Content>
	</Select.Portal>
</Select.Root>
