#!/bin/sh
set -eu
export POSTGRES_PASSWORD="$(cat /run/secrets/inventree_pg_admin_password)"
export INVENTREE_OWNER_PASSWORD="$(cat /run/secrets/inventree_db_password)"
exec docker-entrypoint.sh "$@"
