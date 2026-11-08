#!/bin/bash
set -euo pipefail
# This wrapper only configures the official InvenTree process.
export INVENTREE_DB_PASSWORD="$(cat /run/secrets/inventree_db_password)"
exec /bin/bash /home/inventree/init.sh "$@"
