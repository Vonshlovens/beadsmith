<script lang="ts">
	/**
	 * Sign-in, open sign-up, and first-admin setup (ADR-0011). Rendered without
	 * the app shell: nothing behind it loads until there is a session.
	 */
	import brandMarkDark from '$lib/assets/beadsmith-mark.png';
	import brandMarkLight from '$lib/assets/beadsmith-mark-light.png';
	import { auth, authErrorMessage } from '$lib/client/auth';
	import { PRODUCT_NAME } from '$lib/product';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Mode = 'sign-in' | 'sign-up' | 'bootstrap';

	let chosen = $state<Mode | null>(null);
	const mode = $derived<Mode>(data.bootstrap ? 'bootstrap' : (chosen ?? 'sign-in'));

	let name = $state('');
	let email = $state('');
	let password = $state('');
	let setup_token = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	const heading = $derived(
		mode === 'bootstrap'
			? 'Create the admin account'
			: mode === 'sign-up'
				? `Create a ${PRODUCT_NAME} account`
				: `Sign in to ${PRODUCT_NAME}`
	);

	/** Switch between sign-in and sign-up, keeping the email. */
	function choose(next: Mode) {
		chosen = next;
		error = null;
		password = '';
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		busy = true;
		error = null;
		try {
			if (mode === 'sign-in') {
				await auth.signIn(email.trim(), password);
			} else {
				await auth.signUp({
					name: name.trim(),
					email: email.trim(),
					password,
					...(mode === 'bootstrap' ? { setup_token } : {})
				});
			}
			// A full load so the shell and its data start from the new session.
			window.location.assign(data.redirect_to);
		} catch (thrown) {
			error = authErrorMessage(thrown);
			busy = false;
		}
	}
</script>

<svelte:head><title>{heading} · {PRODUCT_NAME}</title></svelte:head>

<main class="auth" id="main">
	<div class="auth-card panel card-pad">
		<div class="auth-brand">
			<span class="brand-mark" aria-hidden="true">
				<img class="brand-mark-image brand-mark-image-light" src={brandMarkLight} alt="" />
				<img class="brand-mark-image brand-mark-image-dark" src={brandMarkDark} alt="" />
			</span>
			<span class="lbl">{PRODUCT_NAME}</span>
		</div>

		<h1 class="h1 auth-title">{heading}</h1>

		{#if mode === 'bootstrap'}
			<p class="hint">
				No account exists yet. The first one becomes the admin. Paste the setup token from the
				<span class="mono">setup-token</span> file in the server's state directory (the server log says
				where).
			</p>
		{/if}

		<form class="auth-form" onsubmit={submit}>
			{#if mode !== 'sign-in'}
				<label class="field">
					<span class="lbl">Name</span>
					<input class="input" bind:value={name} autocomplete="name" required maxlength={100} />
				</label>
			{/if}
			<label class="field">
				<span class="lbl">Email</span>
				<input
					class="input"
					type="email"
					bind:value={email}
					autocomplete={mode === 'sign-in' ? 'username' : 'email'}
					required
					maxlength={254}
				/>
			</label>
			<label class="field">
				<span class="lbl">Password</span>
				<input
					class="input"
					type="password"
					bind:value={password}
					autocomplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
					required
					minlength={mode === 'sign-in' ? undefined : data.min_password_length}
					maxlength={128}
				/>
				{#if mode !== 'sign-in'}
					<span class="hint">At least {data.min_password_length} characters.</span>
				{/if}
			</label>
			{#if mode === 'bootstrap'}
				<label class="field">
					<span class="lbl">Setup token</span>
					<input
						class="input mono"
						bind:value={setup_token}
						autocomplete="off"
						spellcheck="false"
						required
					/>
				</label>
			{/if}

			{#if error}
				<p class="auth-error" role="alert">{error}</p>
			{/if}

			<button class="btn btn-primary auth-submit" type="submit" disabled={busy}>
				{#if busy}
					Working…
				{:else if mode === 'sign-in'}
					Sign in
				{:else}
					Create account
				{/if}
			</button>
		</form>

		{#if data.signup_open && mode === 'sign-in'}
			<p class="hint auth-switch">
				No account? <button class="link" type="button" onclick={() => choose('sign-up')}
					>Create one</button
				>
			</p>
		{:else if mode === 'sign-up'}
			<p class="hint auth-switch">
				Have an account? <button class="link" type="button" onclick={() => choose('sign-in')}
					>Sign in</button
				>
			</p>
		{/if}
	</div>
</main>

<style>
	.auth {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		padding: 24px 16px;
	}
	.auth-card {
		width: min(400px, 100%);
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.auth-brand {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.auth-title {
		margin: 0;
	}
	.auth-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.auth-submit {
		justify-content: center;
	}
	.auth-error {
		margin: 0;
		color: var(--danger-tx);
	}
	.auth-switch {
		margin: 0;
	}
	.link {
		background: none;
		border: 0;
		padding: 0;
		color: inherit;
		text-decoration: underline;
		cursor: pointer;
		font: inherit;
	}
	.mono {
		font-family: var(--font-mono, monospace);
	}
</style>
