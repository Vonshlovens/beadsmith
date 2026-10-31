<script lang="ts">
	/**
	 * The top-right instrument cluster (specs/00 §7, degraded cases in
	 * specs/05). Three readouts driven by `GET /api/status`: an icon names the
	 * dependency and the bead shows its state. Colour is never the only
	 * signal: the accessible name and the tooltip state the condition in words.
	 */
	import BotIcon from '@lucide/svelte/icons/bot';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import ServerIcon from '@lucide/svelte/icons/server';
	import { statusSnapshot } from '$lib/client/projects.svelte';
	import { relativeLong } from '$lib/client/format';

	const status = $derived(statusSnapshot());

	const dolt_tone = $derived.by(() => {
		if (!status) {
			return '';
		}
		if (!status.dolt.configured) {
			return '';
		}
		return status.dolt.reachable ? 'ok' : 'bad';
	});

	const dolt_word = $derived.by(() => {
		if (!status) {
			return 'checking';
		}
		if (!status.dolt.configured) {
			return 'not configured';
		}
		if (status.dolt.reachable) {
			return 'connected';
		}
		switch (status.dolt.failure_kind) {
			case 'credential_unavailable':
				return 'credential unavailable';
			case 'authentication_rejected':
				return 'authentication rejected';
			case 'unreachable':
				return 'unreachable';
			default:
				return 'connection problem';
		}
	});

	const service_tone = $derived.by(() => {
		if (!status) {
			return '';
		}
		return status.state_db.ok ? 'ok' : 'warn';
	});

	const service_word = $derived.by(() => {
		if (!status) {
			return 'checking';
		}
		return status.state_db.ok ? 'ready' : 'state database unavailable';
	});

	const agents_active = $derived(status ? status.agents.active : false);
	const agents_tone = $derived(status ? (agents_active ? 'live' : 'warn') : '');
</script>

<div class="cluster" role="group" aria-label="System status">
	<button
		class="stat {dolt_tone}"
		type="button"
		aria-describedby="tip-dolt"
		aria-label="Dolt server, {dolt_word}"
	>
		<i class="stat-dot" aria-hidden="true"></i><span class="stat-ic" aria-hidden="true"
			><DatabaseIcon size={12} strokeWidth={1.4} /></span
		>
		<span class="tip" id="tip-dolt" role="tooltip">
			<b>Dolt server · {dolt_word}</b>
			<span class="kvline">
				<span>round trip</span>
				<span class="hi"
					>{status?.dolt.latency_ms !== undefined ? `${status.dolt.latency_ms} ms` : '—'}</span
				>
			</span>
		</span>
	</button>

	<button
		class="stat {service_tone}"
		type="button"
		aria-describedby="tip-service"
		aria-label="Service, {service_word}"
	>
		<i class="stat-dot" aria-hidden="true"></i><span class="stat-ic" aria-hidden="true"
			><ServerIcon size={12} strokeWidth={1.4} /></span
		>
		<span class="tip" id="tip-service" role="tooltip">
			<b>Service · {service_word}</b>
			<span class="kvline">
				<span>state db</span><span class="hi"
					>{status?.state_db.ok ? 'writable' : 'unavailable'}</span
				>
			</span>
			<span class="kvline note">Read-only: agents make Beads changes with bd.</span>
		</span>
	</button>

	<button
		class="stat {agents_tone}"
		type="button"
		aria-describedby="tip-agents"
		aria-label="Agent activity, {agents_active ? 'active in the last 15 minutes' : 'idle'}, {status
			?.agents.count ?? 0} agents"
	>
		<i class="stat-dot" aria-hidden="true"></i><span class="stat-ic" aria-hidden="true"
			><BotIcon size={12} strokeWidth={1.4} /></span
		>
		<span class="stat-n" aria-hidden="true">{status?.agents.count ?? 0}</span>
		<span class="tip" id="tip-agents" role="tooltip">
			<b>Agent activity · {agents_active ? 'active' : 'idle'}</b>
			<span class="kvline">
				<span>last actor</span><span class="hi">{status?.agents.last_actor ?? '—'}</span>
			</span>
			<span class="kvline">
				<span>last seen</span><span class="hi">{relativeLong(status?.agents.last_seen)}</span>
			</span>
		</span>
	</button>
</div>

<style>
	/* The tooltip surface itself lives in app.css; only its positioning and
	   reveal are local. Hover and keyboard focus both open it. */
	.tip {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		opacity: 0;
		pointer-events: none;
		transform: translateY(-3px);
		transition:
			opacity 0.12s ease,
			transform 0.12s ease;
	}
	.stat:hover .tip,
	.stat:focus-visible .tip {
		opacity: 1;
		transform: none;
	}
	.note {
		margin-top: 6px;
		color: var(--tx-dim);
		display: block;
	}

	/* Anchored to the cluster's right edge, so it never runs off a phone. */
	.tip {
		max-width: calc(100vw - 24px);
	}
</style>
