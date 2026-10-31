#!/bin/sh
set -eu
export DOLT_ROOT_PASSWORD="$(cat /run/secrets/dolt-root-password)"
export DOLT_ROOT_HOST=localhost
exec /usr/bin/tini -- /usr/local/bin/docker-entrypoint.sh "$@"
