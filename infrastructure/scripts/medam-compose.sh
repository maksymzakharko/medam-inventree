#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
[[ -r $root/.env ]] || { printf 'Brak .env. Najpierw infrastructure/scripts/setup.sh.\n' >&2; exit 1; }
# Mode is the only value read here; Compose reads .env itself. Do not source untrusted shell.
mode=$(sed -n 's/^MEDAM_MODE=//p' "$root/.env" | tail -1)
files=(-f "$root/compose.yaml")
if [[ $mode == production ]]; then files+=(-f "$root/compose.production.yaml"); fi
if [[ $mode == restore ]]; then files+=(-f "$root/compose.restore.yaml"); fi
[[ $mode == local || $mode == production || $mode == restore ]] || { printf 'Nieznany MEDAM_MODE.\n' >&2; exit 1; }
exec docker compose --project-directory "$root" --env-file "$root/.env" "${files[@]}" "$@"
