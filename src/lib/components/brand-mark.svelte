<script lang="ts">
	/**
	 * The Beadsmith mark: a hammer raised over three beads on a rod, resting on
	 * an anvil. The beads on their rod are the earlier mark, kept whole. Inline
	 * so it takes the theme's ink, paper and red from the tokens; the PNGs in
	 * $lib/assets are the same drawing for favicons.
	 */
	interface Props {
		/** Rendered width and height in CSS pixels. */
		size?: number;
		class?: string;
	}

	let { size = 28, class: class_name = '' }: Props = $props();

	// A page can show the mark twice (top bar and sign-in), so the mask needs
	// its own id each time.
	const uid = $props.id();
	const mask_id = `brand-mark-clearance-${uid}`;
</script>

<svg
	class="brand-svg {class_name}"
	width={size}
	height={size}
	viewBox="92 128 792 764"
	aria-hidden="true"
	focusable="false"
>
	<defs>
		<!-- The anvil face stops short of the beads, so they read as resting on it. -->
		<mask id={mask_id} maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
			<rect width="1024" height="1024" fill="white" />
			<g fill="black">
				<circle cx="342" cy="488" r="82" />
				<circle cx="504" cy="488" r="82" />
				<circle cx="666" cy="488" r="82" />
			</g>
		</mask>
	</defs>
	<g class="ink" stroke-width="8" stroke-linejoin="round" stroke-linecap="round">
		<!-- Anvil: flat face, horn to the left, waisted body, broad foot. -->
		<path
			mask="url(#{mask_id})"
			d="M114 558 H858 Q870 558 870 570 V644 Q870 660 852 660 H704 C658 660 620 702 620 746 C620 789 656 805 704 824 Q724 833 724 858 V870 Q724 880 712 880 H340 Q328 880 328 868 V857 C328 832 345 822 373 811 C422 792 447 777 447 740 C447 700 425 671 390 667 C276 655 183 625 111 585 Q100 579 104 568 Q107 558 114 558Z"
		/>
		<!-- Hammer: handle, then head, clear of the beads. -->
		<path d="M640 274 L856 424 Q881 441 865 462 Q850 480 829 465 L611 313Z" />
		<path
			d="M505 329 L575 218 L674 147 Q684 140 693 148 L715 168 Q723 176 716 186 L587 376 Q580 387 569 380 L510 345 Q499 339 505 329Z"
		/>
		<!-- The beads: equal discs, the middle one red. -->
		<circle cx="342" cy="488" r="74" />
		<circle class="red" cx="504" cy="488" r="74" />
		<circle cx="666" cy="488" r="74" />
		<path class="rod" d="M211 488 H795" stroke-width="30" />
		<path class="rod-core" d="M211 488 H795" stroke-width="14" />
		<g class="paper">
			<circle cx="342" cy="488" r="18" />
			<circle cx="504" cy="488" r="18" />
			<circle cx="666" cy="488" r="18" />
		</g>
	</g>
</svg>

<style>
	.brand-svg {
		flex: none;
		overflow: visible;
	}
	.ink {
		fill: var(--tx-hi);
		stroke: var(--tx-hi);
	}
	.red {
		fill: var(--em-500);
	}
	.rod {
		fill: none;
		stroke: var(--tx-hi);
	}
	.rod-core {
		fill: none;
		stroke: var(--bg);
	}
	.paper {
		fill: var(--bg);
		stroke: none;
	}
</style>
