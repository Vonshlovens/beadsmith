import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueDetail, Project } from '#lib/types.js';
import { readEnv } from '../env.js';
import { initStateSchema } from '../state/db.js';
import {
	COMMENT_NOT_ALLOWED_MESSAGE,
	DISARMED_DISPATCH_MESSAGE,
	ELABORATE_NOT_ALLOWED_MESSAGE,
	FILE_NOT_ALLOWED_MESSAGE,
	LOOP_NOT_ALLOWED_MESSAGE,
	TACKLE_NOT_ALLOWED_MESSAGE
} from './policy.js';
import {
	EFFORT_NOT_OFFERED_MESSAGE,
	MODEL_NOT_OFFERED_MESSAGE,
	MODELS_NOT_SUPPORTED_MESSAGE
} from './agent-choice.js';
import { INVALID_FILE_CHECKOUT_MESSAGE } from './file-maps.js';
import type { AgentLaunchInput, AgentLoopLaunchInput, AgentProvider } from './provider.js';
import type { RalphIteration } from './ralph.js';
import { INVALID_TACKLE_MAPPING_MESSAGE, UNMAPPED_TACKLE_MESSAGE } from './repositories.js';
import {
	cancelDispatch,
	enqueueDispatch,
	followUpDispatch,
	getDispatch,
	listDispatchTurns,
	listLoopIterations,
	listMissions,
	restartDispatch,
	steerDispatch,
	stopDispatchAfterIteration,
	streamDispatchMissionEvents,
	toPublicDispatch,
	toPublicMission,
	AGENT_BUSY_MESSAGE,
	LOOP_FOLLOW_UP_MESSAGE,
	LOOP_NOT_RUNNING_MESSAGE,
	LOOP_NOT_SUPPORTED_MESSAGE,
	LOOP_STILL_RUNNING_MESSAGE,
	MISSION_NOT_LAUNCHED_MESSAGE,
	NOT_A_LOOP_MESSAGE,
	RESTART_NOT_A_LOOP_MESSAGE
} from './service.js';
import { createDispatchStore } from './store.js';
import { DispatchError } from './types.js';
import { createWebhookProvider } from './webhook-provider.js';

const PROJECT: Project = {
	id: 'd_beads_web',
	name: 'beads_web',
	state: 'remote',
	dolt_database: 'beads_web',
	backend: 'server-sql',
	readonly: true
};

const OTHER_PROJECT: Project = {
	...PROJECT,
	id: 'd_other',
	name: 'other',
	dolt_database: 'other'
};

const ISSUE: IssueDetail = {
	id: 'beads-web-1',
	title: 'Map repos',
	status: 'open',
	priority: 1,
	issue_type: 'feature',
	labels: [],
	created_at: '2026-08-16T00:00:00.000Z',
	updated_at: '2026-08-16T00:00:00.000Z',
	dependency_count: 0,
	dependent_count: 0,
	comment_count: 0,
	description: 'Use the mapped checkout.',
	dependencies: [],
	dependents: [],
	comments: []
};

const BEADS_WEB_MAP = {
	d_beads_web: {
		url: 'https://github.com/example-org/beads-web',
		ref: 'main',
		auto_create_pr: true
	}
};

const ALLOW_ALL = { armed: true, allow: { file: true, tackle: true } };

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createDispatchStore(client);
});

let store: ReturnType<typeof createDispatchStore>;

const NO_BACKGROUND = () => {};

function providerWithLaunch(launch: AgentProvider['launch']): AgentProvider {
	return {
		id: 'webhook',
		label: 'Webhook agent runner',
		launch,
		getLatestRunId: vi.fn(async () => undefined),
		getRun: vi.fn(async () => ({ status: 'running' as const })),
		createRun: vi.fn(async () => ({ run_id: 'run-follow' })),
		cancelRun: vi.fn(async () => undefined),
		streamRun: vi.fn(async () => 'disconnected' as const),
		streamMissionEvents: vi.fn(async () => 'disconnected' as const)
	};
}

