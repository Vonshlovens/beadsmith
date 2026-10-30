<script lang="ts">
	/**
	 * Issue-detail composer: enqueue a /comment agent.
	 * The web process does not write Beads comment rows itself.
	 */
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { api, errorMessage } from '$lib/client/api';
	import type { DispatchRequest } from '$lib/types';

	let {
		project_id,
		issue_id,
		known_comment_ids = []
	}: {
		project_id: string;
		issue_id: string;
		known_comment_ids?: string[];
	} = $props();

	let text = $state('');
	let submitting = $state(false);
	let pending_text = $state<string | null>(null);

	function announce(request: DispatchRequest) {
		if (request.status === 'failed') {
			toast.error('The comment agent did not start', {
				description: request.error_message ?? request.id
			});
			return;
		}
		const url = request.agent_url;
		toast.success('Comment agent launched', {
			description: 'It will store this on the Beads issue.',
			action:
				url === undefined
					? undefined
					: {
							label: 'Open',
							onClick: () => {
								window.open(url, '_blank', 'noopener');
							}
						}
		});
	}

	async function waitForComment(expected: string, known: Set<string>) {
		const deadline = Date.now() + 180_000;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 4000));
			try {
				const detail = await api.issue(project_id, issue_id);
				if (
					detail.issue.comments.some(
						(comment) => comment.text === expected && !known.has(comment.id)
					)
				) {
					pending_text = null;
					await invalidateAll();
					toast.success('Comment added');
					return;
				}
			} catch {
				/* keep waiting; the agent may still be writing */
			}
		}
		toast.message('Still waiting for the comment to land. Refresh in a minute.');
	}

	async function submit() {
		const body = text.trim();
		if (submitting || body.length === 0) {
			return;
		}
		submitting = true;
		try {
			const result = await api.commentIssue(project_id, {
				idempotency_key: crypto.randomUUID(),
				issue_id,
				text: body
			});
			announce(result.request);
			if (result.request.status === 'failed') {
				return;
			}
			text = '';
			pending_text = body;
			void waitForComment(body, new Set(known_comment_ids));
		} catch (error) {
			toast.error('Could not launch the comment agent', { description: errorMessage(error) });
		} finally {
			submitting = false;
		}
	}

	function onSubmit(event: SubmitEvent) {
		event.preventDefault();
		void submit();
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void submit();
		}
	}
</script>

{#if pending_text}
	<div class="cmt pending" aria-live="polite">
		<div class="av" aria-hidden="true">…</div>
		<div class="cmt-bd">
			<div class="cmt-hd">
				<b>Posting</b>
				<span class="t">waiting for the Beads comment to land</span>
			</div>
			<p class="pending-text">{pending_text}</p>
		</div>
	</div>
{/if}

<form class="composer" onsubmit={onSubmit}>
	<label class="lbl" for="cmt-new">Add a comment</label>
	<textarea
		id="cmt-new"
		bind:value={text}
		maxlength={8000}
		rows={3}
		placeholder="Markdown. Mention an issue by id to link it."
		disabled={submitting}
		onkeydown={onKeydown}></textarea>
	<div class="composer-ft">
		<span
			class="xs faint"
			title="An agent stores this on the Beads issue; Beadsmith stays read-only."
			>Posted by an agent</span
		>
		<span class="spacer"></span>
		<span class="xs faint"><span class="kbd">⌘⏎</span> to post</span>
		<button
			class="btn btn-sm btn-primary"
			type="submit"
			disabled={submitting || text.trim().length === 0}
		>
			{submitting ? 'Launching…' : 'Post comment'}
		</button>
	</div>
</form>

<style>
	.composer {
		border: 1px solid var(--line);
		border-radius: var(--r-2);
		background: var(--s2);
		padding: var(--s-3);
		margin-top: var(--s-4);
	}
	.composer:focus-within {
		border-color: var(--line-2);
	}
	.composer textarea {
		background: none;
		border: 0;
		width: 100%;
		resize: vertical;
		outline: none;
		font-size: var(--t-sm);
		line-height: 1.6;
		min-height: 54px;
		color: var(--tx-hi);
		margin-top: 6px;
	}
	.composer textarea::placeholder {
		color: var(--tx-faint);
	}
	.composer-ft {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		border-top: 1px solid var(--line);
		margin-top: var(--s-3);
		padding-top: var(--s-3);
		flex-wrap: wrap;
	}
	.spacer {
		flex: 1;
	}
	.pending {
		display: flex;
		gap: var(--s-3);
		padding: var(--s-4) 0;
		border-bottom: 1px solid var(--line);
		opacity: 0.72;
	}
	.pending-text {
		font-size: 13px;
		white-space: pre-wrap;
		margin: 0;
		color: var(--tx);
	}
	.av {
		width: 26px;
		height: 26px;
		flex: none;
		border-radius: var(--r-1);
		background: var(--s3);
		border: 1px solid var(--line-2);
		display: grid;
		place-items: center;
		font-size: var(--t-micro);
		color: var(--tx-mid);
		font-weight: 600;
	}
	.cmt-bd {
		flex: 1;
		min-width: 0;
	}
	.cmt-hd {
		display: flex;
		align-items: baseline;
		gap: var(--s-2);
		margin-bottom: 5px;
		font-size: var(--t-xs);
	}
	.cmt-hd b {
		color: var(--tx-hi);
		font-weight: 600;
	}
	.cmt-hd .t {
		color: var(--tx-faint);
	}
</style>
