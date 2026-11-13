#!/bin/sh
set -eu
export POSTGRES_PASSWORD="$(cat /run/secrets/app_pg_admin_password)"
export MEDAM_RUNTIME_PASSWORD="$(cat /run/secrets/app_runtime_password)"
export MEDAM_MIGRATOR_PASSWORD="$(cat /run/secrets/app_migrator_password)"
exec docker-entrypoint.sh "$@"
