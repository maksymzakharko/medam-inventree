#!/usr/bin/env bash
# Repository integrity check only; no retention, prune, delete or restore is performed.
set -euo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
mode=${1:---metadata}
[[ $# -le 1 && ( $mode == --metadata || $mode == --full ) ]] || { printf 'Użycie: %s [--metadata|--full]\n' "$0" >&2; exit 2; }
command -v restic >/dev/null || { printf 'Brak restic.\n' >&2; exit 1; }
if [[ -n ${RESTIC_ENV_FILE:-} ]]; then
  python3 - "$RESTIC_ENV_FILE" <<'PY'
import os,stat,sys
s=os.lstat(sys.argv[1])
if not stat.S_ISREG(s.st_mode) or s.st_mode & 0o077 or s.st_uid not in (0,os.getuid()):
    raise SystemExit('RESTIC_ENV_FILE must be an operator-owned private regular file.')
PY
  set -a
  # Explicitly configured operator-owned shell file, not repository or downloaded content.
  source "$RESTIC_ENV_FILE"
  set +a
fi
: "${RESTIC_REPOSITORY:?Ustaw repozytorium restic poza VPS}"
: "${RESTIC_PASSWORD_FILE:?Ustaw plik hasła restic}"
[[ -f $RESTIC_PASSWORD_FILE && ! -L $RESTIC_PASSWORD_FILE ]] || { printf 'Nieprawidłowy plik hasła restic.\n' >&2; exit 1; }
permissions=$(stat -c %a "$RESTIC_PASSWORD_FILE")
(( (8#$permissions & 077) == 0 )) || { printf 'Plik hasła restic musi być prywatny.\n' >&2; exit 1; }
failed() {
  code=$?
  trap - EXIT
  if ((code)); then "$root/infrastructure/scripts/alert.sh" 'MEDAM: kontrola integralności repozytorium restic nie powiodła się.' || true; fi
  exit "$code"
}
trap failed EXIT
if [[ $mode == --full ]]; then restic check --read-data; else restic check; fi
printf 'Kontrola restic zakończona. Nie zastępuje testu uruchomienia odtworzonej aplikacji.\n'
