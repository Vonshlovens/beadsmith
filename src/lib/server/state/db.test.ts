import { createClient, type Client } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { STATE_SCHEMA_SQL, createStateStore, initStateSchema, type StateStore } from './db.js';

let client: Client;
let store: StateStore;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createStateStore(client);
});

describe('initStateSchema', () => {
	it('creates the preference and dispatch tables idempotently', async () => {
		await initStateSchema(client);

		const result = await client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
		);
		expect(
			result.rows.map((row) => {
				return (row as unknown as { name: string }).name;
			})
		).toEqual([
			'auth_account',
			'auth_session',
			'auth_user',
			'auth_verification',
			'backup_runs',
			'dispatch_loop_iterations',
			'dispatch_project_allows',
			'dispatch_requests',
			'dispatch_turns',
			'file_checkout_maps',
			'mate_chats',
			'mate_crew_calls',
			'mate_events',
			'settings',
			'tackle_repository_maps',
			'terminal_relay_sessions',
			'todo_comments',
			'todo_route_issues',
			'todos'
		]);
	});

	it('declares the application, todo, account and relay audit tables and indexes', () => {
		expect(STATE_SCHEMA_SQL).toHaveLength(25);
	});

	it('adds run result columns to an existing table', async () => {
		const existing = createClient({ url: ':memory:' });
		await existing.execute(`CREATE TABLE dispatch_requests (
			id TEXT PRIMARY KEY,
			idempotency_key TEXT NOT NULL UNIQUE,
			project_id TEXT NOT NULL,
			dolt_database TEXT NOT NULL,
			operation TEXT NOT NULL,
			actor TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			status TEXT NOT NULL,
			agent_id TEXT,
			agent_url TEXT,
			run_id TEXT,
			error_message TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`);
		await existing.execute(`INSERT INTO dispatch_requests VALUES (
			'dq_1', 'idem-1', 'd_beads_web', 'beads_web', 'file', 'web', '{}', 'succeeded',
			'bc-1', 'https://runner.example.com/agents/bc-1', 'run-1', NULL,
			'2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
		)`);

		await initStateSchema(existing);
		await initStateSchema(existing);

		const result = await existing.execute('PRAGMA table_info(dispatch_requests)');
		const columns = result.rows.map((row) => String((row as Record<string, unknown>).name));
		expect(columns).toEqual(
			expect.arrayContaining([
				'agent_id',
				'agent_url',
				'run_id',
				'result_summary',
				'duration_ms',
				'git_pr_url',
				'provider',
				'chat_id'
			])
		);
		const row = await existing.execute(
			'SELECT agent_id, agent_url, run_id, chat_id FROM dispatch_requests'
		);
		expect(row.rows[0]).toMatchObject({
			agent_id: 'bc-1',
			agent_url: 'https://runner.example.com/agents/bc-1',
			run_id: 'run-1',
			// Missions from before crew tools came from no chat.
			chat_id: null
		});
	});

	it('marks missions that ended before chat notices existed as already told', async () => {
		const existing = createClient({ url: ':memory:' });
		await existing.execute(`CREATE TABLE dispatch_requests (
			id TEXT PRIMARY KEY,
			idempotency_key TEXT NOT NULL UNIQUE,
			project_id TEXT NOT NULL,
			dolt_database TEXT NOT NULL,
			operation TEXT NOT NULL,
			actor TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			status TEXT NOT NULL,
			agent_id TEXT,
			agent_url TEXT,
			run_id TEXT,
			error_message TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			chat_id TEXT
		)`);
		const at = '2026-11-09T00:00:00.000Z';
		for (const [id, status] of [
			['dq_done', 'succeeded'],
			['dq_live', 'launched']
		]) {
			await existing.execute({
				sql: `INSERT INTO dispatch_requests (id, idempotency_key, project_id, dolt_database,
					operation, actor, payload_json, status, run_id, created_at, updated_at, chat_id)
					VALUES (?, ?, 'd_a', 'a', 'tackle', 'web', '{}', ?, 'run-1', ?, ?, 'mc_1')`,
				args: [id, `idem-${id}`, status, at, at]
			});
		}

		await initStateSchema(existing);

		const rows = await existing.execute(
			'SELECT id, chat_notice FROM dispatch_requests ORDER BY id'
		);
		expect(rows.rows.map((row) => ({ ...row }))).toEqual([
			{ id: 'dq_done', chat_notice: 'succeeded:run-1' },
			{ id: 'dq_live', chat_notice: null }
		]);
	});
});

describe('settings', () => {
	it('round-trips a value', async () => {
		await store.setSetting('theme', 'dark');

		expect(await store.getSetting('theme')).toBe('dark');
	});

	it('overwrites an existing key', async () => {
		await store.setSetting('theme', 'dark');
		await store.setSetting('theme', 'light');

		expect(await store.getSetting('theme')).toBe('light');
	});

	it('returns undefined for an unknown key', async () => {
		expect(await store.getSetting('missing')).toBeUndefined();
	});
});
