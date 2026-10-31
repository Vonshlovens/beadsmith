import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryFn, SqlRow } from './client.js';
import {
	cachedSchema,
	classifySchema,
	clearSchemaCache,
	inspectSchema,
	REQUIRED_COLUMNS,
	UnsupportedSchemaError
} from './schema.js';

function allColumns(): Set<string> {
	return new Set(
		Object.entries(REQUIRED_COLUMNS).flatMap(([table, columns]) =>
			columns.map((column) => `${table}.${column}`)
		)
	);
}

describe('classifySchema', () => {
	it('supports tested bd minors with every required column', () => {
		expect(classifySchema(allColumns(), '1.3.1', 66)).toEqual({
			status: 'supported',
			bd_version: '1.3.1',
			migration: 66,
			missing: []
		});
		expect(classifySchema(allColumns(), 'v1.1.0', 53).status).toBe('supported');
	});

	it('marks unknown or newer versions untested when columns are present', () => {
		expect(classifySchema(allColumns(), '1.4.0', 70).status).toBe('untested');
		expect(classifySchema(allColumns(), undefined, undefined).status).toBe('untested');
	});

	it('marks a schema unsupported when any required column is gone', () => {
		const present = allColumns();
		present.delete('issues.owner');
		present.delete('comments.text');
		const info = classifySchema(present, '1.3.1', 66);
		expect(info.status).toBe('unsupported');
		expect(info.missing).toEqual(['issues.owner', 'comments.text']);
	});
});

function fakeQuery(
	columns: Set<string>,
	extras: { bd?: string; migration?: number | null } = {}
): QueryFn {
	return vi.fn(async (sql: string): Promise<SqlRow[]> => {
		if (sql.includes('information_schema.COLUMNS')) {
			return [...columns].map((entry) => {
				const [TABLE_NAME, COLUMN_NAME] = entry.split('.');
				return { TABLE_NAME, COLUMN_NAME };
			});
		}
		if (sql.includes('local_metadata')) {
			if (extras.bd === undefined) throw new Error("Table 'local_metadata' doesn't exist");
			return [{ value: extras.bd }];
		}
		if (sql.includes('schema_migrations')) return [{ m: extras.migration ?? null }];
		return [];
	});
}

describe('inspectSchema', () => {
	it('reads columns, bd version, and the newest migration', async () => {
		const info = await inspectSchema(
			fakeQuery(allColumns(), { bd: '1.2.2', migration: 53 }),
			'beads_web'
		);
		expect(info).toEqual({ status: 'supported', bd_version: '1.2.2', migration: 53, missing: [] });
	});

	it('tolerates databases without bd metadata tables', async () => {
		const info = await inspectSchema(fakeQuery(allColumns()), 'beads_web');
		expect(info).toMatchObject({ status: 'untested', bd_version: undefined, migration: undefined });
	});

	it('refuses invalid database names before querying', async () => {
		const query = fakeQuery(allColumns());
		await expect(inspectSchema(query, 'bad`name')).rejects.toThrow('invalid database name');
		expect(query).not.toHaveBeenCalled();
	});
});

describe('cachedSchema', () => {
	beforeEach(() => clearSchemaCache());

	it('caches per database for five minutes', async () => {
		const query = fakeQuery(allColumns(), { bd: '1.3.1', migration: 66 });
		await cachedSchema(query, 'a', 0);
		await cachedSchema(query, 'a', 60_000);
		expect(query).toHaveBeenCalledTimes(3);
		await cachedSchema(query, 'a', 6 * 60_000);
		expect(query).toHaveBeenCalledTimes(6);
	});

	it('does not cache failures', async () => {
		const failing: QueryFn = vi.fn(async () => {
			throw new Error('unreachable');
		});
		await expect(cachedSchema(failing, 'b', 0)).rejects.toThrow('unreachable');
		await expect(cachedSchema(failing, 'b', 1)).rejects.toThrow('unreachable');
		expect(failing).toHaveBeenCalledTimes(2);
	});
});

describe('UnsupportedSchemaError', () => {
	it('names the project and bd version without listing columns', () => {
		const error = new UnsupportedSchemaError('beads_web', {
			status: 'unsupported',
			bd_version: '2.0.0',
			missing: ['issues.owner']
		});
		expect(error.message).toBe(
			'Project beads_web uses a Beads schema this version of Beadsmith cannot read (written by bd 2.0.0).'
		);
	});
});