describe('enqueueDispatch', () => {
	it('refuses to launch when dispatch is not configured', async () => {
		await expect(
			enqueueDispatch(
				{
					idempotency_key: 'idem-aaaaaaaa',
					project: PROJECT,
					actor: 'web',
					payload: { operation: 'file', notes: 'notes' }
				},
				{ store, configured: false, policy: ALLOW_ALL }
			)
		).rejects.toBeInstanceOf(DispatchError);
	});

	it('persists then launches and returns the public record', async () => {
		const provider = providerWithLaunch(
			vi.fn(async () => ({
				agent_id: 'bc-9',
				agent_url: 'https://runner.example.com/agents/bc-9',
				run_id: 'run-9'
			}))
		);

		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-aaaaaaaa',
				project: PROJECT,
				actor: 'web',
				payload: { operation: 'file', notes: 'File the bug.' }
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				schedule_background: NO_BACKGROUND
			}
		);

		expect(result.created).toBe(true);
		expect(result.request).toMatchObject({
			operation: 'file',
			status: 'launched',
			agent_id: 'bc-9',
			agent_url: 'https://runner.example.com/agents/bc-9'
		});
		expect(result.request).not.toHaveProperty('payload');
		expect(result.request).not.toHaveProperty('actor');
		expect(provider.launch).toHaveBeenCalledOnce();
	});

	it('does not launch a second agent for an idempotent replay', async () => {
		const provider = providerWithLaunch(
			vi.fn(async () => ({
				agent_id: 'bc-9',
				agent_url: 'https://runner.example.com/agents/bc-9'
			}))
		);
		const input = {
			idempotency_key: 'idem-aaaaaaaa',
			project: PROJECT,
			actor: 'web',
			payload: { operation: 'file' as const, notes: 'File the bug.' }
		};

		await enqueueDispatch(input, {
			store,
			provider,
			configured: true,
			policy: ALLOW_ALL,
			schedule_background: NO_BACKGROUND
		});
		const replay = await enqueueDispatch(input, {
			store,
			provider,
			configured: true,
			policy: ALLOW_ALL,
			schedule_background: NO_BACKGROUND
		});

		expect(replay.created).toBe(false);
		expect(provider.launch).toHaveBeenCalledOnce();
	});

	it('records a failed launch without throwing', async () => {
		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-aaaaaaaa',
				project: PROJECT,
				actor: 'web',
				payload: { operation: 'file', notes: 'File the bug.' }
			},
			{
				store,
				configured: true,
				policy: ALLOW_ALL,
				provider: providerWithLaunch(async () => {
					throw new DispatchError('unavailable', 'The agent could not be launched.');
				}),
				schedule_background: NO_BACKGROUND
			}
		);

		expect(result.request.status).toBe('failed');
		expect(result.request.error_message).toBe('The agent could not be launched.');
	});

	it('does not pass a repository override when filing, even if a map exists', async () => {
		const provider = providerWithLaunch(
			vi.fn(async (input: AgentLaunchInput) => {
				expect(input.repository).toBeUndefined();
				expect(input.auto_create_pr).toBe(false);
				return { agent_id: 'bc-file' };
			})
		);

		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-filemap01',
				project: OTHER_PROJECT,
				actor: 'web',
				payload: { operation: 'file', notes: 'File this in beads-web.' }
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				schedule_background: NO_BACKGROUND,
				repositories: {
					d_other: {
						url: 'https://github.com/example-org/other',
						ref: 'develop',
						auto_create_pr: true
					}
				}
			}
		);

		expect(result.request.status).toBe('launched');
		expect(provider.launch).toHaveBeenCalledOnce();
	});

	it('still files when Tackle mapping configuration is invalid', async () => {
		const provider = providerWithLaunch(vi.fn(async () => ({ agent_id: 'bc-file-ok' })));

		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-filebad01',
				project: PROJECT,
				actor: 'web',
				payload: { operation: 'file', notes: 'File anyway.' }
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				schedule_background: NO_BACKGROUND,
				repositories_invalid: true
			}
		);

		expect(result.request.status).toBe('launched');
		expect(provider.launch).toHaveBeenCalledOnce();
	});

	it('files against a per-project File checkout with autoCreatePR false', async () => {
		const provider = providerWithLaunch(
			vi.fn(async (input: AgentLaunchInput) => {
				expect(input.auto_create_pr).toBe(false);
				expect(input.repository).toEqual({
					url: 'https://github.com/example-org/other',
					starting_ref: 'develop'
				});
				return { agent_id: 'bc-file-map' };
			})
		);

		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-filechk01',
				project: OTHER_PROJECT,
				actor: 'web',
				payload: { operation: 'file', notes: 'File this in other.' }
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				schedule_background: NO_BACKGROUND,
				file_maps: {
					d_other: {
						url: 'https://github.com/example-org/other',
						ref: 'develop'
					}
				},
				repositories: BEADS_WEB_MAP
			}
		);

		expect(result.request.status).toBe('launched');
		expect(provider.launch).toHaveBeenCalledOnce();
	});

	it('fails closed when a File checkout map is present but invalid', async () => {
		const provider = providerWithLaunch(vi.fn(async () => ({ agent_id: 'not-called' })));

		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-filebad02',
				project: OTHER_PROJECT,
				actor: 'web',
				payload: { operation: 'file', notes: 'Do not fall back.' }
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				schedule_background: NO_BACKGROUND,
				file_map_invalid: true,
				file_maps: {
					d_other: {
						url: 'https://github.com/example-org/other',
						ref: 'develop'
					}
				}
			}
		);

		expect(result.request.status).toBe('failed');
		expect(result.request.error_message).toBe(INVALID_FILE_CHECKOUT_MESSAGE);
		expect(JSON.stringify(result.request)).not.toContain('github.com');
		expect(provider.launch).not.toHaveBeenCalled();
	});

	it('does not use a File checkout when launching Tackle', async () => {
		const provider = providerWithLaunch(
			vi.fn(async (input: AgentLaunchInput) => {
				expect(input.auto_create_pr).toBe(false);
				expect(input.repository).toEqual({
					url: 'https://github.com/example-org/other',
					starting_ref: 'develop'
				});
				return {
					agent_id: 'bc-mapped',
					agent_url: 'https://runner.example.com/agents/bc-mapped'
				};
			})
		);

		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-tackle01',
				project: OTHER_PROJECT,
				actor: 'web',
				payload: { operation: 'tackle', issue_id: ISSUE.id },
				issue: ISSUE
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				schedule_background: NO_BACKGROUND,
				file_maps: {
					d_other: {
						url: 'https://github.com/example-org/file-only',
						ref: 'file-ref'
					}
				},
				repositories: {
					d_other: {
						url: 'https://github.com/example-org/other',
						ref: 'develop',
						auto_create_pr: false
					}
				}
			}
		);

		expect(result.request).toMatchObject({
			operation: 'tackle',
			status: 'launched',
			agent_id: 'bc-mapped'
		});
		expect(provider.launch).toHaveBeenCalledOnce();
	});

	it('launches a board defer without autoCreatePR even when the map wants a PR', async () => {
		const provider = providerWithLaunch(
			vi.fn(async (input: AgentLaunchInput) => {
				expect(input.auto_create_pr).toBe(false);
				expect(input.name).toBe(`Defer ${ISSUE.id}`);
				expect(input.prompt).toContain('--status=deferred');
				return {
					agent_id: 'bc-defer',
					agent_url: 'https://runner.example.com/agents/bc-defer'
				};
			})
		);

		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-defer0001',
				project: OTHER_PROJECT,
				actor: 'web',
				payload: {
					operation: 'tackle',
					issue_id: ISSUE.id,
					destination_status: 'deferred'
				},
				issue: ISSUE
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				schedule_background: NO_BACKGROUND,
				repositories: {
					d_other: {
						url: 'https://github.com/example-org/other',
						ref: 'develop',
						auto_create_pr: true
					}
				}
			}
		);

		expect(result.request.status).toBe('launched');
		expect(provider.launch).toHaveBeenCalledOnce();
	});

	it('launches Tackle from a console SQLite map when env has none', async () => {
		const provider = providerWithLaunch(
			vi.fn(async (input: AgentLaunchInput) => {
				expect(input.repository).toEqual({
					url: 'https://github.com/example-org/other',
					starting_ref: 'develop'
				});
				return { agent_id: 'bc-sqlite' };
			})
		);

		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-sqlite01',
				project: OTHER_PROJECT,
				actor: 'web',
				payload: { operation: 'tackle', issue_id: ISSUE.id },
				issue: ISSUE
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				schedule_background: NO_BACKGROUND,
				sqlite_maps: {
					d_other: {
						url: 'https://github.com/example-org/other',
						ref: 'develop',
						auto_create_pr: true
					}
				}
			}
		);

		expect(result.request.status).toBe('launched');
		expect(provider.launch).toHaveBeenCalledOnce();
	});

	it('fails closed when Tackle has no mapping instead of launching this repo', async () => {
		const provider = providerWithLaunch(vi.fn(async () => ({ agent_id: 'not-called' })));

		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-nomap0001',
				project: OTHER_PROJECT,
				actor: 'web',
				payload: { operation: 'tackle', issue_id: ISSUE.id },
				issue: ISSUE
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				repositories: BEADS_WEB_MAP
			}
		);

		expect(result.request.status).toBe('failed');
		expect(result.request.error_message).toBe(UNMAPPED_TACKLE_MESSAGE);
		expect(JSON.stringify(result.request)).not.toContain('github.com');
		expect(provider.launch).not.toHaveBeenCalled();
	});

	it('fails closed when Tackle mapping configuration is invalid', async () => {
		const provider = providerWithLaunch(vi.fn(async () => ({ agent_id: 'not-called' })));

		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-badmap001',
				project: PROJECT,
				actor: 'web',
				payload: { operation: 'tackle', issue_id: ISSUE.id },
				issue: ISSUE
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				repositories: BEADS_WEB_MAP,
				repositories_invalid: true
			}
		);

		expect(result.request.status).toBe('failed');
		expect(result.request.error_message).toBe(INVALID_TACKLE_MAPPING_MESSAGE);
		expect(provider.launch).not.toHaveBeenCalled();
	});

	it('refuses File and Tackle when dispatch is disarmed without calling the provider', async () => {
		const launch = vi.fn();
		const provider = providerWithLaunch(launch);

		await expect(
			enqueueDispatch(
				{
					idempotency_key: 'idem-disarm001',
					project: PROJECT,
					actor: 'web',
					payload: { operation: 'file', notes: 'Should not launch.' }
				},
				{
					store,
					provider,
					configured: true,
					policy: { armed: false, allow: ALLOW_ALL.allow }
				}
			)
		).rejects.toMatchObject({
			name: 'DispatchError',
			message: DISARMED_DISPATCH_MESSAGE
		});
		expect(launch).not.toHaveBeenCalled();
	});

	it('allows File and refuses Tackle when the project denies Tackle', async () => {
		const launch = vi.fn(async () => ({ agent_id: 'bc-file-only' }));
		const provider = providerWithLaunch(launch);
		const policy = { armed: true, allow: { file: true, tackle: false } };

		const filed = await enqueueDispatch(
			{
				idempotency_key: 'idem-fileonly1',
				project: PROJECT,
				actor: 'web',
				payload: { operation: 'file', notes: 'File is allowed.' }
			},
			{
				store,
				provider,
				configured: true,
				policy,
				schedule_background: NO_BACKGROUND
			}
		);
		expect(filed.request.status).toBe('launched');

		await expect(
			enqueueDispatch(
				{
					idempotency_key: 'idem-notackle1',
					project: PROJECT,
					actor: 'web',
					payload: { operation: 'tackle', issue_id: ISSUE.id },
					issue: ISSUE
				},
				{
					store,
					provider,
					configured: true,
					policy,
					repositories: BEADS_WEB_MAP
				}
			)
		).rejects.toMatchObject({
			name: 'DispatchError',
			message: TACKLE_NOT_ALLOWED_MESSAGE
		});
		expect(launch).toHaveBeenCalledOnce();
	});

	it('refuses File when the project denies File', async () => {
		const launch = vi.fn();
		const provider = providerWithLaunch(launch);

		await expect(
			enqueueDispatch(
				{
					idempotency_key: 'idem-nofile001',
					project: PROJECT,
					actor: 'web',
					payload: { operation: 'file', notes: 'Not allowed.' }
				},
				{
					store,
					provider,
					configured: true,
					policy: { armed: true, allow: { file: false, tackle: true } }
				}
			)
		).rejects.toMatchObject({
			name: 'DispatchError',
			message: FILE_NOT_ALLOWED_MESSAGE
		});
		expect(launch).not.toHaveBeenCalled();
	});

	it('still fails unmapped Tackle even when Tackle is allowed', async () => {
		const launch = vi.fn();
		const provider = providerWithLaunch(launch);

		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-allowmap1',
				project: OTHER_PROJECT,
				actor: 'web',
				payload: { operation: 'tackle', issue_id: ISSUE.id },
				issue: ISSUE
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				repositories: BEADS_WEB_MAP
			}
		);

		expect(result.request.status).toBe('failed');
		expect(result.request.error_message).toBe(UNMAPPED_TACKLE_MESSAGE);
		expect(launch).not.toHaveBeenCalled();
	});

	it('launches a comment agent on the File checkout without a pull request', async () => {
		const provider = providerWithLaunch(
			vi.fn(async (input: AgentLaunchInput) => {
				expect(input.auto_create_pr).toBe(false);
				expect(input.repository).toBeUndefined();
				expect(input.name).toBe('Comment on beads-web-1');
				return {
					agent_id: 'bc-c',
					agent_url: 'https://runner.example.com/agents/bc-c'
				};
			})
		);

		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-comment01',
				project: PROJECT,
				actor: 'owner@example.com',
				payload: {
					operation: 'comment',
					issue_id: ISSUE.id,
					text: 'Please keep the composer.',
					author: 'owner@example.com'
				},
				issue: ISSUE
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				schedule_background: NO_BACKGROUND
			}
		);

		expect(result.request).toMatchObject({
			operation: 'comment',
			status: 'launched',
			issue_id: ISSUE.id,
			agent_id: 'bc-c'
		});
		expect(JSON.stringify(result.request)).not.toContain('Please keep the composer.');
		expect(provider.launch).toHaveBeenCalledOnce();
	});

	it('allows comment when only Tackle is allowed and refuses when both are denied', async () => {
		const launch = vi.fn(async () => ({ agent_id: 'bc-comment' }));
		const provider = providerWithLaunch(launch);

		const allowed = await enqueueDispatch(
			{
				idempotency_key: 'idem-cmt-tack1',
				project: PROJECT,
				actor: 'web',
				payload: {
					operation: 'comment',
					issue_id: ISSUE.id,
					text: 'Still commentable.',
					author: 'web'
				},
				issue: ISSUE
			},
			{
				store,
				provider,
				configured: true,
				policy: { armed: true, allow: { file: false, tackle: true } },
				schedule_background: NO_BACKGROUND
			}
		);
		expect(allowed.request.status).toBe('launched');

		await expect(
			enqueueDispatch(
				{
					idempotency_key: 'idem-cmt-deny1',
					project: PROJECT,
					actor: 'web',
					payload: {
						operation: 'comment',
						issue_id: ISSUE.id,
						text: 'Blocked.',
						author: 'web'
					},
					issue: ISSUE
				},
				{
					store,
					provider,
					configured: true,
					policy: { armed: true, allow: { file: false, tackle: false } }
				}
			)
		).rejects.toMatchObject({
			name: 'DispatchError',
			message: COMMENT_NOT_ALLOWED_MESSAGE
		});
		expect(launch).toHaveBeenCalledOnce();
	});
});

