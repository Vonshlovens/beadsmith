<script lang="ts">
	/** Top-bar switcher for Beads projects. */
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { currentProject, projectList } from '$lib/client/projects.svelte';
	import type { Project } from '$lib/types';

	const current = $derived(currentProject());
	const projects = $derived(projectList());
	const projects_error = $derived(page.data.projects_error ?? null);

	async function choose(project: Project) {
		await goto(`/p/${project.id}`);
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<button {...props} class="switcher" type="button" aria-label="Switch project">
				{#if current}
					<i class="dot dot-open" aria-hidden="true"></i>
					<span class="name">{current.name}</span>
				{:else}
					<i class="dot" aria-hidden="true"></i>
					<span class="name">All projects</span>
				{/if}
				<span class="caret" aria-hidden="true">▼</span>
			</button>
		{/snippet}
	</DropdownMenu.Trigger>

	<DropdownMenu.Content class="ui-menu" align="start" sideOffset={6}>
		<DropdownMenu.Group>
			<DropdownMenu.GroupHeading class="ui-menu-heading">Projects</DropdownMenu.GroupHeading>
			{#each projects as project (project.id)}
				<DropdownMenu.Item class="ui-menu-item" onSelect={() => choose(project)}>
					<i
						class="dot {project.id === current?.id ? 'dot-open' : ''}"
						style={project.id === current?.id ? '' : 'background: var(--tx-faint)'}
						aria-hidden="true"
					></i>
					<span class="tx">{project.name}</span>
					<span class="db">{project.dolt_database ?? ''}</span>
				</DropdownMenu.Item>
			{:else}
				<div class="ui-menu-item empty-row">
					{projects_error ? 'Projects unavailable' : 'No projects yet'}
				</div>
			{/each}
		</DropdownMenu.Group>
	</DropdownMenu.Content>
</DropdownMenu.Root>

<style>
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 22ch;
	}
	@media (max-width: 640px) {
		.name {
			max-width: 10ch;
		}
	}
	.tx {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.db {
		margin-left: auto;
		padding-left: var(--s-3);
		font-size: var(--t-xs);
		color: var(--tx-dim);
		white-space: nowrap;
	}
	.empty-row {
		color: var(--tx-dim);
		cursor: default;
	}
</style>
