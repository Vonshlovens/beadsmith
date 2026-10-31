<script lang="ts">
	/** Instance-admin console: catalog coverage and redacted health. */
	import { invalidateAll } from '$app/navigation';
	import AccountSettings from '$lib/components/account-settings.svelte';
	import BackupSettings from '$lib/components/backup-settings.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import FileCheckoutDialog from '$lib/components/file-checkout-dialog.svelte';
	import TackleMapDialog from '$lib/components/tackle-map-dialog.svelte';
	import { api, errorMessage } from '$lib/client/api';
	import { relativeLong } from '$lib/client/format';
	import { PRODUCT_NAME } from '$lib/product';
	import { toast } from 'svelte-sonner';
	import type {
		ConsoleAccessPolicyClass,
		ConsoleProjectRow,
		ConsoleSnapshot,
		DispatchProjectAllow,
		DispatchProviderId
	} from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let refreshing = $state(false);
	let map_open = $state(false);
	let file_open = $state(false);
	let editing: ConsoleProjectRow | null = $state(null);
	let file_editing: ConsoleProjectRow | null = $state(null);
	let arming = $state(false);
	let saving_allow = $state<string | null>(null);
	const snapshot = $derived(data.console_snapshot);
	const maps_locked = $derived(snapshot?.coverage.maps_invalid === true);
	const armed = $derived(snapshot?.health.dispatch.armed === true);

	function openEditor(project: ConsoleProjectRow): void {
		editing = project;
		map_open = true;
	}

	function openFileEditor(project: ConsoleProjectRow): void {
		file_editing = project;
		file_open = true;
	}

	async function refresh(): Promise<void> {
		if (refreshing) {
			return;
		}
		refreshing = true;
		try {
			await api.refreshProjects();
			await invalidateAll();
		} catch (error) {
			toast.error('Could not refresh catalog', { description: errorMessage(error) });
		} finally {
			refreshing = false;
		}
	}

	async function setArmed(next: boolean): Promise<void> {
		if (arming) {
			return;
		}
		arming = true;
		try {
			await api.setDispatchArmed(next);
			await invalidateAll();
		} catch (error) {
			toast.error(next ? 'Could not arm dispatch' : 'Could not disarm dispatch', {
				description: errorMessage(error)
			});
		} finally {
			arming = false;
		}
	}

	async function setAllow(
		project: ConsoleProjectRow,
		patch: Partial<DispatchProjectAllow>
	): Promise<void> {
		if (saving_allow === project.id) {
			return;
		}
		saving_allow = project.id;
		const allow = { ...project.allow, ...patch };
		try {
			await api.putDispatchAllow(project.id, allow);
			await invalidateAll();
		} catch (error) {
			toast.error('Could not update File/Tackle allow', { description: errorMessage(error) });
		} finally {
			saving_allow = null;
		}
	}

	function doltWord(health: ConsoleSnapshot['health']): string {
		if (!health.dolt.configured) {
			return 'not configured';
		}
		if (health.dolt.reachable) {
			return 'connected';
		}
		switch (health.dolt.failure_kind) {
			case 'credential_unavailable':
				return 'credential unavailable';
			case 'authentication_rejected':
				return 'authentication rejected';
			case 'unreachable':
				return 'unreachable';
			default:
				return 'connection problem';
		}
	}

	const PROVIDER_COPY: Record<DispatchProviderId | 'none', string> = {
		webhook: 'Webhook agent runner',
		none: 'No provider (read-only)'
	};

	const PROVIDER_ERROR_COPY: Record<
		NonNullable<ConsoleSnapshot['health']['dispatch']['provider_error']>,
		string
	> = {
		invalid: 'BDX_DISPATCH_PROVIDER is not webhook or none',
		webhook_url_invalid: 'webhook URL must be https (http only on loopback)',
		webhook_secret_missing: 'webhook secret is not configured'
	};

	const ACCESS_POLICY_COPY: Record<ConsoleAccessPolicyClass, string> = {
		ok: 'Configuration is complete. Every route needs a signed-in account.',
		dolt_unconfigured: 'A remote Dolt server is not configured.',
		incomplete: 'Access issuer and audience must be configured together.',
		invalid_service_token_id: 'The service-token allowlist is invalid.',
		public_origin_error: 'Public origin is invalid or its hostname is not in allowed hosts.'
	};