describe('run tracking', () => {
	async function launchedRecord(
		key: string,
		patch: { agent_id: string; run_id?: string }
	): Promise<string> {
		const { record } = await store.create({
			idempotency_key: key,
			project_id: PROJECT.id,
			dolt_database: PROJECT.dolt_database,
			operation: 'file',
			actor: 'web',
			payload: { operation: 'file', notes: 'File the bug.' }
		});
		await store.updateStatus(record.id, { status: 'launched', provider: 'webhook', ...patch });
		return record.id;
	}

	it('persists a streamed terminal result with summary, duration, and PR URL', async () => {
		const provider: AgentProvider = {
			...providerWithLaunch(vi.fn(async () => ({ agent_id: 'bc-9', run_id: 'run-9' }))),
			streamRun: vi.fn(async (_agent_id, _run_id, on_update) => {
				await on_update({
					status: 'succeeded',
					result_summary: 'Completed the requested work.',
					duration_ms: 12_345,
					git_pr_url: 'https://github.com/example-org/beads-web/pull/42'
				});
				return 'terminal' as const;
			})
		};
		let background: Promise<void> | undefined;

		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-aaaaaaaa',
				project: PROJECT,
				actor: 'web',
				payload: { operation: 'tackle', issue_id: 'beads-web-42' }
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				repositories: BEADS_WEB_MAP,
				schedule_background: (task) => {
					background = task();
				}
			}
		);
		await background;

		expect(provider.streamRun).toHaveBeenCalledWith('bc-9', 'run-9', expect.any(Function));
		expect(provider.getRun).not.toHaveBeenCalled();
		expect(await store.get(result.request.id)).toMatchObject({
			status: 'succeeded',
			result_summary: 'Completed the requested work.',
			duration_ms: 12_345,
			git_pr_url: 'https://github.com/example-org/beads-web/pull/42'
		});
	});

	it('falls back from an expired stream to a terminal status poll', async () => {
		const provider: AgentProvider = {
			...providerWithLaunch(vi.fn(async () => ({ agent_id: 'bc-10', run_id: 'run-10' }))),
			streamRun: vi.fn(async () => 'stream_expired' as const),
			getRun: vi.fn(async () => ({
				status: 'succeeded' as const,
				result_summary: 'Finished after stream retention elapsed.',
				duration_ms: 99,
				git_pr_url: 'https://github.com/example-org/beads-web/pull/43'
			}))
		};
		let background: Promise<void> | undefined;

		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-bbbbbbbb',
				project: PROJECT,
				actor: 'web',
				payload: { operation: 'file', notes: 'File the bug.' }
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				schedule_background: (task) => {
					background = task();
				}
			}
		);
		await background;

		expect(await store.get(result.request.id)).toMatchObject({
			status: 'succeeded',
			result_summary: 'Finished after stream retention elapsed.',
			duration_ms: 99,
			git_pr_url: 'https://github.com/example-org/beads-web/pull/43'
		});
		expect(provider.getRun).toHaveBeenCalledOnce();
		expect(provider.getRun).toHaveBeenCalledWith('bc-10', 'run-10');
	});

	it('recovers a missing run id and refreshes a launched record to running', async () => {
		const id = await launchedRecord('idem-running1', { agent_id: 'bc-running' });
		const provider: AgentProvider = {
			...providerWithLaunch(vi.fn()),
			getLatestRunId: vi.fn(async () => 'run-running'),
			getRun: vi.fn(async () => ({ status: 'running' as const }))
		};

		const public_record = await getDispatch(PROJECT.id, id, {
			store,
			provider,
			schedule_background: NO_BACKGROUND
		});

		expect(public_record?.status).toBe('running');
		expect((await store.get(id))?.run_id).toBe('run-running');
		expect(provider.getLatestRunId).toHaveBeenCalledWith('bc-running');
		expect(provider.getRun).toHaveBeenCalledWith('bc-running', 'run-running');
	});

	it('refreshes a launched record to cancelled on public GET', async () => {
		const id = await launchedRecord('idem-cccccccc', {
			agent_id: 'bc-cancelled',
			run_id: 'run-cancelled'
		});
		const provider: AgentProvider = {
			...providerWithLaunch(vi.fn()),
			getRun: vi.fn(async () => ({ status: 'cancelled' as const, duration_ms: 1_000 }))
		};

		const public_record = await getDispatch(PROJECT.id, id, {
			store,
			provider,
			schedule_background: NO_BACKGROUND
		});

		expect(public_record).toMatchObject({
			status: 'cancelled',
			duration_ms: 1_000
		});
		expect(provider.getRun).toHaveBeenCalledOnce();
	});

	it('refreshes a launched record to run-time failed with the runner error', async () => {
		const id = await launchedRecord('idem-dddddddd', {
			agent_id: 'bc-error',
			run_id: 'run-error'
		});
		const provider: AgentProvider = {
			...providerWithLaunch(vi.fn()),
			getRun: vi.fn(async () => ({
				status: 'failed' as const,
				duration_ms: 2_000,
				error_message: 'The agent run failed.'
			}))
		};

		const public_record = await getDispatch(PROJECT.id, id, {
			store,
			provider,
			schedule_background: NO_BACKGROUND
		});

		expect(public_record).toMatchObject({
			status: 'failed',
			duration_ms: 2_000,
			error_message: 'The agent run failed.'
		});
		expect(public_record?.agent_id).toBe('bc-error');
	});

	it('keeps the webhook secret out of URLs, SQLite, logs, and public JSON', async () => {
		const secret = 'runner-secret-value-'.repeat(2);
		const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const urls: string[] = [];
		const fetch_impl = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url.endsWith('/agents')) {
				return new Response(
					JSON.stringify({
						agent_id: 'ag-safe',
						run_id: 'run-safe',
						agent_url: 'https://runner.example.com/agents/ag-safe'
					}),
					{ status: 201 }
				);
			}
			expect(url).toBe('https://runner.example.com/beadsmith/agents/ag-safe/runs/run-safe');
			return new Response(
				JSON.stringify({
					status: 'succeeded',
					summary: `Completed. Authorization: ${secret}`,
					duration_ms: 12,
					pr_url: `https://github.com/example-org/beads-web/pull/44?token=${secret}`
				}),
				{ status: 200 }
			);
		});
		const provider = createWebhookProvider({
			server_env: readEnv({
				HOME: '/home/tester',
				BDX_DISPATCH_PROVIDER: 'webhook',
				BDX_DISPATCH_WEBHOOK_URL: 'https://runner.example.com/beadsmith',
				BDX_DISPATCH_WEBHOOK_SECRET: secret
			}),
			fetch: fetch_impl as typeof fetch,
			secret
		});
		let background: Promise<void> | undefined;

		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-eeeeeeee',
				project: PROJECT,
				actor: 'web',
				payload: { operation: 'file', notes: 'File the bug.' }
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				max_poll_attempts: 1,
				schedule_background: (task) => {
					background = task();
				}
			}
		);
		await background;

		const stored = await store.get(result.request.id);
		const public_record = stored === undefined ? undefined : toPublicDispatch(stored);
		expect(urls.join('\n')).not.toContain(secret);
		expect(JSON.stringify(stored)).not.toContain(secret);
		expect(JSON.stringify(public_record)).not.toContain(secret);
		expect(JSON.stringify(error_spy.mock.calls)).not.toContain(secret);
		expect(stored).toMatchObject({
			status: 'succeeded',
			provider: 'webhook',
			agent_url: 'https://runner.example.com/agents/ag-safe'
		});
		expect(stored?.git_pr_url).toBeUndefined();
		error_spy.mockRestore();
	});
});

describe('toPublicDispatch', () => {
	it('omits actor and payload', () => {
		const public_record = toPublicDispatch({
			id: 'dq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			idempotency_key: 'secret-replay-token',
			project_id: 'd_beads_web',
			dolt_database: 'beads_web',
			operation: 'file',
			actor: 'owner@example.com',
			payload: { operation: 'file', notes: 'private notes' },
			status: 'queued',
			created_at: '2026-08-16T00:00:00.000Z',
			updated_at: '2026-08-16T00:00:00.000Z'
		});

		expect(JSON.stringify(public_record)).not.toContain('owner@example.com');
		expect(JSON.stringify(public_record)).not.toContain('private notes');
		expect(JSON.stringify(public_record)).not.toContain('secret-replay-token');
	});

	it('omits comment text from the public record', () => {
		const public_record = toPublicDispatch({
			id: 'dq_cccccccccccccccccccccccccccccccc',
			idempotency_key: 'secret-replay-token',
			project_id: 'd_beads_web',
			dolt_database: 'beads_web',
			operation: 'comment',
			actor: 'owner@example.com',
			payload: {
				operation: 'comment',
				issue_id: 'beads-web-12',
				text: 'Please keep the composer.',
				author: 'owner@example.com',
				title: 'Let humans add comments'
			},
			status: 'queued',
			created_at: '2026-08-16T00:00:00.000Z',
			updated_at: '2026-08-16T00:00:00.000Z'
		});

		expect(public_record.issue_id).toBe('beads-web-12');
		expect(JSON.stringify(public_record)).not.toContain('Please keep the composer.');
		expect(JSON.stringify(public_record)).not.toContain('owner@example.com');
		expect(JSON.stringify(public_record)).not.toContain('secret-replay-token');
	});
});

describe('toPublicMission', () => {
	it('includes actor and title but omits notes and the idempotency key', () => {
		const mission = toPublicMission(
			{
				id: 'dq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				idempotency_key: 'secret-replay-token',
				project_id: 'd_beads_web',
				dolt_database: 'beads_web',
				operation: 'file',
				actor: 'owner@example.com',
				payload: { operation: 'file', notes: 'private notes', title: 'Login bug' },
				status: 'queued',
				created_at: '2026-08-16T00:00:00.000Z',
				updated_at: '2026-08-16T00:00:00.000Z'
			},
			'beads_web'
		);

		expect(mission).toMatchObject({
			actor: 'owner@example.com',
			project_name: 'beads_web',
			title: 'Login bug',
			operation: 'file',
			status: 'queued'
		});
		expect(JSON.stringify(mission)).not.toContain('private notes');
		expect(JSON.stringify(mission)).not.toContain('secret-replay-token');
	});
});

