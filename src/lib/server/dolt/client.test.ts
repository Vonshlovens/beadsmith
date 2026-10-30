import { describe, expect, it } from 'vitest';
import {
	DoltConnectionError,
	DoltError,
	buildIssueWhere,
	clampLimit,
	createDoltClient,
	isDoltConnectionError,
	isUserDatabase,
	quoteDatabase,
	toDoltConnectionError,
	toIso,
	type QueryFn,
	type SqlRow
} from './client.js';
import { DoltCredentialError } from '../dolt-password.js';

interface Recorded {
	sql: string;
	params: unknown[];
}

/**
 * Build a recording fake query executor.
 * @param responder Returns rows for a given statement.
 */
function fakeQuery(responder: (sql: string, params: unknown[]) => SqlRow[]): {
	query: QueryFn;
	calls: Recorded[];
} {
	const calls: Recorded[] = [];
	const query: QueryFn = async (sql, params) => {
		calls.push({ sql, params });
		return responder(sql, params);
	};
	return { query, calls };
}

describe('quoteDatabase', () => {
	it('backtick-quotes a valid name', () => {
		expect(quoteDatabase('acme_platform')).toBe('`acme_platform`');
	});

	it('throws on an injection attempt', () => {
		expect(() => {
			return quoteDatabase('a`; DROP DATABASE x; --');
		}).toThrow(DoltError);
	});

	it('throws on uppercase and hyphenated names', () => {
		expect(() => {
			return quoteDatabase('ACME');
		}).toThrow(DoltError);
		expect(() => {
			return quoteDatabase('acme-platform');
		}).toThrow(DoltError);
	});

	it('throws on an over-long name', () => {
		expect(() => {
			return quoteDatabase('a'.repeat(65));
		}).toThrow(DoltError);
	});
});

describe('toDoltConnectionError', () => {
	it('classifies a missing protected credential without retaining its details', () => {
		const source = new DoltCredentialError('credential file /run/private/password was unreadable');
		const error = toDoltConnectionError(source);

		expect(error).toBeInstanceOf(DoltConnectionError);
		expect(error).toBeInstanceOf(DoltError);
		expect(error.name).toBe('DoltError');
		expect(error.kind).toBe('credential_unavailable');
		expect(error.message).toBe(
			'Protected Dolt authentication is unavailable. Check the service credential configuration.'
		);
		expect(error.message).not.toContain('/run/private/password');
		expect(error.stack).not.toContain('/run/private/password');
		expect(isDoltConnectionError(error)).toBe(true);
	});

	it.each([{ code: 'ER_ACCESS_DENIED_ERROR' }, { code: '28000' }, { sqlState: '28000' }])(
		'classifies SQL authentication code $code$sqlState',
		(source) => {
			const error = toDoltConnectionError(
				Object.assign(
					new Error('Access denied for user app at private-host; password=not-safe'),
					source
				)
			);

			expect(error.kind).toBe('authentication_rejected');
			expect(error.message).toBe(
				'Dolt authentication was rejected. Check the configured service credentials.'
			);
			expect(error.message).not.toContain('private-host');
			expect(error.message).not.toContain('not-safe');
			expect(error.stack).not.toContain('private-host');
			expect(error.stack).not.toContain('not-safe');
		}
	);

	it.each([
		'EAI_AGAIN',
		'ECONNABORTED',
		'ECONNREFUSED',
		'ECONNRESET',
		'EHOSTDOWN',
		'EHOSTUNREACH',
		'ENETDOWN',
		'ENETRESET',
		'ENETUNREACH',
		'ENOTCONN',
		'ENOTFOUND',
		'EPIPE',
		'ETIMEDOUT',
		'PROTOCOL_CONNECTION_LOST',
		'PROTOCOL_SEQUENCE_TIMEOUT'
	])('classifies the $code transport error code', (code) => {
		const error = toDoltConnectionError({
			code,
			message: 'connect private-host:3306 as sql-user with password=not-safe'
		});

		expect(error.kind).toBe('unreachable');
		expect(error.message).toBe(
			'Dolt server is unreachable. Check the service connection configuration.'
		);
		expect(error.message).not.toContain('private-host');
		expect(error.message).not.toContain('sql-user');
		expect(error.message).not.toContain('not-safe');
	});

	it('uses unknown for unrecognised errors instead of matching their message', () => {
		const error = toDoltConnectionError(
			new Error('Access denied for user sql-user on private-host; password=not-safe')
		);

		expect(error.kind).toBe('unknown');
		expect(error.message).toBe(
			'Dolt connection failed. Check the service connection configuration.'
		);
		expect(error.message).not.toContain('sql-user');
		expect(error.message).not.toContain('private-host');
		expect(error.message).not.toContain('not-safe');
	});

	it('preserves an already-safe connection error', () => {
		const source = new DoltConnectionError('unreachable');

		expect(toDoltConnectionError(source)).toBe(source);
	});

	it('treats non-string or inaccessible codes as unknown', () => {
		const inaccessible = {};
		Object.defineProperty(inaccessible, 'code', {
			get() {
				throw new Error('private driver diagnostic');
			}
		});

		expect(toDoltConnectionError({ code: 1045 }).kind).toBe('unknown');
		expect(toDoltConnectionError(inaccessible).kind).toBe('unknown');
	});
});

