<script lang="ts">
	/**
	 * The signed-in account (ADR-0011): who you are, your role, and a password
	 * change. Changing the password signs out every other session.
	 */
	import { toast } from 'svelte-sonner';
	import { auth, authErrorMessage } from '$lib/client/auth';
	import { PRODUCT_NAME } from '$lib/product';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let current_password = $state('');
	let new_password = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function changePassword(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		busy = true;
		error = null;
		try {
			await auth.changePassword(current_password, new_password);
			current_password = '';
			new_password = '';
			toast.success('Password changed', { description: 'Other sessions were signed out.' });
		} catch (thrown) {
			error = authErrorMessage(thrown);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Account · {PRODUCT_NAME}</title></svelte:head>

<div class="wrap wrap-narrow">
	<div class="page-hd">
		<div>
			<div class="lbl mb-2">Account</div>
			<h1 class="h1">{data.account.name}</h1>
		</div>
	</div>

	<section class="sec" aria-labelledby="account-who">
		<div class="sec-hd">
			<span class="lbl" id="account-who">Signed in</span><span class="rule"></span>
		</div>
		<div class="panel card-pad">
			<dl class="kv">
				<dt>Email</dt>
				<dd>{data.account.email}</dd>
				<dt>Role</dt>
				<dd>
					{data.account.role}
					<span class="faint">
						· {data.account.role === 'admin'
							? 'reads everything, runs the console, launches agents'
							: 'reads projects and issues'}
					</span>
				</dd>
			</dl>
		</div>
	</section>

	<section class="sec" aria-labelledby="account-password">
		<div class="sec-hd">
			<span class="lbl" id="account-password">Password</span><span class="rule"></span>
		</div>
		<div class="panel card-pad">
			<form class="pw-form" onsubmit={changePassword}>
				<label class="field">
					<span class="lbl">Current password</span>
					<input
						class="input"
						type="password"
						bind:value={current_password}
						autocomplete="current-password"
						required
						maxlength={128}
					/>
				</label>
				<label class="field">
					<span class="lbl">New password</span>
					<input
						class="input"
						type="password"
						bind:value={new_password}
						autocomplete="new-password"
						required
						minlength={data.min_password_length}
						maxlength={128}
					/>
					<span class="hint">At least {data.min_password_length} characters.</span>
				</label>
				{#if error}
					<p class="hint" role="alert">{error}</p>
				{/if}
				<div>
					<button class="btn btn-sm btn-primary" type="submit" disabled={busy}>
						{busy ? 'Saving…' : 'Change password'}
					</button>
				</div>
			</form>
		</div>
	</section>
</div>

<style>
	.pw-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
		max-width: 360px;
	}
</style>