describe('listMissions', () => {
	it('maps stored rows through the public mission shape', async () => {
		await store.create({
			idempotency_key: 'idem-aaaaaaaa',
			project_id: 'd_beads_web',
			dolt_database: 'beads_web',
			operation: 'tackle',
			actor: 'owner@example.com',
			payload: {
				operation: 'tackle',
				issue_id: 'beads-web-s42.3',
				title: 'Missions view',
				description: 'secret body'
			}
		});

		const missions = await listMissions(
			{ limit: 10 },
			{ store, project_names: new Map([['d_beads_web', 'Beadsmith']]) }
		);

		expect(missions).toHaveLength(1);
		expect(missions[0]).toMatchObject({
			project_name: 'Beadsmith',
			actor: 'owner@example.com',
			issue_id: 'beads-web-s42.3',
			title: 'Missions view'
		});
		expect(JSON.stringify(missions)).not.toContain('secret body');
	});
});

describe('streamDispatchMissionEvents', () => {
	it('replays a stored terminal result when the live stream has expired', async () => {
		const created = await store.create({
			idempotency_key: 'idem-stream1',
			project_id: PROJECT.id,
			dolt_database: PROJECT.dolt_database,
			operation: 'file',
			actor: 'web',
			payload: { operation: 'file', notes: 'secret notes' }
		});
		await store.updateStatus(created.record.id, {
			status: 'succeeded',
			agent_id: 'bc-expired',
			run_id: 'run-expired',
			result_summary: 'Shipped the change.',
			git_pr_url: 'https://github.com/example-org/beads-web/pull/7'
		});
		const provider: AgentProvider = {
			...providerWithLaunch(vi.fn()),
			streamMissionEvents: vi.fn(async () => 'stream_expired' as const)
		};
		const events: unknown[] = [];
		const outcome = await streamDispatchMissionEvents(
			PROJECT.id,
			created.record.id,
			async (event) => {
				events.push(event);
			},
			{ store, provider }
		);
		expect(outcome).toBe('terminal');
		expect(events).toEqual([
			{
				type: 'result',
				id: 'stored-result',
				status: 'succeeded',
				text: 'Shipped the change.',
				git_pr_url: 'https://github.com/example-org/beads-web/pull/7'
			}
		]);
		expect(JSON.stringify(events)).not.toContain('secret notes');
	});

	it('still reconstructs a stored result when live streaming throws', async () => {
		const created = await store.create({
			idempotency_key: 'idem-stream2',
			project_id: PROJECT.id,
			dolt_database: PROJECT.dolt_database,
			operation: 'file',
			actor: 'web',
			payload: { operation: 'file', notes: 'secret notes' }
		});
		await store.updateStatus(created.record.id, {
			status: 'succeeded',
			agent_id: 'bc-expired',
			run_id: 'run-expired',
			result_summary: 'Recovered after the runner was unavailable.'
		});
		const provider: AgentProvider = {
			...providerWithLaunch(vi.fn()),
			streamMissionEvents: vi.fn(async () => {
				throw new DispatchError('unavailable', 'Agent dispatch is not configured.');
			})
		};
		const events: unknown[] = [];
		const outcome = await streamDispatchMissionEvents(
			PROJECT.id,
			created.record.id,
			async (event) => {
				events.push(event);
			},
			{ store, provider }
		);
		expect(outcome).toBe('terminal');
		expect(events).toEqual([
			{
				type: 'result',
				id: 'stored-result',
				status: 'succeeded',
				text: 'Recovered after the runner was unavailable.'
			}
		]);
	});
});

describe('cancelDispatch and followUpDispatch', () => {
	async function seedTerminal(status: 'succeeded' | 'cancelled' | 'failed' = 'succeeded') {
		const created = await store.create({
			idempotency_key: 'idem-steer-1',
			project_id: PROJECT.id,
			dolt_database: PROJECT.dolt_database,
			operation: 'file',
			actor: 'web',
			payload: { operation: 'file', notes: 'secret notes' }
		});
		await store.updateStatus(created.record.id, {
			status,
			provider: 'webhook',
			agent_id: 'bc-steer',
			run_id: 'run-1',
			result_summary: 'First run finished.'
		});
		return created.record.id;
	}

	async function seedRunning() {
		const created = await store.create({
			idempotency_key: 'idem-steer-run',
			project_id: PROJECT.id,
			dolt_database: PROJECT.dolt_database,
			operation: 'tackle',
			actor: 'web',
			payload: { operation: 'tackle', issue_id: 'beads-web-1' }
		});
		await store.updateStatus(created.record.id, {
			status: 'running',
			provider: 'webhook',
			agent_id: 'bc-steer',
			run_id: 'run-live'
		});
		return created.record.id;
	}

	it('cancels a running mission and persists cancelled', async () => {
		const id = await seedRunning();
		const provider = providerWithLaunch(vi.fn());
		const result = await cancelDispatch(PROJECT.id, id, {
			store,
			provider,
			configured: true,
			policy: ALLOW_ALL,
			schedule_background: NO_BACKGROUND
		});
		expect(result?.status).toBe('cancelled');
		expect(provider.cancelRun).toHaveBeenCalledWith('bc-steer', 'run-live');
		expect((await store.get(id))?.status).toBe('cancelled');
	});

	it('still cancels when dispatch is disarmed', async () => {
		const id = await seedRunning();
		const provider = providerWithLaunch(vi.fn());
		const result = await cancelDispatch(PROJECT.id, id, {
			store,
			provider,
			configured: true,
			policy: { armed: false, allow: { file: true, tackle: true } },
			schedule_background: NO_BACKGROUND
		});
		expect(result?.status).toBe('cancelled');
		expect(provider.cancelRun).toHaveBeenCalled();
	});

	it('sends a follow-up as a new run on the same agent', async () => {
		const id = await seedTerminal();
		const provider = providerWithLaunch(vi.fn());
		provider.createRun = vi.fn(async () => ({ run_id: 'run-2' }));
		const result = await followUpDispatch(PROJECT.id, id, 'Also add tests.', {
			store,
			provider,
			configured: true,
			policy: ALLOW_ALL,
			schedule_background: NO_BACKGROUND
		});
		expect(result?.status).toBe('launched');
		expect(provider.createRun).toHaveBeenCalledWith('bc-steer', 'Also add tests.');
		expect((await store.get(id))?.run_id).toBe('run-2');
		expect(JSON.stringify(result)).not.toContain('secret notes');
		expect(JSON.stringify(result)).not.toContain('Also add tests.');
	});

	it('refuses a follow-up while the agent is busy', async () => {
		const id = await seedRunning();
		const provider = providerWithLaunch(vi.fn());
		await expect(
			followUpDispatch(PROJECT.id, id, 'wait', {
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				schedule_background: NO_BACKGROUND
			})
		).rejects.toEqual(
			expect.objectContaining({
				name: 'DispatchError',
				code: 'conflict',
				message: AGENT_BUSY_MESSAGE
			})
		);
		expect(provider.createRun).not.toHaveBeenCalled();
	});

	it('refuses a follow-up when dispatch is disarmed', async () => {
		const id = await seedTerminal();
		const provider = providerWithLaunch(vi.fn());
		await expect(
			followUpDispatch(PROJECT.id, id, 'wait', {
				store,
				provider,
				configured: true,
				policy: { armed: false, allow: { file: true, tackle: true } },
				schedule_background: NO_BACKGROUND
			})
		).rejects.toBeInstanceOf(DispatchError);
		expect(provider.createRun).not.toHaveBeenCalled();
	});

	it('refuses to steer a mission that never launched', async () => {
		const created = await store.create({
			idempotency_key: 'idem-steer-none',
			project_id: PROJECT.id,
			dolt_database: PROJECT.dolt_database,
			operation: 'file',
			actor: 'web',
			payload: { operation: 'file', notes: 'notes' }
		});
		await store.updateStatus(created.record.id, { status: 'failed', error_message: 'no launch' });
		const provider = providerWithLaunch(vi.fn());
		await expect(
			followUpDispatch(PROJECT.id, created.record.id, 'retry', {
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL
			})
		).rejects.toEqual(
			expect.objectContaining({
				message: MISSION_NOT_LAUNCHED_MESSAGE
			})
		);
	});
});

