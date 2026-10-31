<script lang="ts">
	/** Title cell: the row's meaning, clipped by the slack column. */
	interface Props {
		title: string;
		href: string;
	}

	let { title, href }: Props = $props();
</script>

<a {href} {title} style="color:inherit">{title}</a>
