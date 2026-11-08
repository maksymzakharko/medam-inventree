#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
compose="$root/infrastructure/scripts/medam-compose.sh"
secret_dir=$(sed -n 's/^SECRETS_DIR=//p' "$root/.env" | tail -1)
secret_dir=${secret_dir:-./secrets}
[[ $secret_dir == /* ]] || secret_dir="$root/$secret_dir"
[[ -d $secret_dir && ! -L $secret_dir ]] || { printf 'Nieprawidłowy katalog sekretów.\n' >&2; exit 1; }
[[ $# -eq 1 ]] || { printf 'Użycie: %s LOGIN_ADMINISTRATORA\n' "$0" >&2; exit 2; }
[[ -t 0 ]] || { printf 'Bootstrap wymaga interaktywnego terminala do ustawienia hasła.\n' >&2; exit 2; }
"$compose" build api edge
"$compose" up -d app-db inventree-db inventree-cache inventree-server inventree-worker
"$compose" run --rm --no-deps -T -v "$secret_dir:/medam-secrets:rw" inventree-server python /medam/inventree-bootstrap.py
"$compose" run --rm --no-deps migrate
"$compose" run --rm --no-deps app-grants
"$compose" run --rm --no-deps app-cli dist/cli/index.js bootstrap-admin --login "$1"
printf '\nSkopiuj UUID administratora pokazany powyżej. Następnie:\n'
printf '  infrastructure/scripts/medam-compose.sh run --rm --no-deps app-cli dist/cli/index.js sync-warehouses --actor UUID\n'
printf '  infrastructure/scripts/finalize-bootstrap.sh\n'
printf 'Nie dodano produktów ani rzeczywistych stanów magazynowych.\n'
