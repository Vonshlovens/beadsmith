#!/usr/bin/env bash
# Runs once, on Dolt's first start, after the 20-*.sql sample projects load.
# Creates the read-only SQL user Beadsmith connects as (Beadsmith needs only
# SELECT) and records the loaded projects as one Dolt commit each.
set -euo pipefail

password=$(cat /run/quickstart/dolt-password)
dolt sql -q "CREATE USER IF NOT EXISTS 'beadsmith'@'%' IDENTIFIED BY '${password}'; GRANT SELECT ON *.* TO 'beadsmith'@'%';"

for file in /docker-entrypoint-initdb.d/20-*.sql; do
	db=${file##*/20-}
	db=${db%.sql}
	# Nothing to commit is fine: the data is readable either way.
	dolt --use-db "$db" sql -q "CALL DOLT_COMMIT('-Am', 'Load the Beadsmith sample project', '--author', 'Beadsmith quickstart <quickstart@example.com>')" >/dev/null || true
done
