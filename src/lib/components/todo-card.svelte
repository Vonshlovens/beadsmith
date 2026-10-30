<script lang="ts">
	/**
	 * One todo card: complete toggle, title, priority chip,
	 * due label, tags, derived urgency bar, and an expandable panel for
	 * reschedule or the comment thread. The `actions` snippet sits beside the
	 * built-in buttons so the routing action can plug in.
	 */
	import type { Snippet } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import CheckIcon from '@lucide/svelte/icons/check';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import SendIcon from '@lucide/svelte/icons/send';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import MissionStatus from '$lib/components/mission-status.svelte';
	import PriorityChip from '$lib/components/priority-chip.svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { api, errorMessage } from '$lib/client/api';
	import { relativeShort } from '$lib/client/format';
	import { dur, expand } from '$lib/client/motion';
	import { projectList } from '$lib/client/projects.svelte';
	import type { Todo, TodoComment } from '$lib/server/todos/store';
	import { addDays, dueLabel, nextWeekday, toDateOnly } from '$lib/todos/dates';
	import { dueBucket, urgency, urgencyRatio } from '$lib/todos/urgency';
	import type { DispatchRequest } from '$lib/types';

	interface Props {
		todo: Todo;
		now: Date;
		oncomplete: (todo: Todo) => void;
		onpriority: (todo: Todo, priority: number) => void;
		onreschedule: (todo: Todo, due_at: string | null) => void;
		onarchive: (todo: Todo) => void;
		oncomments: (todo: Todo, count: number) => void;
		/** Open the route-to-project dialog for this todo. */
		onroute: (todo: Todo) => void;
		/** The routed todo as the server now has it (a bead id arrived). */
		onrouted: (todo: Todo) => void;
		/** Extra per-card actions (routing lands here). */
		actions?: Snippet<[Todo]>;
	}

	let {
		todo,
		now,
		oncomplete,
		onpriority,
		onreschedule,
		onarchive,
		oncomments,
		onroute,
		onrouted,
		actions
	}: Props = $props();

	type Panel = 'none' | 'reschedule' | 'comments';
	let panel = $state<Panel>('none');
	let completing = $state(false);
	let comments = $state<TodoComment[] | null>(null);
	let draft = $state('');
	let posting = $state(false);
	let date_value = $state('');

	const done = $derived(todo.status === 'done');
	const score = $derived(urgency(todo.priority, todo.due_at, now));
	const ratio = $derived(done ? 0 : urgencyRatio(score));
	const bucket = $derived(dueBucket(todo.due_at, now));
	const due_text = $derived(todo.due_at ? dueLabel(todo.due_at, now) : '');
	const checked = $derived(done || completing);

	let route_request = $state<DispatchRequest | null>(null);
	const routed = $derived(todo.routed_dispatch_id !== null && todo.routed_project_id !== null);
	const route_project = $derived(
		projectList().find((project) => project.id === todo.routed_project_id)
	);
	const route_name = $derived(route_project?.name ?? todo.routed_project_id ?? '');
	const route_failed = $derived(
		route_request?.status === 'failed' || route_request?.status === 'cancelled'
	);

	// Follow the dispatch until it ends; the server links the bead when the runner reports it.
	$effect(() => {
		const dispatch_id = todo.routed_dispatch_id;
		if (dispatch_id === null) {
			route_request = null;
			return;
		}
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			try {
				const result = await api.todoRoute(todo.id);
				if (stopped || result.todo.routed_dispatch_id !== dispatch_id) {
					return;
				}
				route_request = result.request;
				if (result.todo.routed_issue_id !== todo.routed_issue_id) {
					onrouted(result.todo);
				}
				const ended = ['succeeded', 'cancelled', 'failed'].includes(result.request?.status ?? '');
				if (!ended) {
					timer = setTimeout(poll, 6000);
				}
			} catch {
				if (!stopped) {
					timer = setTimeout(poll, 15000);
				}
			}
		};
		void poll();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	});

	function toggle(next: Panel) {
		panel = panel === next ? 'none' : next;
		if (panel === 'comments' && comments === null) {
			void loadComments();
		}
		if (panel === 'reschedule') {
			date_value = todo.due_at?.slice(0, 10) ?? '';
		}
	}

	async function loadComments() {
		try {
			comments = (await api.todoComments(todo.id)).comments;
		} catch (error) {
			comments = [];
			toast.error('Could not load comments', { description: errorMessage(error) });
		}
	}

	async function postComment() {
		const text = draft.trim();
		if (text === '' || posting) {
			return;
		}
		posting = true;
		try {
			const { comment } = await api.addTodoComment(todo.id, text);
			comments = [...(comments ?? []), comment];
			draft = '';
			oncomments(todo, comments.length);
		} catch (error) {
			toast.error('Could not add comment', { description: errorMessage(error) });
		} finally {
			posting = false;
		}
	}

	async function deleteComment(comment: TodoComment) {
		const before = comments ?? [];
		comments = before.filter((item) => item.id !== comment.id);
		oncomments(todo, comments.length);
		try {
			await api.deleteTodoComment(todo.id, comment.id);
		} catch (error) {
			comments = before;
			oncomments(todo, before.length);
			toast.error('Could not delete the comment', { description: errorMessage(error) });
		}
	}

	/** Let the check pop and the title strike before the card leaves its column. */
	function complete() {
		if (done) {
			oncomplete(todo);
			return;
		}
		completing = true;
		setTimeout(() => oncomplete(todo), dur(320));
	}

	function reschedule(due_at: string | null) {
		onreschedule(todo, due_at);
		panel = 'none';
	}

	const presets = $derived([
		{ label: 'Today', value: toDateOnly(now) },
		{ label: 'Tomorrow', value: toDateOnly(addDays(now, 1)) },
		{ label: 'Next week', value: toDateOnly(nextWeekday(now, 1)) },
		{ label: 'In a month', value: toDateOnly(addDays(now, 30)) }
	]);
