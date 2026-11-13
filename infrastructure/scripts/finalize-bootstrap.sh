#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
compose="$root/infrastructure/scripts/medam-compose.sh"
secret_dir=$(sed -n 's/^SECRETS_DIR=//p' "$root/.env" | tail -1)
secret_dir=${secret_dir:-./secrets}
[[ $secret_dir == /* ]] || secret_dir="$root/$secret_dir"
[[ -d $secret_dir && ! -L $secret_dir ]] || { printf 'Nieprawidłowy katalog sekretów.\n' >&2; exit 1; }
# This only removes the temporary permission to create new InvenTree locations.
"$compose" run --rm --no-deps -T -v "$secret_dir:/medam-secrets:rw" inventree-server python /medam/inventree-bootstrap.py --finalize
"$compose" up -d --no-deps --force-recreate api edge
printf 'Bootstrap zakończony. Sprawdź /api/me i wykonaj testy przed pilotażem.\n'