describe('discuss missions and conversation turns', () => {
	const DISCUSS_DEPS = {
		configured: true,
		policy: ALLOW_ALL,
		repositories: BEADS_WEB_MAP,
		schedule_background: NO_BACKGROUND
	};

	function discussInput(
		intent: 'discuss' | 'elaborate' | 'close',
		message?: string,
		idempotency_key = 'idem-discuss01'
	) {
		return {
			idempotency_key,
			project: PROJECT,
			actor: 'owner@example.com',
			payload: {
				operation: 'discuss' as const,
				issue_id: ISSUE.id,
				intent,
				...(message === undefined ? {} : { message })
			},
			issue: ISSUE
		};
	}

	it('persists then launches on the Tackle checkout without a pull request', async () => {
		const provider = providerWithLaunch(
			vi.fn(async (input: AgentLaunchInput) => {
				expect(input.name).toBe('Discuss beads-web-1');
				expect(input.auto_create_pr).toBe(false);
				expect(input.repository).toEqual({
					url: 'https://github.com/example-org/beads-web',
					starting_ref: 'main'
				});
				expect(input.prompt).toContain('Is this still needed?');
				expect(input.prompt).toContain('Title: Map repos');
				return { agent_id: 'bc-d', run_id: 'run-1' };
			})
		);

		const result = await enqueueDispatch(discussInput('discuss', 'Is this still needed?'), {
			...DISCUSS_DEPS,
			store,
			provider
		});

		expect(result.request).toMatchObject({
			operation: 'discuss',
			intent: 'discuss',
			status: 'launched',
			issue_id: ISSUE.id,
			provider: 'webhook'
		});
		expect(JSON.stringify(result.request)).not.toContain('Is this still needed?');
		const turns = await listDispatchTurns(PROJECT.id, result.request.id, { store });
		expect(turns?.map((turn) => [turn.role, turn.text])).toEqual([
			['operator', 'Is this still needed?']
		]);
	});

	it('launches without a checkout when the project has no Tackle map', async () => {
		const provider = providerWithLaunch(
			vi.fn(async (input: AgentLaunchInput) => {
				expect(input.repository).toBeUndefined();
				return { agent_id: 'bc-d' };
			})
		);
		const result = await enqueueDispatch(discussInput('elaborate'), {
			...DISCUSS_DEPS,
			repositories: {},
			file_maps: {},
			store,
			provider
		});
		expect(result.request.status).toBe('launched');
		const turns = await listDispatchTurns(PROJECT.id, result.request.id, { store });
		expect(turns?.[0]?.text).toBe('Elaborate the description and acceptance criteria.');
	});

	it('falls back to the File checkout when the project has no Tackle map', async () => {
		const provider = providerWithLaunch(
			vi.fn(async (input: AgentLaunchInput) => {
				expect(input.auto_create_pr).toBe(false);
				expect(input.repository).toEqual({
					url: 'https://github.com/example-org/beads-web',
					starting_ref: 'develop'
				});
				return { agent_id: 'bc-d' };
			})
		);
		const result = await enqueueDispatch(discussInput('discuss'), {
			...DISCUSS_DEPS,
			repositories: {},
			file_maps: {
				[PROJECT.id]: { url: 'https://github.com/example-org/beads-web', ref: 'develop' }
			},
			store,
			provider
		});
		expect(result.request.status).toBe('launched');
		expect(provider.launch).toHaveBeenCalledOnce();
	});

	it('needs Tackle allowed to elaborate or close, but not to discuss', async () => {
		const provider = providerWithLaunch(vi.fn(async () => ({ agent_id: 'bc-d' })));
		const file_only = { armed: true, allow: { file: true, tackle: false } };

		await expect(
			enqueueDispatch(discussInput('elaborate'), {
				...DISCUSS_DEPS,
				policy: file_only,
				store,
				provider
			})
		).rejects.toMatchObject({ code: 'forbidden', message: ELABORATE_NOT_ALLOWED_MESSAGE });
		await expect(
			enqueueDispatch(discussInput('discuss'), {
				...DISCUSS_DEPS,
				policy: file_only,
				store,
				provider
			})
		).resolves.toMatchObject({ created: true });
		await expect(
			enqueueDispatch(discussInput('close', undefined, 'idem-discuss02'), {
				...DISCUSS_DEPS,
				policy: { armed: false, allow: { file: true, tackle: true } },
				store,
				provider
			})
		).rejects.toMatchObject({ code: 'forbidden', message: DISARMED_DISPATCH_MESSAGE });
		expect(provider.launch).toHaveBeenCalledOnce();
	});

	it('records each finished run once and the follow-up between them', async () => {
		const provider = providerWithLaunch(vi.fn(async () => ({ agent_id: 'bc-d', run_id: 'run-1' })));
		provider.getRun = vi.fn(async () => ({
			status: 'succeeded' as const,
			result_summary: 'It is still needed: the login fails.'
		}));
		provider.createRun = vi.fn(async () => ({ run_id: 'run-2' }));
		const { request } = await enqueueDispatch(discussInput('discuss'), {
			...DISCUSS_DEPS,
			store,
			provider
		});

		await getDispatch(PROJECT.id, request.id, { ...DISCUSS_DEPS, store, provider });
		await getDispatch(PROJECT.id, request.id, { ...DISCUSS_DEPS, store, provider });
		await followUpDispatch(PROJECT.id, request.id, 'Then close it.', {
			...DISCUSS_DEPS,
			store,
			provider
		});

		const turns = await listDispatchTurns(PROJECT.id, request.id, { store });
		expect(turns?.map((turn) => [turn.role, turn.text, turn.run_id])).toEqual([
			['operator', 'Discuss this issue.', undefined],
			['agent', 'It is still needed: the login fails.', 'run-1'],
			['operator', 'Then close it.', 'run-2']
		]);
	});

	it('records a launch failure as the agent turn', async () => {
		const provider = providerWithLaunch(
			vi.fn(async () => {
				throw new Error('boom');
			})
		);
		const { request } = await enqueueDispatch(discussInput('close', 'Done.'), {
			...DISCUSS_DEPS,
			store,
			provider
		});
		expect(request.status).toBe('failed');
		const turns = await listDispatchTurns(PROJECT.id, request.id, { store });
		expect(turns?.map((turn) => [turn.role, turn.status])).toEqual([
			['operator', undefined],
			['agent', 'failed']
		]);
	});

	it('rebuilds a transcript for missions recorded before turns, and hides other projects', async () => {
		const { record } = await store.create({
			idempotency_key: 'idem-legacy01',
			project_id: PROJECT.id,
			dolt_database: PROJECT.dolt_database,
			operation: 'tackle',
			actor: 'web',
			payload: { operation: 'tackle', issue_id: 'beads-web-1', destination_status: 'closed' }
		});
		await store.updateStatus(record.id, {
			status: 'succeeded',
			agent_id: 'bc-old',
			run_id: 'run-old',
			result_summary: 'Closed it.'
		});

		const turns = await listDispatchTurns(PROJECT.id, record.id, { store });
		expect(turns?.map((turn) => [turn.role, turn.text])).toEqual([
			['operator', 'Check whether this is finished, then close it.'],
			['agent', 'Closed it.']
		]);
		expect(await listDispatchTurns(OTHER_PROJECT.id, record.id, { store })).toBeUndefined();
	});
});

describe('chat notices (ADR-0020 rule 5)', () => {
	const CHAT_PAYLOAD = { operation: 'tackle' as const, issue_id: 'beads-web-42' };

	function finishingProvider(observations: number): AgentProvider {
		return {
			...providerWithLaunch(vi.fn(async () => ({ agent_id: 'bc-chat', run_id: 'run-chat' }))),
			// The stream reports the outcome, then a reconnect reports it again.
			streamRun: vi.fn(async (_agent_id, _run_id, on_update) => {
				for (let i = 0; i < observations; i += 1) {
					await on_update({
						status: 'succeeded',
						result_summary: 'Opened a pull request.',
						git_pr_url: 'https://github.com/example-org/beads-web/pull/7'
					});
				}
				return 'terminal' as const;
			})
		};
	}

	async function launch(
		chat_id: string | undefined,
		provider: AgentProvider,
		notify_chat: (record: unknown) => Promise<unknown>,
		key = 'crew:aaaaaaaa'
	) {
		let background: Promise<void> | undefined;
		const result = await enqueueDispatch(
			{
				idempotency_key: key,
				project: PROJECT,
				actor: 'owner@example.com',
				payload: CHAT_PAYLOAD,
				...(chat_id === undefined ? {} : { chat_id })
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				repositories: BEADS_WEB_MAP,
				notify_chat,
				schedule_background: (task) => {
					background = task();
				}
			}
		);
		await background;
		return result;
	}

	it('hands a chat-launched mission’s outcome to the notifier', async () => {
		const notify_chat = vi.fn(async () => 'sent');
		const result = await launch('mc_aaaaaaaaaaaaaaaaaaaaaaaa', finishingProvider(1), notify_chat);
		expect(notify_chat).toHaveBeenCalledOnce();
		expect(notify_chat).toHaveBeenCalledWith(
			expect.objectContaining({
				id: result.request.id,
				chat_id: 'mc_aaaaaaaaaaaaaaaaaaaaaaaa',
				status: 'succeeded',
				run_id: 'run-chat',
				git_pr_url: 'https://github.com/example-org/beads-web/pull/7'
			})
		);
	});

	it('never notifies for a mission without a chat', async () => {
		const notify_chat = vi.fn(async () => 'sent');
		await launch(undefined, finishingProvider(2), notify_chat);
		expect(notify_chat).not.toHaveBeenCalled();
	});

	it('tells the chat once when the outcome is observed twice', async () => {
		const { createMateStore } = await import('../mate/store.js');
		const { deliverCrewNotice } = await import('../crew/notices.js');
		const client = createClient({ url: ':memory:' });
		await initStateSchema(client);
		store = createDispatchStore(client);
		const mate = createMateStore(client);
		await client.execute(
			`INSERT INTO auth_user (id, name, email, role, banned, created_at, updated_at)
				VALUES ('u1', 'u1', 'owner@example.com', 'admin', 0, 0, 0)`
		);
		const chat = await mate.createChat('u1', { title: 't', scope: null });
		const sendMessage = vi.fn(async () => ({ event_id: 'e1' }));
		const runner = { sendMessage } as never;
		const deliveries: Promise<unknown>[] = [];
		const notify_chat = (record: unknown) => {
			const delivery = deliverCrewNotice(record as never, {
				dispatch: store,
				mate,
				runnerFor: () => runner
			});
			deliveries.push(delivery);
			return delivery;
		};

		await launch(chat.id, finishingProvider(2), notify_chat);
		await Promise.all(deliveries);

		expect(sendMessage).toHaveBeenCalledOnce();
		expect(sendMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({
				message_id: expect.stringMatching(/^crew-[a-f0-9]{40}$/),
				prompt: expect.stringContaining('[crew] Tackle on beads-web-42')
			})
		);
	});

	it('marks a launch failure as told instead of notifying: the tool result already said so', async () => {
		const notify_chat = vi.fn(async () => 'sent');
		const provider = providerWithLaunch(async () => {
			throw new DispatchError('unavailable', 'The agent could not be launched.');
		});
		const result = await launch('mc_aaaaaaaaaaaaaaaaaaaaaaaa', provider, notify_chat);
		expect(result.request.status).toBe('failed');
		expect(notify_chat).not.toHaveBeenCalled();
		expect(await store.listChatNoticesDue('mc_aaaaaaaaaaaaaaaaaaaaaaaa', 10)).toEqual([]);
	});

	it('notifies a cancel of a chat-launched mission', async () => {
		const { record } = await store.create({
			idempotency_key: 'crew:cancel',
			project_id: PROJECT.id,
			dolt_database: PROJECT.dolt_database,
			operation: 'tackle',
			actor: 'owner@example.com',
			payload: CHAT_PAYLOAD,
			chat_id: 'mc_aaaaaaaaaaaaaaaaaaaaaaaa'
		});
		await store.updateStatus(record.id, {
			status: 'running',
			provider: 'webhook',
			agent_id: 'bc-steer',
			run_id: 'run-live'
		});
		const notify_chat = vi.fn(async () => 'sent');
		await cancelDispatch(PROJECT.id, record.id, {
			store,
			provider: providerWithLaunch(vi.fn()),
			configured: true,
			policy: ALLOW_ALL,
			notify_chat,
			schedule_background: NO_BACKGROUND
		});
		expect(notify_chat).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
	});
});

