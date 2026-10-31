<script lang="ts">
	/**
	 * Console Backups panel (ADR-0010): S3-compatible destination, schedule,
	 * retention, optional passphrase, and recent runs. Secrets are write-only:
	 * the API reports whether each is set, never its value.
	 */
	import { onDestroy, onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { api, errorMessage } from '$lib/client/api';
	import { relativeLong } from '$lib/client/format';
	import type { BackupSettingsUpdate, BackupsResponse } from '$lib/types';

	let state_ = $state<BackupsResponse | null>(null);
	let load_error = $state<string | null>(null);
	let saving = $state(false);
	let testing = $state(false);
	let starting = $state(false);

	let enabled = $state(false);
	let endpoint = $state('');
	let bucket = $state('');
	let region = $state('auto');
	let url_style = $state<'virtual-host' | 'path'>('virtual-host');
	let prefix = $state('beadsmith');
	let interval_hours = $state(24);
	let keep_runs = $state(30);
	let access_key_id = $state('');
	let secret_access_key = $state('');
	let passphrase = $state('');

	let poll: ReturnType<typeof setTimeout> | undefined;

	function adopt(next: BackupsResponse, reset_form: boolean): void {
		state_ = next;
		if (reset_form) {
			const c = next.config;
			enabled = c.enabled;
			endpoint = c.endpoint;
			bucket = c.bucket;
			region = c.region;
			url_style = c.url_style;
			prefix = c.prefix;
			interval_hours = c.interval_hours;
			keep_runs = c.keep_runs;
			access_key_id = '';
			secret_access_key = '';
			passphrase = '';
		}
		clearTimeout(poll);
		if (next.running) poll = setTimeout(() => void load(false), 3000);
	}

	async function load(reset_form: boolean): Promise<void> {
		try {
			adopt(await api.backups(), reset_form);
			load_error = null;
		} catch (error) {
			load_error = errorMessage(error);
		}
	}

	onMount(() => void load(true));
	onDestroy(() => clearTimeout(poll));

	async function save(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (saving) return;
		saving = true;
		const body: BackupSettingsUpdate = {
			enabled,
			endpoint,
			bucket,
			region,
			url_style,
			prefix,
			interval_hours: Number(interval_hours),
			keep_runs: Number(keep_runs)
		};
		if (access_key_id.trim() !== '') body.access_key_id = access_key_id.trim();
		if (secret_access_key.trim() !== '') body.secret_access_key = secret_access_key.trim();
		if (passphrase !== '') body.passphrase = passphrase;
		try {
			await api.putBackups(body);
			await load(true);
			toast.success('Backup settings saved');
		} catch (error) {
			toast.error('Could not save backup settings', { description: errorMessage(error) });
		} finally {
			saving = false;
		}
	}

	async function clearPassphrase(): Promise<void> {
		try {
			await api.putBackups({ passphrase: null });
			await load(true);
			toast.success('Passphrase removed; new backups will not be encrypted');
		} catch (error) {
			toast.error('Could not remove passphrase', { description: errorMessage(error) });
		}
	}

	async function test(): Promise<void> {
		if (testing) return;
		testing = true;
		try {
			await api.testBackup();
			toast.success('Connection works', { description: 'Wrote and deleted a test object.' });
		} catch (error) {
			toast.error('Connection failed', { description: errorMessage(error) });
		} finally {
			testing = false;
		}
	}

	async function runNow(): Promise<void> {
		if (starting) return;
		starting = true;
		try {
			await api.runBackup();
			await load(false);
		} catch (error) {
			toast.error('Could not start a backup', { description: errorMessage(error) });
		} finally {
			starting = false;
		}
	}

	function size(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}

	const config = $derived(state_?.config);
	const running = $derived(state_?.running === true);
</script>

<div class="panel card-pad">
	{#if load_error && !state_}
		<p class="hint" role="alert">Backups could not be loaded: {load_error}</p>
	{:else if config}
		<form class="backup-form" onsubmit={save}>
			<p class="hint">
				Every project database is dumped as SQL over the read-only connection, compressed, and
				uploaded to any S3-compatible bucket (Railway, AWS S3, R2, MinIO). Restore with
				<span class="mono">pnpm run restore</span>; see docs/backups.md.
			</p>

			<label class="check">
				<input type="checkbox" bind:checked={enabled} />
				<span>Run on a schedule</span>
			</label>

			<div class="grid">
				<label class="field wide">
					<span class="lbl">Endpoint</span>
					<input
						class="input"
						bind:value={endpoint}
						placeholder="https://t3.storageapi.dev"
						maxlength={256}
					/>
				</label>
				<label class="field">
					<span class="lbl">Bucket</span>
					<input class="input" bind:value={bucket} placeholder="beads-backups" maxlength={63} />
				</label>
				<label class="field">
					<span class="lbl">Region</span>
					<input class="input" bind:value={region} placeholder="auto" maxlength={32} />
				</label>
				<label class="field">
					<span class="lbl">Addressing</span>
					<select class="select" bind:value={url_style}>
						<option value="virtual-host">Virtual-host (bucket.host)</option>
						<option value="path">Path (host/bucket)</option>
					</select>
				</label>
				<label class="field">
					<span class="lbl">Prefix</span>
					<input class="input" bind:value={prefix} placeholder="beadsmith" maxlength={128} />
				</label>
				<label class="field">
					<span class="lbl">Access key ID</span>
					<input
						class="input"
						bind:value={access_key_id}
						autocomplete="off"
						placeholder={config.access_key_id_set
							? `Saved, ends ${config.access_key_id_hint ?? '····'}; blank keeps it`
							: 'Required'}
					/>
				</label>
				<label class="field">
					<span class="lbl">Secret access key</span>
					<input
						class="input"
						type="password"
						bind:value={secret_access_key}
						autocomplete="new-password"
						placeholder={config.secret_access_key_set ? 'Saved; blank keeps it' : 'Required'}
					/>
				</label>
				<label class="field">
					<span class="lbl">Every (hours)</span>
					<input class="input" type="number" min="1" max="168" bind:value={interval_hours} />
				</label>
				<label class="field">
					<span class="lbl">Keep runs</span>
					<input class="input" type="number" min="1" max="365" bind:value={keep_runs} />
				</label>
				<label class="field wide">
					<span class="lbl">Encryption passphrase (optional)</span>
					<input
						class="input"
						type="password"
						bind:value={passphrase}
						autocomplete="new-password"
						minlength={12}
						placeholder={config.passphrase_set
							? 'Saved; blank keeps it'
							: 'At least 12 characters; leave blank for unencrypted backups'}
					/>
				</label>
			</div>
			<p class="hint">
				Keep the passphrase somewhere else too: encrypted backups cannot be restored without it.
				Keys and passphrase are encrypted on this server and never shown again.
				{#if state_?.master_key === 'generated'}
					The encryption key lives next to the app database (<span class="mono">secret.key</span>);
					set
					<span class="mono">BDX_SECRET_KEY_FILE</span> to keep it elsewhere.
				{/if}
			</p>

			<div class="acts">
				<button class="btn btn-sm btn-primary" type="submit" disabled={saving}>
					{saving ? 'Saving…' : 'Save'}
				</button>
				<button
					class="btn btn-sm"
					type="button"
					disabled={testing || !config.configured}
					onclick={test}
				>
					{testing ? 'Testing…' : 'Test connection'}
				</button>
				<button
					class="btn btn-sm"
					type="button"
					disabled={starting || running || !config.configured}
					onclick={runNow}
				>
					{running ? 'Backing up…' : 'Run now'}
				</button>
				{#if config.passphrase_set}
					<button class="btn btn-sm" type="button" onclick={clearPassphrase}
						>Remove passphrase</button
					>
				{/if}
			</div>
		</form>

		{#if state_ && state_.runs.length > 0}
			<table class="tbl runs">
				<thead>
					<tr
						><th>Started</th><th>Trigger</th><th>Status</th><th>Databases</th><th>Size</th><th
							>Detail</th
						></tr
					>
				</thead>
				<tbody>
					{#each state_.runs as run (run.id)}
						<tr>
							<td>{relativeLong(run.started_at)}</td>
							<td>{run.trigger}</td>
							<td><span class:faint={run.status === 'running'}>{run.status}</span></td>
							<td class="t-num">{run.databases}</td>
							<td class="t-num">{size(run.bytes)}</td>
							<td class="detail">
								{#if run.error}
									{run.error}
								{:else if run.location}
									<span class="mono">{run.location}</span>{#if run.pruned > 0}<span class="faint">
											· pruned {run.pruned}</span
										>{/if}
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	{:else}
		<p class="hint">Loading backups…</p>
	{/if}
</div>

<style>
	.backup-form {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 12px;
	}
	.wide {
		grid-column: 1 / -1;
	}
	.acts {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.runs {
		margin-top: 18px;
		width: 100%;
	}
	.detail {
		max-width: 360px;
		overflow-wrap: anywhere;
	}
	.mono {
		font-family: var(--font-mono, monospace);
	}
</style>