describe('isUserDatabase', () => {
	it('excludes the MySQL system databases', () => {
		expect(isUserDatabase('information_schema')).toBe(false);
		expect(isUserDatabase('mysql')).toBe(false);
	});

	it('excludes dolt system databases', () => {
		expect(isUserDatabase('dolt_ci')).toBe(false);
	});

	it('includes project databases', () => {
		expect(isUserDatabase('acme_platform')).toBe(true);
	});
});

describe('clampLimit', () => {
	it('falls back for undefined', () => {
		expect(clampLimit(undefined, 25)).toBe(25);
	});

	it('floors values below one', () => {
		expect(clampLimit(0)).toBe(1);
		expect(clampLimit(-10)).toBe(1);
	});

	it('caps very large values', () => {
		expect(clampLimit(1_000_000)).toBe(1000);
	});

	it('truncates fractional values', () => {
		expect(clampLimit(10.9)).toBe(10);
	});
});

describe('toIso', () => {
	it('converts a Date', () => {
		expect(toIso(new Date('2026-07-30T05:07:48Z'))).toBe('2026-07-30T05:07:48.000Z');
	});

	it('converts a MySQL datetime string', () => {
		expect(toIso('2026-07-30 05:07:48')).toBe('2026-07-30T05:07:48.000Z');
	});

	it('returns undefined for null', () => {
		expect(toIso(null)).toBeUndefined();
	});
});

describe('buildIssueWhere', () => {
	it('excludes closed issues by default', () => {
		const where = buildIssueWhere({});

		expect(where.clause).toBe('WHERE i.status <> ?');
		expect(where.params).toEqual(['closed']);
	});

	it('adds no status clause when closed issues are included', () => {
		const where = buildIssueWhere({ include_closed: true });

		expect(where.clause).toBe('');
	});

	it('expands a comma status list into bound placeholders', () => {
		const where = buildIssueWhere({ status: 'open,in_progress' });

		expect(where.clause).toBe('WHERE i.status IN (?, ?)');
		expect(where.params).toEqual(['open', 'in_progress']);
	});

	it('binds the search term rather than interpolating it', () => {
		const where = buildIssueWhere({ q: "'; DROP TABLE issues; --" });

		expect(where.clause).toContain('i.id LIKE ?');
		expect(where.clause).toContain('i.title LIKE ?');
		expect(where.clause).toContain('q_label.label LIKE ?');
		expect(where.params[1]).toContain('DROP TABLE');
		expect(where.clause).not.toContain('DROP TABLE');
	});

	it('escapes LIKE wildcards in the search term', () => {
		const where = buildIssueWhere({ q: '100%', include_closed: true });

		expect(where.params).toEqual(['%100\\%%', '%100\\%%', '%100\\%%']);
	});

	it('binds single type and priority values through IN clauses', () => {
		const where = buildIssueWhere({ include_closed: true, type: 'bug', priority: '1' });

		expect(where.clause).toBe('WHERE i.issue_type IN (?) AND i.priority IN (?)');
		expect(where.params).toEqual(['bug', 1]);
	});

	it('expands comma-separated type and priority lists into bound placeholders', () => {
		const where = buildIssueWhere({
			include_closed: true,
			type: 'bug, feature,task',
			priority: '0, 2,4'
		});

		expect(where.clause).toBe('WHERE i.issue_type IN (?, ?, ?) AND i.priority IN (?, ?, ?)');
		expect(where.params).toEqual(['bug', 'feature', 'task', 0, 2, 4]);
	});

	it('searches id, title, and label candidates with the same bound pattern', () => {
		const where = buildIssueWhere({ include_closed: true, q: 'needle' });

		expect(where.clause).toBe(
			'WHERE (i.id LIKE ? OR i.title LIKE ? OR EXISTS (' +
				'SELECT 1 FROM labels q_label ' +
				'WHERE q_label.issue_id = i.id AND q_label.label LIKE ?))'
		);
		expect(where.params).toEqual(['%needle%', '%needle%', '%needle%']);
	});

	it('uses an exact bound label-membership filter', () => {
		const attack = "infra' OR 1=1 --";
		const where = buildIssueWhere({ include_closed: true, label: attack });

		expect(where.clause).toBe(
			'WHERE EXISTS (SELECT 1 FROM labels exact_label ' +
				'WHERE exact_label.issue_id = i.id AND exact_label.label = ?)'
		);
		expect(where.params).toEqual([attack]);
		expect(where.clause).not.toContain(attack);
	});

	it('never interpolates comma-list values into SQL', () => {
		const attack = "bug') OR 1=1 --";
		const where = buildIssueWhere({
			include_closed: true,
			type: `task,${attack}`,
			priority: '0,4'
		});

		expect(where.clause).toBe('WHERE i.issue_type IN (?, ?) AND i.priority IN (?, ?)');
		expect(where.params).toEqual(['task', attack, 0, 4]);
		expect(where.clause).not.toContain(attack);
	});
});