</script>

<svelte:head><title>Console · {PRODUCT_NAME}</title></svelte:head>

<div class="wrap">
	<div class="page-hd">
		<div>
			<div class="lbl mb-2">System</div>
			<h1 class="h1">Console</h1>
		</div>
		<div class="meta">
			{#if snapshot}
				{snapshot.coverage.mapped_count} of {snapshot.coverage.project_count} mapped
			{:else}
				catalog coverage
			{/if}
		</div>
		<div class="acts">
			<button class="btn" type="button" disabled={refreshing} onclick={refresh}>
				{refreshing ? 'Refreshing…' : 'Refresh'}
			</button>
		</div>
	</div>

	{#if data.error}
		<div class="banner banner-err mb-5" role="alert">
			<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
			<div class="banner-bd">
				<b>The operator console could not be loaded.</b>
				<div class="mt-2">{data.error}</div>
			</div>
			<div class="banner-acts">
				<button class="btn btn-sm" type="button" disabled={refreshing} onclick={refresh}
					>{refreshing ? 'Retrying…' : 'Retry now'}</button
				>
			</div>
		</div>
	{:else if snapshot}
		{#if snapshot.coverage.maps_invalid}
			<div class="banner banner-warn mb-5" role="status">
				<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
				<div class="banner-bd">
					<b>Tackle mapping configuration is unusable.</b>
					<div class="mt-2">
						Every discovered project is treated as unmapped until the service mapping config is
						fixed. Mapping values are not shown, and console edits are paused.
					</div>
				</div>
			</div>
		{/if}

		<section class="sec" aria-labelledby="console-health">
			<div class="sec-hd">
				<span class="lbl" id="console-health">Health</span><span class="rule"></span>
			</div>
			<div class="panel card-pad">
				<dl class="kv health-kv">
					<dt>Dolt</dt>
					<dd>
						{doltWord(snapshot.health)}
						{#if snapshot.health.dolt.latency_ms !== undefined}
							<span class="faint"> · {snapshot.health.dolt.latency_ms} ms</span>
						{/if}
					</dd>
					<dt>State db</dt>
					<dd>{snapshot.health.state_db.ok ? 'ok' : 'unavailable'}</dd>
					<dt>Dispatch</dt>
					<dd>
						{PROVIDER_COPY[snapshot.health.dispatch.provider ?? 'none']}
						{#if snapshot.health.dispatch.provider_error}
							<span class="schema-warn">
								· {PROVIDER_ERROR_COPY[snapshot.health.dispatch.provider_error]}</span
							>
						{/if}
						<span class="faint"> · {armed ? 'armed' : 'disarmed'}</span>
					</dd>
				</dl>
				<div class="arm-row">
					<button
						class="btn btn-sm{armed ? ' btn-danger' : ' btn-primary'}"
						type="button"
						disabled={arming}
						onclick={() => setArmed(!armed)}
					>
						{arming ? 'Saving…' : armed ? 'Disarm dispatch' : 'Arm dispatch'}
					</button>
					<p class="arm-help">
						Disarming hides File and Tackle while the provider configuration stays in place.
					</p>
				</div>
			</div>
		</section>

		<section class="sec" aria-labelledby="console-access">
			<div class="sec-hd">
				<span class="lbl" id="console-access">Access</span><span class="rule"></span>
			</div>
			<div class="panel card-pad">
				{#if snapshot.access.policy !== 'ok'}
					<div class="banner banner-warn mb-5" role="status">
						<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
						<div class="banner-bd">
							<b>Access or origin configuration is incomplete.</b>
							<div class="mt-2">{ACCESS_POLICY_COPY[snapshot.access.policy]}</div>
						</div>
					</div>
				{/if}
				<dl class="kv access-kv">
					<dt>Issuer</dt>
					<dd>
						{#if snapshot.access.issuer_host}
							{snapshot.access.issuer_host}
						{:else}
							<span class="faint">not configured</span>
						{/if}
					</dd>
					<dt>Audience</dt>
					<dd>{snapshot.access.audience_configured ? 'configured' : 'not configured'}</dd>
					<dt>Service tokens</dt>
					<dd>
						{#if snapshot.access.service_token_ids.length === 0}
							<span class="faint">none</span>
						{:else}
							<ul class="allowlist">
								{#each snapshot.access.service_token_ids as token_id (token_id)}
									<li class="id">{token_id}</li>
								{/each}
							</ul>
						{/if}
					</dd>
					<dt>Allowed hosts</dt>
					<dd>
						{#if snapshot.access.allowed_hosts.length === 0}
							<span class="faint">none</span>
						{:else}
							<ul class="allowlist">
								{#each snapshot.access.allowed_hosts as host (host)}
									<li>{host}</li>
								{/each}
							</ul>
						{/if}
					</dd>
					<dt>Public origin</dt>
					<dd>
						{#if snapshot.access.public_origin}
							{snapshot.access.public_origin}
						{:else}
							<span class="faint">not configured</span>
						{/if}
					</dd>
					<dt>Policy</dt>
					<dd>
						{#if snapshot.access.policy === 'ok'}
							{ACCESS_POLICY_COPY.ok}
						{:else}
							<span class="badge badge-blocked">{snapshot.access.policy.replaceAll('_', ' ')}</span>
						{/if}
					</dd>
				</dl>
				<p class="arm-help access-help">
					This panel is read-only. Cloudflare Access is optional; when set, people still sign in to
					their account, and only the listed service tokens may read without one.
				</p>
			</div>
		</section>

		<section class="sec" aria-labelledby="console-coverage">
			<div class="sec-hd">
				<span class="lbl" id="console-coverage">Coverage</span><span class="rule"></span>
				<span class="meta"
					>{snapshot.coverage.project_count} projects · {snapshot.coverage.mapped_count} mapped</span
				>
			</div>
			{#if snapshot.coverage.unmapped_ids.length > 0}
				<p class="unmapped">
					Unmapped:
					{#each snapshot.coverage.unmapped_ids as id, index (id)}{index > 0 ? ', ' : ''}<span
							class="id">{id}</span
						>{/each}
				</p>
			{:else if snapshot.coverage.project_count > 0}
				<p class="unmapped">Every discovered project has a Tackle map.</p>
			{/if}
		</section>

		<section class="sec" aria-labelledby="console-catalog">
			<div class="sec-hd">
				<span class="lbl" id="console-catalog">Catalog</span><span class="rule"></span>
			</div>
			{#if snapshot.projects.length === 0}
				<EmptyState
					title="No discovered projects"
					description="Remote Dolt databases appear here once discovery succeeds."
				/>
			{:else}
				<div class="panel tbl-scroll">
					<table class="tbl" style="min-width: 1100px">
						<thead>
							<tr>
								<th>Project</th>
								<th>Last activity</th>
								<th>Map</th>
								<th>File</th>
								<th>Tackle</th>
								<th>Repository</th>
								<th>Ref</th>
								<th>PR</th>
								<th>File checkout</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{#each snapshot.projects as project (project.id)}
								<tr class:is-unmapped={!project.tackle.mapped}>
									<td>
										<div class="proj">
											<a href="/p/{project.id}">{project.name}</a>
											<div class="id faint">{project.id}</div>
											{#if project.schema}
												<div
													class="id"
													class:faint={project.schema.status === 'supported'}
													class:schema-warn={project.schema.status !== 'supported'}
													title={project.schema.missing.length > 0
														? `Missing: ${project.schema.missing.join(', ')}`
														: undefined}
												>
													bd {project.schema.bd_version ?? '?'} · {project.schema.status}
												</div>
											{/if}
										</div>
									</td>
									<td class="t-num">{relativeLong(project.last_activity)}</td>
									<td>
										{#if project.tackle.mapped}
											<span class="badge badge-open">
												{project.tackle.source === 'env' ? 'Env' : 'Mapped'}
											</span>
										{:else}
											<span class="badge badge-blocked">Unmapped</span>
										{/if}
									</td>
									<td>
										<label class="allow">
											<input
												type="checkbox"
												checked={project.allow.file}
												disabled={saving_allow === project.id}
												onchange={() => setAllow(project, { file: !project.allow.file })}
											/>
											<span class="sr-only">Allow File for {project.name}</span>
										</label>
									</td>
									<td>
										<label class="allow">
											<input
												type="checkbox"
												checked={project.allow.tackle}
												disabled={saving_allow === project.id}
												onchange={() => setAllow(project, { tackle: !project.allow.tackle })}
											/>
											<span class="sr-only">Allow Tackle for {project.name}</span>
										</label>
									</td>
									<td class="repo">
										{#if project.tackle.mapped}
											{project.tackle.url}
										{:else}
											<span class="faint">—</span>
										{/if}
									</td>
									<td>
										{#if project.tackle.mapped}
											{project.tackle.ref}
										{:else}
											<span class="faint">—</span>
										{/if}
									</td>
									<td>
										{#if project.tackle.mapped}
											{project.tackle.auto_create_pr ? 'yes' : 'no'}
										{:else}
											<span class="faint">—</span>
										{/if}
									</td>
									<td class="repo">
										{#if project.file.mapped}
											<div>{project.file.url}</div>
											<div class="faint">{project.file.ref}</div>
										{:else}
											<span class="faint">Default</span>
										{/if}
									</td>
									<td class="acts-cell">
										<button
											class="btn btn-sm"
											type="button"
											disabled={maps_locked}
											onclick={() => openEditor(project)}
										>
											{project.tackle.mapped ? 'Edit Tackle' : 'Set Tackle'}
										</button>
										<button
											class="btn btn-sm"
											type="button"
											onclick={() => openFileEditor(project)}
										>
											{project.file.mapped ? 'Edit File' : 'Set File'}
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{/if}

	<!-- Accounts and backups do not depend on Dolt being reachable, so they
	     render even when the snapshot above failed. -->
	<section class="sec" aria-labelledby="console-accounts">
		<div class="sec-hd">
			<span class="lbl" id="console-accounts">Accounts</span><span class="rule"></span>
		</div>
		<AccountSettings />
	</section>

	<section class="sec" aria-labelledby="console-backups">
		<div class="sec-hd">
			<span class="lbl" id="console-backups">Backups</span><span class="rule"></span>
		</div>
		<BackupSettings />
	</section>
</div>

{#if editing}
	<TackleMapDialog
		project={editing}
		bind:open={map_open}
		onSaved={async () => {
			await invalidateAll();
		}}
	/>
{/if}

{#if file_editing}
	<FileCheckoutDialog
		project={file_editing}
		bind:open={file_open}
		onSaved={async () => {
			await invalidateAll();
		}}
	/>
{/if}

<style>
	.page-hd {
		display: flex;
		align-items: flex-end;
		gap: var(--s-4);
		flex-wrap: wrap;
		margin-bottom: var(--s-5);
	}
	.page-hd .meta {
		font-size: var(--t-xs);
		color: var(--tx-dim);
		padding-bottom: 4px;
		font-variant-numeric: tabular-nums;
	}
	.page-hd .acts {
		margin-left: auto;
		display: flex;
		gap: var(--s-2);
	}
	.health-kv {
		grid-template-columns: 88px 1fr;
	}
	.access-kv {
		grid-template-columns: 120px 1fr;
	}
	.allowlist {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.allowlist li {
		font-size: var(--t-sm);
	}
	.access-help {
		margin-top: var(--s-4);
	}
	.arm-row {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		flex-wrap: wrap;
		margin-top: var(--s-4);
	}
	.arm-help {
		margin: 0;
		font-size: var(--t-xs);
		color: var(--tx-dim);
		max-width: 36rem;
	}
	.allow {
		display: inline-flex;
		align-items: center;
	}
	.unmapped {
		font-size: var(--t-sm);
		color: var(--tx-dim);
		margin: 0 0 var(--s-4);
	}
	.proj a {
		color: var(--tx-hi);
	}
	.repo {
		font-size: var(--t-xs);
		white-space: nowrap;
	}
	tr.is-unmapped td {
		color: var(--tx-dim);
	}
	.tbl tbody td {
		height: 52px;
	}
	.acts-cell {
		text-align: right;
		white-space: nowrap;
	}
	.schema-warn {
		color: var(--amber-tx);
	}
</style>
