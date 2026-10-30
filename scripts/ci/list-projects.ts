/**
 * Print what Beadsmith's project discovery finds for one Dolt account, as
 * one JSON line: `{"databases": [...], "issues": {"<db>": <total> | null}}`.
 * Used by scripts/ci/dolt-grants-smoke.sh against a throwaway server.
 *
 *   BEADS_DOLT_SERVER_HOST=127.0.0.1 BEADS_DOLT_SERVER_PORT=3306 \
 *   BEADS_DOLT_SERVER_USER=beads_web_reader BEADS_DOLT_PASSWORD=... \
 *   node --import ./scripts/ts-resolve.mjs scripts/ci/list-projects.ts
 */
import mysql from 'mysql2/promise';
import { createDoltClient, type SqlRow } from '../../src/lib/server/dolt/client.ts';

const pool = mysql.createPool({
	host: process.env.BEADS_DOLT_SERVER_HOST ?? '127.0.0.1',
	port: Number(process.env.BEADS_DOLT_SERVER_PORT ?? 3306),
	user: process.env.BEADS_DOLT_SERVER_USER,
	password: process.env.BEADS_DOLT_PASSWORD ?? '',
	connectionLimit: 1
});
try {
	const client = createDoltClient(async (sql, params) => {
		const [rows] = await pool.query(sql, params);
		return Array.isArray(rows) ? (rows as SqlRow[]) : [];
	});
	const databases = await client.listDatabases();
	// null: a database that is not a Beads project (no issues table).
	const issues: Record<string, number | null> = {};
	for (const database of databases) {
		issues[database] = await client.issueCounts(database).then(
			(counts) => counts.total,
			() => null
		);
	}
	console.log(JSON.stringify({ databases, issues }));
} finally {
	await pool.end();
}
