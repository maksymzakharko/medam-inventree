#!/usr/bin/env bash
# Real, disposable CI stack only. Preserve checkpoints and every Compose resource.
set -euo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
[[ ${CI:-} == true && ${MEDAM_RESTORE_TEST:-} == ci-only-isolated ]] || {
  printf 'Restore verification requires the explicitly selected disposable CI stack.\n' >&2
  exit 1
}
config_value() { sed -n "s/^$1=//p" "$root/.env" | tail -1; }
source_project=$(config_value COMPOSE_PROJECT_NAME)
[[ $source_project =~ ^medam(-[a-z0-9-]+)?$ && $(config_value MEDAM_MODE) == local ]] || {
  printf 'Restore verification requires a local medam CI project.\n' >&2
  exit 1
}
target=/tmp/medam-restore-ci
project=medam-restore-ci
[[ $source_project != "$project" && ! -e $target && ! -L $target ]] || {
  printf 'The isolated restore target must be new and separate from the source.\n' >&2
  exit 1
}
evidence=$(mktemp -d /tmp/medam-restore-evidence.XXXXXXXX)
compose="$root/infrastructure/scripts/medam-compose.sh"
clone=(docker compose --project-directory "$target" --env-file "$target/.env"
  -f "$target/compose.yaml" -f "$target/compose.restore.yaml")
stock_sql='COPY (SELECT id,part_id,location_id,quantity,batch,expiry_date FROM stock_stockitem ORDER BY id) TO STDOUT WITH (FORMAT csv, HEADER true)'
migrations_sql='COPY (SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id) TO STDOUT WITH (FORMAT csv, HEADER true)'

# The preceding live contract creates real stock rows. Never print their contents.
"$compose" exec -T inventree-db psql -X -q -U postgres -d inventree -v ON_ERROR_STOP=1 \
  -c "$stock_sql" > "$evidence/stock.before.csv"
"$compose" exec -T app-db psql -X -q -U postgres -d medam_app -v ON_ERROR_STOP=1 \
  -c "$migrations_sql" > "$evidence/migrations.before.csv"
[[ $(wc -l < "$evidence/stock.before.csv") -gt 1 && $(wc -l < "$evidence/migrations.before.csv") -gt 1 ]] || {
  printf 'Real stock and applied migration records are required before checkpointing.\n' >&2
  exit 1
}
printf 'MEDAM disposable CI media restore marker\n' > "$evidence/media.before.txt"
"$compose" exec -T inventree-server sh -ec \
  'test ! -e /home/inventree/data/media/medam-ci-restore.txt; mkdir -p /home/inventree/data/media; cat > /home/inventree/data/media/medam-ci-restore.txt' \
  < "$evidence/media.before.txt"

# A fresh private directory identifies this exact local checkpoint without offsite credentials.
BACKUP_ROOT="$evidence/checkpoints" "$root/infrastructure/scripts/backup.sh" --local-only
checkpoint=$(python3 - "$evidence/checkpoints" <<'PY'
from pathlib import Path
import re
import sys
checkpoints = [p for p in Path(sys.argv[1]).iterdir()
               if p.is_dir() and re.fullmatch(r'\d{8}T\d{6}Z', p.name)]
if len(checkpoints) != 1:
    raise SystemExit('Expected exactly one completed CI checkpoint.')
print(checkpoints[0])
PY
)
started=$(python3 -c 'import time; print(time.monotonic_ns())')
"$root/infrastructure/scripts/restore.sh" "$checkpoint" --target "$target" --project "$project"

"${clone[@]}" exec -T inventree-db psql -X -q -U postgres -d inventree -v ON_ERROR_STOP=1 \
  -c "$stock_sql" > "$evidence/stock.restored.csv"
"${clone[@]}" exec -T app-db psql -X -q -U postgres -d medam_app -v ON_ERROR_STOP=1 \
  -c "$migrations_sql" > "$evidence/migrations.restored.csv"
"${clone[@]}" exec -T inventree-server cat /home/inventree/data/media/medam-ci-restore.txt \
  > "$evidence/media.restored.txt"
for item in stock migrations media; do
  case "$item" in media) suffix=txt ;; *) suffix=csv ;; esac
  cmp -s "$evidence/$item.before.$suffix" "$evidence/$item.restored.$suffix" || {
    printf 'Restored %s differs from the pre-checkpoint evidence.\n' "$item" >&2
    exit 1
  }
done
"${clone[@]}" exec -T api node --input-type=module -e \
  'const r=await fetch("http://127.0.0.1:3000/health/ready"); if(!r.ok)process.exit(1);const j=await r.json();if(j.status!=="ok"||!j.writesReady)process.exit(1);'
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:18080/health/edge >/dev/null
[[ $(curl --silent --show-error --max-time 15 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:18080/api/me) == 401 ]]
python3 - "$started" "$evidence" <<'PY'
import json
import os
from pathlib import Path
import sys
import time
elapsed = round((time.monotonic_ns() - int(sys.argv[1])) / 1_000_000_000, 3)
result = {'scope': 'same-runner isolated logical restore', 'elapsedSeconds': elapsed,
          'checks': ['stock rows including LOT/EXP and quantity', 'Drizzle migration hashes',
                     'InvenTree media marker', 'API readiness', 'edge health', 'unauthenticated API 401'],
          'offsiteTested': False, 'hostRecoveryTested': False}
(Path(sys.argv[2]) / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
message = (f'Isolated logical restore passed in {elapsed:.3f} seconds: stock rows, '
           'migration hashes, media and application checks. '
           'This same-runner rehearsal does not measure offsite recovery or host RPO/RTO.')
print(message)
if os.environ.get('GITHUB_STEP_SUMMARY'):
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(message + '\n')
PY