describe('createDoltClient', () => {
	it('filters system databases out of SHOW DATABASES', async () => {
		const { query } = fakeQuery(() => {
			return [
				{ Database: 'acme_platform' },
				{ Database: 'information_schema' },
				{ Database: 'mysql' },
				{ Database: 'draw' }
			];
		});
		const client = createDoltClient(query);

		const databases = await client.listDatabases();

		expect(databases).toEqual(['acme_platform', 'draw']);
	});

	it('groups issue counts by status', async () => {
		const { query } = fakeQuery(() => {
			return [
				{ status: 'open', n: 3 },
				{ status: 'closed', n: 7 },
				{ status: 'deferred', n: 2 }
			];
		});
		const client = createDoltClient(query);

		const counts = await client.issueCounts('acme_platform');

		expect(counts).toEqual({ open: 3, in_progress: 0, blocked: 0, closed: 7, total: 12 });
	});

	it('queries dependents by depends_on_issue_id', async () => {
		const { query, calls } = fakeQuery(() => {
			return [{ id: 'bd-2', dep_type: 'blocks', title: 'Consumer' }];
		});
		const client = createDoltClient(query);

		const refs = await client.dependents('acme_platform', 'bd-1');

		expect(calls[0].sql).toContain('d.depends_on_issue_id = ?');
		expect(calls[0].params).toEqual(['bd-1']);
		expect(refs[0]).toMatchObject({ id: 'bd-2', dep_type: 'blocks' });
	});

	it('emits a single statement per query', async () => {
		const { query, calls } = fakeQuery(() => {
			return [];
		});
		const client = createDoltClient(query);

		await client.browseIssues('acme_platform', { limit: 10 });

		expect(calls[0].sql.replace(/;\s*$/, '')).not.toContain(';');
	});

	it('interpolates only a clamped integer limit', async () => {
		const { query, calls } = fakeQuery(() => {
			return [];
		});
		const client = createDoltClient(query);

		await client.browseIssues('acme_platform', { limit: 999_999 });

		expect(calls[0].sql).toContain('LIMIT 1000');
	});

	it('qualifies q and exact-label subqueries with the validated database', async () => {
		const { query, calls } = fakeQuery(() => {
			return [];
		});
		const client = createDoltClient(query);

		await client.browseIssues('acme_platform', {
			q: "needle' OR 1=1 --",
			label: 'infra',
			limit: 10
		});

		expect(calls[0].sql).toContain('FROM `acme_platform`.labels q_label');
		expect(calls[0].sql).toContain('FROM `acme_platform`.labels exact_label');
		expect(calls[0].sql).not.toContain("needle' OR 1=1 --");
		expect(calls[0].params).toEqual([
			'closed',
			"%needle' OR 1=1 --%",
			"%needle' OR 1=1 --%",
			"%needle' OR 1=1 --%",
			'infra'
		]);
	});

	it('joins labels onto browsed issues', async () => {
		const { query } = fakeQuery((sql) => {
			if (sql.includes('.labels')) {
				return [
					{ issue_id: 'bd-1', label: 'infra' },
					{ issue_id: 'bd-1', label: 'dx' }
				];
			}
			return [{ id: 'bd-1', title: 'One', status: 'open', priority: 1, issue_type: 'task' }];
		});
		const client = createDoltClient(query);

		const issues = await client.browseIssues('acme_platform', { limit: 10 });

		expect(issues[0].labels).toEqual(['infra', 'dx']);
	});

	it('returns undefined when the issue row is missing', async () => {
		const { query } = fakeQuery(() => {
			return [];
		});
		const client = createDoltClient(query);

		expect(await client.issueDetail('acme_platform', 'bd-404')).toBeUndefined();
	});

	it('assembles dependencies, dependents, and comments for a detail view', async () => {
		const { query } = fakeQuery((sql) => {
			if (sql.includes('FROM `acme_platform`.issues i WHERE i.id = ?')) {
				return [{ id: 'bd-1', title: 'One', status: 'open', priority: 1, issue_type: 'task' }];
			}
			if (sql.includes('WHERE d.issue_id = ?')) {
				return [{ id: 'bd-2', dep_type: 'blocks' }];
			}
			if (sql.includes('WHERE d.depends_on_issue_id = ?')) {
				return [{ id: 'bd-3', dep_type: 'related' }];
			}
			if (sql.includes('.comments')) {
				return [{ id: 'c1', author: 'Eric', text: 'note' }];
			}
			return [];
		});
		const client = createDoltClient(query);

		const detail = await client.issueDetail('acme_platform', 'bd-1');

		expect(detail?.dependencies).toEqual([
			{
				id: 'bd-2',
				title: undefined,
				status: undefined,
				priority: undefined,
				issue_type: undefined,
				dep_type: 'blocks'
			}
		]);
		expect(detail?.dependents[0].id).toBe('bd-3');
		expect(detail?.comments[0].text).toBe('note');
	});

	it('orders recent events newest first', async () => {
		const { query, calls } = fakeQuery(() => {
			return [
				{
					issue_id: 'bd-1',
					event_type: 'updated',
					actor: 'agent',
					created_at: '2026-07-30 05:00:00'
				}
			];
		});
		const client = createDoltClient(query);

		const events = await client.recentEvents('acme_platform', 5);

		expect(calls[0].sql).toContain('ORDER BY e.created_at DESC');
		expect(calls[0].sql).toContain('LIMIT 5');
		expect(events[0].actor).toBe('agent');
	});

	it('rejects an invalid database before touching the connection', async () => {
		const { query, calls } = fakeQuery(() => {
			return [];
		});
		const client = createDoltClient(query);

		await expect(client.browseIssues('bad name', { limit: 1 })).rejects.toThrow(DoltError);
		expect(calls).toHaveLength(0);
	});

	it('selects only open issues without open blocks dependencies', async () => {
		const { query, calls } = fakeQuery((sql) => {
			if (sql.includes('.labels')) {
				return [];
			}
			return [{ id: 'bd-ready', title: 'Ready', status: 'open', priority: 1, issue_type: 'task' }];
		});
		const client = createDoltClient(query);

		const issues = await client.listReadyIssues('acme_platform', 25);

		expect(calls[0].sql).toContain('WHERE i.status = ?');
		expect(calls[0].sql).toContain('AND d.type = ?');
		expect(calls[0].sql).toContain('blocker.status <> ?');
		expect(calls[0].sql).toContain('ORDER BY i.priority ASC, i.updated_at DESC');
		expect(calls[0].sql).toContain('LIMIT 25');
		expect(calls[0].sql.replace(/;\s*$/, '')).not.toContain(';');
		expect(calls[0].params).toEqual(['open', 'blocks', 'closed']);
		expect(issues[0].id).toBe('bd-ready');
	});

	it('does not treat related or parent-child edges as Ready blockers', async () => {
		const { query, calls } = fakeQuery(() => {
			return [];
		});
		const client = createDoltClient(query);

		await client.listReadyIssues('acme_platform', 10);

		expect(calls[0].sql).not.toContain("'related'");
		expect(calls[0].sql).not.toContain("'parent-child'");
		expect(calls[0].sql).not.toContain("'discovered-from'");
		expect(calls[0].params).toEqual(['open', 'blocks', 'closed']);
	});

	it('rejects an invalid database on Ready reads before touching the connection', async () => {
		const { query, calls } = fakeQuery(() => {
			return [];
		});
		const client = createDoltClient(query);

		await expect(client.listReadyIssues('bad name', 1)).rejects.toThrow(DoltError);
		expect(calls).toHaveLength(0);
	});
});