</script>

<article
	class="tc"
	class:is-done={done}
	class:is-completing={completing}
	data-bucket={bucket}
	data-todo-id={todo.id}
>
	<div class="tc-main">
		<button
			class="tc-check"
			class:is-checked={checked}
			type="button"
			role="checkbox"
			aria-checked={checked}
			aria-label={done ? `Reopen ${todo.title}` : `Complete ${todo.title}`}
			onclick={complete}
		>
			{#if checked}
				<span class="tc-pop"><CheckIcon size={12} strokeWidth={2.4} /></span>
			{/if}
		</button>

		<div class="tc-body">
			<div class="tc-title">{todo.title}</div>
			<div class="tc-meta">
				<DropdownMenu.Root>
					<DropdownMenu.Trigger class="tc-chipbtn" aria-label="Change priority">
						<PriorityChip priority={todo.priority} />
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="start">
						{#each [0, 1, 2, 3, 4] as p (p)}
							<DropdownMenu.Item onSelect={() => onpriority(todo, p)}>
								<PriorityChip priority={p} />
								{p === todo.priority ? 'current' : ''}
							</DropdownMenu.Item>
						{/each}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
				{#if todo.due_at}
					<span class="tc-due tc-due-{bucket}">{due_text}</span>
				{/if}
				{#each todo.tags as tag (tag)}
					<span class="tc-tag">{tag}</span>
				{/each}
			</div>
			{#if routed}
				<div class="tc-routed" transition:expand={{ duration: 160 }}>
					<span class="tc-quiet">routed →</span>
					<a class="tc-route-project" href="/p/{todo.routed_project_id}">{route_name}</a>
					{#if todo.routed_issue_id}
						<a
							class="tc-route-issue mono-num"
							href="/p/{todo.routed_project_id}/i/{todo.routed_issue_id}"
						>
							{todo.routed_issue_id}
						</a>
					{:else if route_request}
						<MissionStatus status={route_request.status} />
						{#if !route_failed && route_request.status !== 'succeeded'}
							<span class="tc-quiet">pending</span>
						{/if}
					{:else}
						<span class="tc-quiet">pending</span>
					{/if}
					{#if route_request?.agent_url}
						<a class="tc-quiet" href={route_request.agent_url} target="_blank" rel="noopener">
							agent
						</a>
					{/if}
				</div>
			{/if}
		</div>

		<div class="tc-actions">
			<button
				class="btn btn-sm btn-ghost btn-icon"
				class:is-on={panel === 'reschedule'}
				type="button"
				aria-label="Reschedule"
				aria-expanded={panel === 'reschedule'}
				title="Reschedule"
				onclick={() => toggle('reschedule')}
			>
				<CalendarIcon size={14} strokeWidth={1.4} />
			</button>
			<button
				class="btn btn-sm btn-ghost tc-comment"
				class:is-on={panel === 'comments'}
				type="button"
				aria-label="Comments ({todo.comment_count})"
				aria-expanded={panel === 'comments'}
				title="Comments"
				onclick={() => toggle('comments')}
			>
				<MessageSquareIcon size={14} strokeWidth={1.4} />
				{#if todo.comment_count > 0}<span class="mono-num">{todo.comment_count}</span>{/if}
			</button>
			<button
				class="btn btn-sm btn-ghost btn-icon"
				type="button"
				aria-label={routed && !route_failed ? 'Routed to a project' : 'Route to project…'}
				title={routed && !route_failed ? 'Already routed' : 'Route to project… (r)'}
				disabled={routed && !route_failed}
				onclick={() => onroute(todo)}
			>
				<SendIcon size={14} strokeWidth={1.4} />
			</button>
			{@render actions?.(todo)}
			<button
				class="btn btn-sm btn-ghost btn-icon"
				type="button"
				aria-label="Archive"
				title="Archive"
				onclick={() => onarchive(todo)}
			>
				<ArchiveIcon size={14} strokeWidth={1.4} />
			</button>
		</div>
	</div>

	{#if panel === 'reschedule'}
		<div class="tc-panel" transition:expand>
			<div class="tc-presets">
				{#each presets as preset (preset.label)}
					<button class="btn btn-sm" type="button" onclick={() => reschedule(preset.value)}>
						{preset.label}
					</button>
				{/each}
				<input
					class="input tc-date"
					type="date"
					aria-label="Pick a due date"
					bind:value={date_value}
					onchange={() => date_value !== '' && reschedule(date_value)}
				/>
				{#if todo.due_at}
					<button class="btn btn-sm btn-ghost" type="button" onclick={() => reschedule(null)}>
						Clear date
					</button>
				{/if}
			</div>
		</div>
	{:else if panel === 'comments'}
		<div class="tc-panel" transition:expand>
			<div class="tc-thread">
				{#if comments === null}
					<p class="tc-quiet">Loading…</p>
				{:else if comments.length === 0}
					<p class="tc-quiet">No comments yet.</p>
				{/if}
				{#each comments ?? [] as comment (comment.id)}
					<div class="tc-comment-row" transition:expand={{ duration: 160 }}>
						<div class="tc-comment-head">
							<span class="tc-quiet">{comment.author} · {relativeShort(comment.created_at)}</span>
							<button
								class="tc-comment-del"
								type="button"
								aria-label="Delete comment"
								title="Delete comment"
								onclick={() => deleteComment(comment)}
							>
								<Trash2Icon size={12} strokeWidth={1.4} />
							</button>
						</div>
						<p>{comment.text}</p>
					</div>
				{/each}
				<form
					class="tc-compose"
					onsubmit={(event) => {
						event.preventDefault();
						void postComment();
					}}
				>
					<input
						class="input"
						type="text"
						placeholder="Add a comment"
						aria-label="Add a comment"
						maxlength="4000"
						bind:value={draft}
					/>
					<button class="btn btn-sm" type="submit" disabled={posting || draft.trim() === ''}>
						Post
					</button>
				</form>
			</div>
		</div>
	{/if}

	<div class="tc-urg" aria-hidden="true" title="Urgency {score} of 7">
		<div class="tc-urg-fill" style:width="{ratio * 100}%"></div>
	</div>
</article>

<style>
	.tc {
		position: relative;
		background: var(--s2);
		border: 1px solid var(--line);
		border-radius: var(--r-2);
		overflow: hidden;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			opacity 0.2s ease;
	}
	.tc:hover,
	.tc:focus-within {
		border-color: var(--line-3);
		background: var(--s3);
	}
	.tc.is-done,
	.tc.is-completing {
		opacity: 0.6;
	}
	.tc-main {
		display: flex;
		align-items: flex-start;
		gap: var(--s-3);
		padding: var(--s-3) var(--s-3) var(--s-3) var(--s-3);
	}
	.tc-check {
		flex: none;
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		margin-top: 1px;
		padding: 0;
		border: 1px solid var(--line-3);
		border-radius: var(--r-1);
		background: var(--s1);
		color: var(--on-em);
		cursor: pointer;
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			transform 0.12s ease;
	}
	.tc-check:hover {
		border-color: var(--em-500);
	}
	.tc-check:active {
		transform: scale(0.9);
	}
	.tc-check.is-checked {
		background: var(--em-600);
		border-color: var(--em-500);
	}
	.tc-pop {
		display: grid;
		animation: tc-pop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	@keyframes tc-pop {
		from {
			transform: scale(0);
		}
		to {
			transform: scale(1);
		}
	}
	.tc-body {
		flex: 1;
		min-width: 0;
	}
	.tc-title {
		color: var(--tx-hi);
		font-size: var(--t-base);
		line-height: 1.45;
		overflow-wrap: anywhere;
		background-image: linear-gradient(currentColor, currentColor);
		background-repeat: no-repeat;
		background-position: 0 55%;
		background-size: 0% 1px;
		transition: background-size 0.3s ease;
	}
	.is-done .tc-title,
	.is-completing .tc-title {
		color: var(--tx-dim);
		background-size: 100% 1px;
	}
	.tc-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
		margin-top: var(--s-2);
	}
	.tc-meta :global(.tc-chipbtn) {
		display: inline-flex;
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
		border-radius: var(--r-1);
	}
	.tc-due {
		font-size: var(--t-micro);
		letter-spacing: 0.04em;
		color: var(--tx-mid);
	}
	.tc-due-overdue {
		color: var(--em-300);
		font-weight: 600;
	}
	.tc-due-today {
		color: var(--tx-hi);
		font-weight: 600;
	}
	.tc-tag {
		font-size: var(--t-micro);
		color: var(--cyan-tx);
	}
	.tc-routed {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
		margin-top: var(--s-2);
		font-size: var(--t-micro);
	}
	.tc-route-project,
	.tc-route-issue {
		color: var(--tx-hi);
		text-decoration: none;
	}
	.tc-route-issue {
		color: var(--em-300);
	}
	.tc-route-project:hover,
	.tc-route-issue:hover {
		text-decoration: underline;
	}
	.tc-actions {
		display: flex;
		align-items: center;
		gap: 2px;
		flex: none;
		margin: -4px -6px 0 0;
		opacity: 0.55;
		transition: opacity 0.15s ease;
	}
	.tc:hover .tc-actions,
	.tc:focus-within .tc-actions {
		opacity: 1;
	}
	@media (hover: none) {
		.tc-actions {
			opacity: 1;
		}
	}
	.tc-actions :global(.is-on) {
		color: var(--tx-hi);
		background: var(--s4);
	}
	.tc-comment {
		gap: 4px;
		padding: 0 7px;
		font-size: var(--t-micro);
	}
	.tc-panel {
		border-top: 1px solid var(--line);
		background: var(--s1);
	}
	.tc-presets,
	.tc-thread {
		display: flex;
		padding: var(--s-3);
	}
	.tc-presets {
		flex-wrap: wrap;
		gap: var(--s-2);
	}
	.tc-date {
		width: auto;
		min-width: 0;
	}
	.tc-thread {
		flex-direction: column;
		gap: var(--s-2);
	}
	.tc-comment-row p {
		margin: 2px 0 0;
		font-size: var(--t-sm);
		color: var(--tx);
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	.tc-comment-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-2);
	}
	.tc-comment-del {
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		padding: 0;
		border: 0;
		border-radius: var(--r-1);
		background: none;
		color: var(--tx-faint);
		cursor: pointer;
		opacity: 0;
		transition:
			opacity 0.15s ease,
			color 0.15s ease;
	}
	.tc-comment-row:hover .tc-comment-del,
	.tc-comment-del:focus-visible {
		opacity: 1;
	}
	.tc-comment-del:hover {
		color: var(--danger-tx);
	}
	@media (hover: none) {
		.tc-comment-del {
			opacity: 1;
		}
	}
	.tc-quiet {
		margin: 0;
		font-size: var(--t-micro);
		color: var(--tx-faint);
	}
	.tc-compose {
		display: flex;
		gap: var(--s-2);
	}
	.tc-urg {
		height: 2px;
		background: var(--line);
	}
	.tc-urg-fill {
		height: 100%;
		background: var(--em-500);
		transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
	}
</style>