describe('loop missions (ADR-0019 rule 5)', () => {
	/** The operator offers the model and effort BUILD_LOOP asks for. */
	const LOOP_CHOICES = { models: ['opus'], efforts: ['high'] };
	const BUILD_LOOP = {
		operation: 'loop' as const,
		mode: 'build' as const,
		harness: 'claude' as const,
		model: 'opus',
		effort: 'high',
		max_iterations: 5,
		iteration_timeout_minutes: 30
	};

	const ITERATION: RalphIteration = {
		iteration: 1,
		outcome: 'completed',
		started_at: '2026-11-11T10:00:00.000Z',
		finished_at: '2026-11-11T10:05:00.000Z',
		duration_ms: 300_000,
		head_before: 'aaaaaaa',
		head_after: 'bbbbbbb',
		input_tokens: 1200,
		output_tokens: 300,
		cost_usd: 0.42,
		validate_ok: true,
		plan_open: 3
	};

	function loopProvider(
		launchLoop: (input: AgentLoopLaunchInput) => Promise<{ agent_id: string; run_id?: string }>
	): AgentProvider {
		return {
			...providerWithLaunch(vi.fn(async () => ({ agent_id: 'one-shot' }))),
			id: 'e2b',
			label: 'Sand',
			launchLoop: vi.fn(launchLoop)
		};
	}

	it('launches a plan-wide build loop on the Tackle checkout with its flags', async () => {
		const provider = loopProvider(async () => ({ agent_id: 'sbx-1', run_id: 'loop-1' }));

		const result = await enqueueDispatch(
			{ idempotency_key: 'idem-loop-0001', project: PROJECT, actor: 'web', payload: BUILD_LOOP },
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				agent_choices: LOOP_CHOICES,
				repositories: BEADS_WEB_MAP,
				schedule_background: NO_BACKGROUND
			}
		);

		expect(result.created).toBe(true);
		expect(result.request).toMatchObject({
			operation: 'loop',
			status: 'launched',
			provider: 'e2b'
		});
		expect(result.request.issue_id).toBeUndefined();
		expect(provider.launch).not.toHaveBeenCalled();
		expect(provider.launchLoop).toHaveBeenCalledWith({
			name: 'Loop build on beads_web',
			dolt_database: 'beads_web',
			repository: { url: 'https://github.com/example-org/beads-web', starting_ref: 'main' },
			loop: {
				mode: 'build',
				harness: 'claude',
				model: 'opus',
				effort: 'high',
				max_iterations: 5,
				iteration_timeout_minutes: 30
			}
		});
		const turns = await listDispatchTurns(PROJECT.id, result.request.id, { store });
		expect(turns?.[0]).toMatchObject({
			role: 'operator',
			text: "Run a build loop on the project's plan."
		});
		const missions = await listMissions({ limit: 10 }, { store });
		expect(missions[0]).toMatchObject({ operation: 'loop', id: result.request.id });
	});

	it('follows a loop past the one-hour poll budget until it ends', async () => {
		// The follower's reads are what give a long loop's sandbox more time.
		let reads = 0;
		const provider: AgentProvider = {
			...loopProvider(async () => ({ agent_id: 'sbx-long', run_id: 'r1' })),
			getRun: vi.fn(async () =>
				++reads < 200 ? { status: 'running' as const } : { status: 'succeeded' as const }
			)
		};
		let background: Promise<void> | undefined;

		const result = await enqueueDispatch(
			{ idempotency_key: 'idem-loop-long', project: PROJECT, actor: 'web', payload: BUILD_LOOP },
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				agent_choices: LOOP_CHOICES,
				repositories: BEADS_WEB_MAP,
				sleep: async () => {},
				schedule_background: (task) => {
					background = task();
				}
			}
		);
		await background;

		expect(provider.getRun).toHaveBeenCalledTimes(200);
		expect(await store.get(result.request.id)).toMatchObject({ status: 'succeeded' });
	});

	it('scopes a loop to one bead and records its title', async () => {
		const provider = loopProvider(async () => ({ agent_id: 'sbx-2' }));

		const result = await enqueueDispatch(
			{
				idempotency_key: 'idem-loop-0002',
				project: PROJECT,
				actor: 'web',
				payload: { ...BUILD_LOOP, issue_id: ISSUE.id },
				issue: ISSUE
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				agent_choices: LOOP_CHOICES,
				repositories: BEADS_WEB_MAP,
				schedule_background: NO_BACKGROUND
			}
		);

		expect(result.request.issue_id).toBe(ISSUE.id);
		expect(provider.launchLoop).toHaveBeenCalledWith(
			expect.objectContaining({
				name: `Loop build on ${ISSUE.id}`,
				loop: expect.objectContaining({ issue_id: ISSUE.id })
			})
		);
		const missions = await listMissions({ issue_id: ISSUE.id, limit: 10 }, { store });
		expect(missions).toHaveLength(1);
		expect(missions[0]?.title).toBe(ISSUE.title);
	});

	it('refuses a runner without loops before recording anything', async () => {
		const provider = providerWithLaunch(vi.fn(async () => ({ agent_id: 'never' })));

		await expect(
			enqueueDispatch(
				{ idempotency_key: 'idem-loop-0003', project: PROJECT, actor: 'web', payload: BUILD_LOOP },
				{
					store,
					provider,
					configured: true,
					policy: ALLOW_ALL,
					agent_choices: LOOP_CHOICES,
					repositories: BEADS_WEB_MAP,
					schedule_background: NO_BACKGROUND
				}
			)
		).rejects.toMatchObject({ code: 'forbidden', message: LOOP_NOT_SUPPORTED_MESSAGE });
		expect(provider.launch).not.toHaveBeenCalled();
		expect(await store.list({ limit: 10 })).toEqual([]);
	});

	it('picks the named runner: one without loops is refused even if the default has them', async () => {
		const sand = loopProvider(async () => ({ agent_id: 'sbx-3' }));
		const webhook = providerWithLaunch(vi.fn(async () => ({ agent_id: 'never' })));

		await expect(
			enqueueDispatch(
				{
					idempotency_key: 'idem-loop-0004',
					project: PROJECT,
					actor: 'web',
					payload: BUILD_LOOP,
					provider: 'webhook'
				},
				{
					store,
					providers: [sand, webhook],
					configured: true,
					policy: ALLOW_ALL,
					agent_choices: LOOP_CHOICES,
					repositories: BEADS_WEB_MAP,
					schedule_background: NO_BACKGROUND
				}
			)
		).rejects.toMatchObject({ message: LOOP_NOT_SUPPORTED_MESSAGE });
		expect(sand.launchLoop).not.toHaveBeenCalled();
	});

	it('refuses like Tackle: disarmed, or Tackle not allowed for the project', async () => {
		const provider = loopProvider(async () => ({ agent_id: 'never' }));
		const deps = {
			store,
			provider,
			configured: true,
			agent_choices: LOOP_CHOICES,
			repositories: BEADS_WEB_MAP,
			schedule_background: NO_BACKGROUND
		};
		const input = {
			idempotency_key: 'idem-loop-0005',
			project: PROJECT,
			actor: 'web',
			payload: BUILD_LOOP
		};

		await expect(
			enqueueDispatch(input, { ...deps, policy: { ...ALLOW_ALL, armed: false } })
		).rejects.toMatchObject({ code: 'forbidden', message: DISARMED_DISPATCH_MESSAGE });
		await expect(
			enqueueDispatch(input, {
				...deps,
				policy: { armed: true, allow: { file: true, tackle: false } }
			})
		).rejects.toMatchObject({ code: 'forbidden', message: LOOP_NOT_ALLOWED_MESSAGE });
		expect(provider.launchLoop).not.toHaveBeenCalled();
	});

	it('fails closed without a Tackle checkout, like Tackle', async () => {
		const provider = loopProvider(async () => ({ agent_id: 'never' }));

		const unmapped = await enqueueDispatch(
			{ idempotency_key: 'idem-loop-0006', project: PROJECT, actor: 'web', payload: BUILD_LOOP },
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				agent_choices: LOOP_CHOICES,
				repositories: {},
				schedule_background: NO_BACKGROUND
			}
		);
		const invalid = await enqueueDispatch(
			{ idempotency_key: 'idem-loop-0007', project: PROJECT, actor: 'web', payload: BUILD_LOOP },
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				agent_choices: LOOP_CHOICES,
				repositories_invalid: true,
				schedule_background: NO_BACKGROUND
			}
		);

		expect(unmapped.request).toMatchObject({
			status: 'failed',
			error_message: UNMAPPED_TACKLE_MESSAGE
		});
		expect(invalid.request).toMatchObject({
			status: 'failed',
			error_message: INVALID_TACKLE_MAPPING_MESSAGE
		});
		expect(provider.launchLoop).not.toHaveBeenCalled();
	});

	it('replays an idempotent loop without launching a second one', async () => {
		const provider = loopProvider(async () => ({ agent_id: 'sbx-8', run_id: 'loop-8' }));
		const deps = {
			store,
			provider,
			configured: true,
			policy: ALLOW_ALL,
			agent_choices: LOOP_CHOICES,
			repositories: BEADS_WEB_MAP,
			schedule_background: NO_BACKGROUND
		};
		const input = {
			idempotency_key: 'idem-loop-0008',
			project: PROJECT,
			actor: 'web',
			payload: BUILD_LOOP
		};

		const first = await enqueueDispatch(input, deps);
		const replay = await enqueueDispatch(input, deps);

		expect(replay).toMatchObject({ created: false, request: { id: first.request.id } });
		expect(provider.launchLoop).toHaveBeenCalledTimes(1);
	});

	it('copies iterations into state.db as they arrive, once each', async () => {
		const second: RalphIteration = {
			...ITERATION,
			iteration: 2,
			outcome: 'failed',
			started_at: '2026-11-11T10:05:00.000Z',
			finished_at: '2026-11-11T10:09:00.000Z',
			cost_usd: null,
			validate_ok: null,
			plan_open: null
		};
		const provider: AgentProvider = {
			...loopProvider(async () => ({ agent_id: 'sbx-9', run_id: 'loop-9' })),
			streamRun: vi.fn(async (_agent_id, _run_id, on_update) => {
				await on_update({ status: 'running', iterations: [ITERATION] });
				await on_update({ status: 'running', iterations: [ITERATION, second] });
				await on_update({
					status: 'succeeded',
					result_summary: 'Stopped: no open plan items are left.',
					iterations: [ITERATION, second],
					loop_end: { stop_reason: 'plan_complete', needs_person: false }
				});
				return 'terminal' as const;
			})
		};
		let background: Promise<void> | undefined;

		const result = await enqueueDispatch(
			{ idempotency_key: 'idem-loop-0009', project: PROJECT, actor: 'web', payload: BUILD_LOOP },
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				agent_choices: LOOP_CHOICES,
				repositories: BEADS_WEB_MAP,
				schedule_background: (task) => {
					background = task();
				}
			}
		);
		await background;

		expect(await store.get(result.request.id)).toMatchObject({ status: 'succeeded' });
		expect(await store.listLoopIterations(result.request.id)).toEqual([
			{ ...ITERATION, run_id: 'loop-9' },
			{ ...second, run_id: 'loop-9' }
		]);
		expect(await listLoopIterations(PROJECT.id, result.request.id, { store })).toEqual([
			{ ...ITERATION, run_id: 'loop-9' },
			{ ...second, run_id: 'loop-9' }
		]);
		expect(await listLoopIterations('d_other', result.request.id, { store })).toBeUndefined();
		const record = await store.get(result.request.id);
		expect(toPublicDispatch(record!).loop).toEqual({
			mode: 'build',
			harness: 'claude',
			model: 'opus',
			effort: 'high',
			max_iterations: 5,
			iteration_timeout_minutes: 30,
			stop_reason: 'plan_complete',
			needs_person: false
		});
	});

	it('refuses a follow-up on a loop: it has its own controls', async () => {
		const provider = loopProvider(async () => ({ agent_id: 'sbx-10', run_id: 'loop-10' }));
		const { record } = await store.create({
			idempotency_key: 'idem-loop-0010',
			project_id: PROJECT.id,
			dolt_database: PROJECT.dolt_database,
			operation: 'loop',
			actor: 'web',
			payload: BUILD_LOOP
		});
		await store.updateStatus(record.id, {
			status: 'succeeded',
			provider: 'e2b',
			agent_id: 'sbx-10',
			run_id: 'loop-10'
		});

		await expect(
			followUpDispatch(PROJECT.id, record.id, 'Keep going.', {
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				agent_choices: LOOP_CHOICES
			})
		).rejects.toMatchObject({ code: 'conflict', message: LOOP_FOLLOW_UP_MESSAGE });
		expect(provider.createRun).not.toHaveBeenCalled();
	});

	describe('loop controls: steer and stop after the iteration', () => {
		function controlledProvider(patch: Partial<AgentProvider> = {}): AgentProvider {
			return {
				...loopProvider(async () => ({ agent_id: 'sbx-c', run_id: 'r1' })),
				steerRun: vi.fn(async () => undefined),
				stopRunAfterIteration: vi.fn(async () => undefined),
				...patch
			};
		}

		async function runningLoop(status: 'running' | 'succeeded' = 'running') {
			const { record } = await store.create({
				idempotency_key: `idem-loop-ctl-${status}`,
				project_id: PROJECT.id,
				dolt_database: PROJECT.dolt_database,
				operation: 'loop',
				actor: 'web',
				payload: BUILD_LOOP
			});
			await store.updateStatus(record.id, {
				status,
				provider: 'e2b',
				agent_id: 'sbx-c',
				run_id: 'r1'
			});
			return record.id;
		}

		it('passes a steer note to the runner and keeps it in the transcript', async () => {
			const provider = controlledProvider();
			const id = await runningLoop();

			const result = await steerDispatch(PROJECT.id, id, 'Fix the flaky test first.', {
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				agent_choices: LOOP_CHOICES
			});

			expect(result).toMatchObject({ id, status: 'running' });
			expect(provider.steerRun).toHaveBeenCalledWith('sbx-c', 'r1', 'Fix the flaky test first.');
			const turns = await store.listTurns(id);
			expect(turns.at(-1)).toMatchObject({
				role: 'operator',
				text: 'Fix the flaky test first.',
				run_id: 'r1'
			});
		});

		it('refuses a steer when disarmed, on a non-loop, or once the loop has ended', async () => {
			const provider = controlledProvider();
			const deps = {
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				agent_choices: LOOP_CHOICES
			};
			const id = await runningLoop();

			await expect(
				steerDispatch(PROJECT.id, id, 'Hi.', { ...deps, policy: { ...ALLOW_ALL, armed: false } })
			).rejects.toMatchObject({ code: 'forbidden', message: DISARMED_DISPATCH_MESSAGE });
			await expect(
				steerDispatch(PROJECT.id, id, 'Hi.', {
					...deps,
					policy: { armed: true, allow: { file: true, tackle: false } }
				})
			).rejects.toMatchObject({ code: 'forbidden', message: LOOP_NOT_ALLOWED_MESSAGE });

			const { record: tackle } = await store.create({
				idempotency_key: 'idem-loop-ctl-tackle',
				project_id: PROJECT.id,
				dolt_database: PROJECT.dolt_database,
				operation: 'tackle',
				actor: 'web',
				payload: { operation: 'tackle', issue_id: ISSUE.id }
			});
			await expect(steerDispatch(PROJECT.id, tackle.id, 'Hi.', deps)).rejects.toMatchObject({
				code: 'conflict',
				message: NOT_A_LOOP_MESSAGE
			});

			const ended = await runningLoop('succeeded');
			await expect(steerDispatch(PROJECT.id, ended, 'Hi.', deps)).rejects.toMatchObject({
				code: 'conflict',
				message: LOOP_NOT_RUNNING_MESSAGE
			});
			expect(provider.steerRun).not.toHaveBeenCalled();
			expect(await steerDispatch('d_other', id, 'Hi.', deps)).toBeUndefined();
		});

		it('refuses a runner without steer', async () => {
			const provider = controlledProvider({ steerRun: undefined });
			const id = await runningLoop();
			await expect(
				steerDispatch(PROJECT.id, id, 'Hi.', {
					store,
					provider,
					configured: true,
					policy: ALLOW_ALL,
					agent_choices: LOOP_CHOICES
				})
			).rejects.toMatchObject({ code: 'forbidden' });
		});

		it('asks for a graceful stop once and shows it on the record, even disarmed', async () => {
			const provider = controlledProvider();
			const id = await runningLoop();
			const deps = {
				store,
				provider,
				configured: true,
				policy: { ...ALLOW_ALL, armed: false }
			};

			const first = await stopDispatchAfterIteration(PROJECT.id, id, deps);
			const second = await stopDispatchAfterIteration(PROJECT.id, id, deps);

			expect(first?.loop).toMatchObject({ mode: 'build', stop_requested: true });
			expect(first?.status).toBe('running');
			expect(second?.loop?.stop_requested).toBe(true);
			expect(provider.stopRunAfterIteration).toHaveBeenCalledTimes(1);
			expect(provider.stopRunAfterIteration).toHaveBeenCalledWith('sbx-c', 'r1');
		});

		it('reports how the loop ended when it finished before the stop arrived', async () => {
			let ended = false;
			const provider = controlledProvider({
				getRun: vi.fn(async () =>
					ended
						? {
								status: 'succeeded' as const,
								result_summary: 'Stopped: no open plan items are left.',
								loop_end: { stop_reason: 'plan_complete' as const, needs_person: false }
							}
						: { status: 'running' as const }
				),
				stopRunAfterIteration: vi.fn(async () => {
					ended = true;
					throw new DispatchError('conflict', LOOP_NOT_RUNNING_MESSAGE);
				})
			});
			const id = await runningLoop();
			const deps = {
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				agent_choices: LOOP_CHOICES
			};

			const result = await stopDispatchAfterIteration(PROJECT.id, id, deps);

			expect(result).toMatchObject({ status: 'succeeded', loop: { stop_reason: 'plan_complete' } });
			expect(result?.loop?.stop_requested).toBeUndefined();
			// Now it has ended: a second ask is refused before reaching the runner.
			await expect(stopDispatchAfterIteration(PROJECT.id, id, deps)).rejects.toMatchObject({
				code: 'conflict',
				message: LOOP_NOT_RUNNING_MESSAGE
			});
			expect(provider.stopRunAfterIteration).toHaveBeenCalledTimes(1);
		});

		it('a new run clears the stop request', async () => {
			const provider = controlledProvider();
			const id = await runningLoop();
			await stopDispatchAfterIteration(PROJECT.id, id, {
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				agent_choices: LOOP_CHOICES
			});
			await store.updateStatus(id, { status: 'cancelled' });
			await store.startFollowUp(id, { run_id: 'r2', status: 'launched' });
			expect((await store.get(id))?.loop_stop_requested).toBeUndefined();
		});
	});

	describe('loop restart', () => {
		function restartableProvider(patch: Partial<AgentProvider> = {}): AgentProvider {
			return {
				...loopProvider(async () => ({ agent_id: 'sbx-r', run_id: 'r1' })),
				restartLoop: vi.fn(async () => ({ agent_id: 'sbx-s', run_id: 'r2' })),
				...patch
			};
		}

		async function loopIn(status: 'running' | 'succeeded' | 'failed', key: string) {
			const { record } = await store.create({
				idempotency_key: `idem-loop-restart-${key}`,
				project_id: PROJECT.id,
				dolt_database: PROJECT.dolt_database,
				operation: 'loop',
				actor: 'web',
				payload: BUILD_LOOP
			});
			await store.updateStatus(record.id, {
				status,
				provider: 'e2b',
				agent_id: 'sbx-r',
				run_id: 'r1',
				...(status === 'running'
					? {}
					: { loop_end: { stop_reason: 'max_iterations' as const, needs_person: true } })
			});
			return record.id;
		}

		const deps = (provider: AgentProvider) => ({
			store,
			provider,
			configured: true,
			policy: ALLOW_ALL,
			agent_choices: LOOP_CHOICES,
			repositories: BEADS_WEB_MAP,
			schedule_background: NO_BACKGROUND
		});

		it('starts a new run with the stored flags and a new limit, grouped apart from the first', async () => {
			const provider = restartableProvider();
			const id = await loopIn('succeeded', 'ok');
			await store.recordLoopIterations(id, 'r1', [ITERATION]);

			const result = await restartDispatch(PROJECT.id, id, { max_iterations: 2 }, deps(provider));

			expect(result).toMatchObject({ id, status: 'launched', agent_id: 'sbx-s' });
			expect(result?.loop?.stop_reason).toBeUndefined();
			expect(result?.loop?.needs_person).toBeUndefined();
			expect(provider.restartLoop).toHaveBeenCalledWith('sbx-r', 'r1', {
				name: 'Loop build on beads_web',
				dolt_database: 'beads_web',
				repository: { url: 'https://github.com/example-org/beads-web', starting_ref: 'main' },
				loop: {
					mode: 'build',
					harness: 'claude',
					model: 'opus',
					effort: 'high',
					max_iterations: 2,
					iteration_timeout_minutes: 30
				}
			});
			const stored = await store.get(id);
			expect(stored).toMatchObject({ agent_id: 'sbx-s', run_id: 'r2', status: 'launched' });
			// The new limit is this run's; the launch payload stays as launched.
			expect(stored?.payload).toEqual(BUILD_LOOP);
			expect((await store.listTurns(id)).at(-1)).toMatchObject({
				role: 'operator',
				text: 'Restart the loop for up to 2 iterations.'
			});
			expect((await store.listTurns(id)).at(-1)?.run_id).toBeUndefined();

			await store.recordLoopIterations(id, 'r2', [ITERATION]);
			const iterations = await listLoopIterations(PROJECT.id, id, { store });
			expect(iterations?.map((it) => [it.run_id, it.iteration])).toEqual([
				['r1', 1],
				['r2', 1]
			]);
		});

		it('keeps the stored limit when none is given, and restarts a failed loop', async () => {
			const provider = restartableProvider();
			const id = await loopIn('failed', 'failed');
			await restartDispatch(PROJECT.id, id, {}, deps(provider));
			const input = vi.mocked(provider.restartLoop!).mock.calls[0][2];
			expect(input.loop.max_iterations).toBe(5);
			expect((await store.listTurns(id)).at(-1)?.text).toBe('Restart the loop.');
		});

		it('refuses a working loop, a one-shot mission, a disarmed service and a runner without restart', async () => {
			const provider = restartableProvider();
			const running = await loopIn('running', 'running');
			await expect(restartDispatch(PROJECT.id, running, {}, deps(provider))).rejects.toMatchObject({
				code: 'conflict',
				message: LOOP_STILL_RUNNING_MESSAGE
			});

			const { record: tackle } = await store.create({
				idempotency_key: 'idem-loop-restart-tackle',
				project_id: PROJECT.id,
				dolt_database: PROJECT.dolt_database,
				operation: 'tackle',
				actor: 'web',
				payload: { operation: 'tackle', issue_id: ISSUE.id }
			});
			await expect(
				restartDispatch(PROJECT.id, tackle.id, {}, deps(provider))
			).rejects.toMatchObject({ code: 'conflict', message: RESTART_NOT_A_LOOP_MESSAGE });

			const ended = await loopIn('succeeded', 'refused');
			await expect(
				restartDispatch(
					PROJECT.id,
					ended,
					{},
					{
						...deps(provider),
						policy: { ...ALLOW_ALL, armed: false }
					}
				)
			).rejects.toMatchObject({ code: 'forbidden', message: DISARMED_DISPATCH_MESSAGE });
			await expect(
				restartDispatch(
					PROJECT.id,
					ended,
					{},
					{
						...deps(provider),
						policy: { armed: true, allow: { file: true, tackle: false } }
					}
				)
			).rejects.toMatchObject({ code: 'forbidden', message: LOOP_NOT_ALLOWED_MESSAGE });
			await expect(
				restartDispatch(
					PROJECT.id,
					ended,
					{},
					deps(restartableProvider({ restartLoop: undefined }))
				)
			).rejects.toMatchObject({ code: 'forbidden' });
			expect(await restartDispatch('d_other', ended, {}, deps(provider))).toBeUndefined();

			expect(provider.restartLoop).not.toHaveBeenCalled();
			expect((await store.get(ended))?.status).toBe('succeeded');
		});

		it('refuses before claiming when the project lost its Tackle checkout', async () => {
			const provider = restartableProvider();
			const id = await loopIn('succeeded', 'unmapped');
			await expect(
				restartDispatch(PROJECT.id, id, {}, { ...deps(provider), repositories: {} })
			).rejects.toMatchObject({ code: 'conflict', message: UNMAPPED_TACKLE_MESSAGE });
			expect((await store.get(id))?.status).toBe('succeeded');
		});

		it('records a runner refusal on the mission and passes it on', async () => {
			const provider = restartableProvider({
				restartLoop: vi.fn(async () => {
					throw new DispatchError('unavailable', 'Sand could not restart the loop.');
				})
			});
			const id = await loopIn('succeeded', 'refusal');
			await expect(restartDispatch(PROJECT.id, id, {}, deps(provider))).rejects.toMatchObject({
				code: 'unavailable',
				message: 'Sand could not restart the loop.'
			});
			expect(await store.get(id)).toMatchObject({
				status: 'failed',
				error_message: 'Sand could not restart the loop.',
				agent_id: 'sbx-r',
				run_id: 'r1'
			});
			expect((await store.listTurns(id)).at(-1)).toMatchObject({ role: 'agent', status: 'failed' });
		});

		it('lets only one of two concurrent restarts reach the runner', async () => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => (release = resolve));
			const provider = restartableProvider({
				restartLoop: vi.fn(async () => {
					await gate;
					return { agent_id: 'sbx-s', run_id: 'r2' };
				})
			});
			const id = await loopIn('succeeded', 'race');
			const first = restartDispatch(PROJECT.id, id, {}, deps(provider));
			const second = restartDispatch(PROJECT.id, id, {}, deps(provider));
			const settled = Promise.allSettled([first, second]);
			await new Promise((resolve) => setTimeout(resolve, 20));
			release();
			const outcomes = await settled;
			expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
			expect(outcomes.find((o) => o.status === 'rejected')).toMatchObject({
				reason: { code: 'conflict', message: LOOP_STILL_RUNNING_MESSAGE }
			});
			expect(provider.restartLoop).toHaveBeenCalledTimes(1);
		});
	});
});

