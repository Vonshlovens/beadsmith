<script lang="ts">
	/**
	 * Console Accounts panel (ADR-0011): who can sign in, their roles, and
	 * whether strangers may sign up. New accounts get an initial password from
	 * the admin (there is no email invite yet); a reset password signs the
	 * account out everywhere. The server keeps at least one admin.
	 */
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { api, errorMessage } from '$lib/client/api';
	import { currentViewer } from '$lib/client/projects.svelte';
	import { relativeLong } from '$lib/client/format';
	import type { AccountRole, AccountsResponse } from '$lib/types';

	let state_ = $state<AccountsResponse | null>(null);
	let load_error = $state<string | null>(null);
	let busy = $state(false);

	let email = $state('');
	let name = $state('');
	let role = $state<AccountRole>('member');
	let password = $state('');
	/** Account whose password-reset row is open, and the new password. */
	let resetting = $state<string | null>(null);
	let reset_password = $state('');

	const viewer = $derived(currentViewer());

	async function load(): Promise<void> {
		try {
			state_ = await api.accounts();
			load_error = null;
		} catch (error) {
			load_error = errorMessage(error);
		}
	}

	onMount(() => void load());

	/**
	 * Run one change, report it, and reload the list.
	 * @param action - The API call.
	 * @param success - Toast copy on success.
	 */
	async function change(action: () => Promise<unknown>, success: string): Promise<boolean> {
		if (busy) return false;
		busy = true;
		try {
			await action();
			toast.success(success);
			await load();
			return true;
		} catch (error) {
			toast.error('Account change failed', { description: errorMessage(error) });
			return false;
		} finally {
			busy = false;
		}
	}

	async function create(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const created = await change(
			() => api.createAccount({ email: email.trim(), name: name.trim(), role, password }),
			`Created ${email.trim()}`
		);
		if (created) {
			email = '';
			name = '';
			role = 'member';
			password = '';
		}
	}

	function setRole(user_id: string, next: AccountRole, label: string): void {
		void change(() => api.updateAccount(user_id, { role: next }), `${label} is now ${next}`);
	}

	function openReset(user_id: string): void {
		resetting = resetting === user_id ? null : user_id;
		reset_password = '';
	}

	async function resetPassword(event: SubmitEvent, user_id: string, label: string): Promise<void> {
		event.preventDefault();
		const next = reset_password;
		const done = await change(
			() => api.updateAccount(user_id, { password: next }),
			`Password reset for ${label}`
		);
		if (done) {
			resetting = null;
			reset_password = '';
		}
	}

	function remove(user_id: string, label: string): void {
		if (!window.confirm(`Remove ${label}? They are signed out and cannot sign in again.`)) return;
		void change(() => api.removeAccount(user_id), `Removed ${label}`);
	}

	function toggleSignup(open: boolean): void {
		void change(
			() => api.setSignupOpen(open),
			open ? 'Sign-up is open to anyone with the URL' : 'Sign-up is closed'
		);
	}
</script>

<div class="panel card-pad">
	{#if load_error && !state_}
		<p class="hint" role="alert">Accounts could not be loaded: {load_error}</p>
	{:else if state_}
		<div class="accounts">
			<label class="check">
				<input
					type="checkbox"
					checked={state_.signup_open}
					disabled={busy}
					onchange={(event) => toggleSignup(event.currentTarget.checked)}
				/>
				<span>Anyone with the URL may create a member account</span>
			</label>

			<div class="tbl-scroll">
				<table class="tbl">
					<thead>
						<tr><th>Account</th><th>Role</th><th>Created</th><th></th></tr>
					</thead>
					<tbody>
						{#each state_.users as user (user.id)}
							{@const self = user.email === viewer?.email}
							<tr>
								<td>
									<div>
										{user.name}{#if self}<span class="faint"> · you</span>{/if}
									</div>
									<div class="faint mono">{user.email}</div>
								</td>
								<td
									>{user.role}{#if user.banned}<span class="faint"> · disabled</span>{/if}</td
								>
								<td>{relativeLong(user.created_at)}</td>
								<td class="row-acts">
									{#if self}
										<a class="btn btn-sm" href="/account">Change password</a>
									{:else}
										<button
											class="btn btn-sm"
											type="button"
											disabled={busy}
											onclick={() =>
												setRole(user.id, user.role === 'admin' ? 'member' : 'admin', user.email)}
										>
											{user.role === 'admin' ? 'Make member' : 'Make admin'}
										</button>
										<button
											class="btn btn-sm"
											type="button"
											disabled={busy}
											aria-expanded={resetting === user.id}
											onclick={() => openReset(user.id)}>Reset password</button
										>
										<button
											class="btn btn-sm btn-danger"
											type="button"
											disabled={busy}
											onclick={() => remove(user.id, user.email)}>Remove</button
										>
									{/if}
								</td>
							</tr>
							{#if resetting === user.id}
								<tr>
									<td colspan="4">
										<form
											class="reset"
											onsubmit={(event) => resetPassword(event, user.id, user.email)}
										>
											<label class="field">
												<span class="lbl">New password for {user.email}</span>
												<input
													class="input"
													type="password"
													bind:value={reset_password}
													autocomplete="new-password"
													required
													minlength={state_.min_password_length}
													maxlength={128}
												/>
											</label>
											<button class="btn btn-sm btn-primary" type="submit" disabled={busy}
												>Set password</button
											>
											<span class="hint">Signs them out everywhere.</span>
										</form>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>

			<form class="create" onsubmit={create}>
				<span class="lbl">Add an account</span>
				<div class="grid">
					<label class="field">
						<span class="lbl">Name</span>
						<input class="input" bind:value={name} required maxlength={100} />
					</label>
					<label class="field">
						<span class="lbl">Email</span>
						<input class="input" type="email" bind:value={email} required maxlength={254} />
					</label>
					<label class="field">
						<span class="lbl">Role</span>
						<select class="select" bind:value={role}>
							<option value="member">member (read)</option>
							<option value="admin">admin (console, agents)</option>
						</select>
					</label>
					<label class="field">
						<span class="lbl">Initial password</span>
						<input
							class="input"
							type="password"
							bind:value={password}
							autocomplete="new-password"
							required
							minlength={state_.min_password_length}
							maxlength={128}
						/>
					</label>
				</div>
				<p class="hint">
					Send the password to them yourself; they can change it under Account after signing in.
				</p>
				<div>
					<button class="btn btn-sm btn-primary" type="submit" disabled={busy}>Add account</button>
				</div>
			</form>
		</div>
	{:else}
		<p class="hint">Loading accounts…</p>
	{/if}
</div>

<style>
	.accounts {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.create {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 12px;
	}
	.reset {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 10px;
	}
	.row-acts {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		justify-content: flex-end;
	}
	.mono {
		font-family: var(--font-mono, monospace);
	}
</style>