describe('model and effort per launch', () => {
	const CHOICES = { models: ['opus', 'sonnet'], efforts: ['medium', 'high'] };

	function sandProvider(launch: AgentProvider['launch']): AgentProvider {
		return { ...providerWithLaunch(launch), id: 'e2b', label: 'Sand' };
	}

	function fileLaunch(key: string, choice: { model?: string; effort?: string }) {
		return {
			idempotency_key: key,
			project: PROJECT,
			actor: 'web',
			payload: { operation: 'file' as const, notes: 'notes', ...choice }
		};
	}

	it('passes an offered model and effort to the runner and shows them on the record', async () => {
		const launch = vi.fn(async (_input: AgentLaunchInput) => ({ agent_id: 'sbx-1' }));
		const result = await enqueueDispatch(
			fileLaunch('idem-choice-01', { model: 'opus', effort: 'medium' }),
			{
				store,
				provider: sandProvider(launch),
				configured: true,
				policy: ALLOW_ALL,
				agent_choices: CHOICES,
				schedule_background: NO_BACKGROUND
			}
		);

		expect(launch).toHaveBeenCalledWith(
			expect.objectContaining({ model: 'opus', effort: 'medium' })
		);
		expect(result.request).toMatchObject({ model: 'opus', effort: 'medium' });
	});

	it('leaves the runner its default when the launch asks for nothing', async () => {
		const launch = vi.fn(async (_input: AgentLaunchInput) => ({ agent_id: 'sbx-2' }));
		// No choices offered at all: a launch that does not ask still goes.
		const result = await enqueueDispatch(fileLaunch('idem-choice-02', {}), {
			store,
			provider: providerWithLaunch(launch),
			configured: true,
			policy: ALLOW_ALL,
			agent_choices: { models: [], efforts: [] },
			schedule_background: NO_BACKGROUND
		});

		const input = launch.mock.calls[0]![0];
		expect(input).not.toHaveProperty('model');
		expect(input).not.toHaveProperty('effort');
		expect(result.request.model).toBeUndefined();
		expect(result.request.effort).toBeUndefined();
	});

	it.each([
		[{ model: 'claude-mythos' }, MODEL_NOT_OFFERED_MESSAGE],
		[{ effort: 'max' }, EFFORT_NOT_OFFERED_MESSAGE],
		[{ model: 'opus', effort: 'max' }, EFFORT_NOT_OFFERED_MESSAGE]
	])(
		'refuses %o when the operator does not offer it, before recording',
		async (choice, message) => {
			const launch = vi.fn(async () => ({ agent_id: 'never' }));
			await expect(
				enqueueDispatch(fileLaunch('idem-choice-03', choice), {
					store,
					provider: sandProvider(launch),
					configured: true,
					policy: ALLOW_ALL,
					agent_choices: CHOICES,
					schedule_background: NO_BACKGROUND
				})
			).rejects.toMatchObject({ code: 'bad_request', message });
			expect(launch).not.toHaveBeenCalled();
			expect(await store.list({ limit: 10 })).toEqual([]);
		}
	);

	it('refuses a choice on a runner that cannot honour it', async () => {
		const launch = vi.fn(async () => ({ agent_id: 'never' }));
		await expect(
			enqueueDispatch(fileLaunch('idem-choice-04', { model: 'opus' }), {
				store,
				provider: providerWithLaunch(launch),
				configured: true,
				policy: ALLOW_ALL,
				agent_choices: CHOICES,
				schedule_background: NO_BACKGROUND
			})
		).rejects.toMatchObject({ code: 'forbidden', message: MODELS_NOT_SUPPORTED_MESSAGE });
		expect(launch).not.toHaveBeenCalled();
		expect(await store.list({ limit: 10 })).toEqual([]);
	});
});
