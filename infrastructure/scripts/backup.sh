#!/usr/bin/env bash
# All stock writers must belong to this instance. Never retry an inventory mutation.
set -euo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
compose="$root/infrastructure/scripts/medam-compose.sh"
mode=${1:---offsite}
[[ $# -le 1 && ( $mode == --offsite || $mode == --local-only ) ]] || { printf 'Użycie: %s [--offsite|--local-only]\n' "$0" >&2; exit 2; }
for cmd in docker flock tar sha256sum python3 timeout; do command -v "$cmd" >/dev/null || { printf 'Brak: %s\n' "$cmd" >&2; exit 1; }; done
config_value() { sed -n "s/^$1=//p" "$root/.env" | tail -1; }
backup_root=${BACKUP_ROOT:-$(config_value BACKUP_ROOT)}
backup_root=${backup_root:-./backups}
[[ $backup_root == /* ]] || backup_root="$root/$backup_root"
secret_dir=$(config_value SECRETS_DIR)
secret_dir=${secret_dir:-./secrets}
[[ $secret_dir == /* ]] || secret_dir="$root/$secret_dir"
[[ -d $secret_dir && ! -L $secret_dir && ! -L $backup_root ]] || { printf 'Nieprawidłowy katalog sekretów/kopii.\n' >&2; exit 1; }
mkdir -p "$backup_root"
chmod 0700 "$backup_root"
exec 9>"$backup_root/.backup.lock"
flock -n 9 || { printf 'Inny backup już trwa.\n' >&2; exit 1; }
checkpoint=$(date -u +%Y%m%dT%H%M%SZ)
staging="$backup_root/$checkpoint.partial"
complete="$backup_root/$checkpoint"
[[ ! -e $staging && ! -e $complete ]] || { printf 'Identyfikator backupu już istnieje.\n' >&2; exit 1; }
mkdir "$staging"
running_text=$("$compose" ps --status running --services)
mapfile -t running < <(printf '%s\n' "$running_text" | awk '/^(edge|api|inventree-server|inventree-worker|admin-proxy)$/')
project=$(config_value COMPOSE_PROJECT_NAME)
project=${project:-medam}
# One-off writers are not safe to stop implicitly. Refuse rather than racing them.
oneoffs=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.oneoff=True)
[[ -z $oneoffs ]] || { printf 'Trwa kontener jednorazowy. Zakończ narzędzia/maintenance przed backupem.\n' >&2; exit 1; }
for service in app-db inventree-db inventree-cache inventree-server edge; do
  printf '%s\n' "$running_text" | awk -v required="$service" '$0==required{found=1} END{exit !found}' || {
    printf 'Wymagana uruchomiona usługa do pełnego checkpointu: %s\n' "$service" >&2; exit 1;
  }
done
resume_needed=0
resume_services() {
  # Resume only existing writers. Compose start follows dependencies and can rerun
  # initialization/migrations or reject absent one-off migration containers.
  timeout 300 "$compose" up -d --no-deps --no-recreate --no-build --wait --wait-timeout 240 "${running[@]}" >/dev/null
}
cleanup() {
  code=$?
  trap - EXIT
  if ((resume_needed)) && ((${#running[@]})); then
    if ! resume_services; then
      printf 'ALARM: nie udało się wznowić usług po checkpointcie.\n' >&2
      "$root/infrastructure/scripts/alert.sh" 'MEDAM: błąd wznowienia usług po backupie.' || true
      code=1
    fi
  fi
  rm -f -- "$backup_root/.maintenance"
  if ((code)); then
    printf 'Backup bez potwierdzenia offsite. Zachowano checkpoint/materiał diagnostyczny w %s.\n' "$backup_root" >&2
    "$root/infrastructure/scripts/alert.sh" 'MEDAM: backup niekompletny; wymagana kontrola.' || true
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
date -u +%Y-%m-%dT%H:%M:%SZ > "$backup_root/.maintenance"
resume_needed=1
is_running() { printf '%s\n' "$running_text" | awk -v wanted="$1" '$0==wanted{found=1} END{exit !found}'; }
stop_writer() {
  local service=$1 container status
  is_running "$service" || return 0
  timeout 240 "$compose" stop -t 180 "$service" >/dev/null
  container=$("$compose" ps -aq "$service")
  status=$(docker inspect --format '{{.State.ExitCode}}' "$container")
  [[ $status == 0 ]] || { printf 'Brak dowodu łagodnego zatrzymania %s (exit %s); checkpoint przerwany.\n' "$service" "$status" >&2; exit 1; }
}
# Close ingress, drain Fastify, then stop upstream and worker.
stop_writer edge
stop_writer admin-proxy
stop_writer api
stop_writer inventree-server
stop_writer inventree-worker
timeout 180 "$compose" run --rm --no-deps -T inventree-server python -c 'import os,sys;sys.path.insert(0,"/home/inventree/src/backend/InvenTree");os.environ.setdefault("DJANGO_SETTINGS_MODULE","InvenTree.settings");import django;django.setup();from django_q.brokers import get_broker;b=get_broker();pending=b.queue_size();locked=b.lock_size();print("Pending/locked worker jobs:",pending,locked);sys.exit(0 if pending == 0 and locked == 0 else 1)' >/dev/null
# PREPARED/DISPATCHING/UNCERTAIN gates are preserved, never cleared.
frozen_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
timeout 900 "$compose" exec -T app-db pg_dump -U postgres -d medam_app --format=custom > "$staging/app.dump"
timeout 900 "$compose" exec -T inventree-db pg_dump -U postgres -d inventree --format=custom > "$staging/inventree.dump"
"$compose" exec -T app-db pg_restore --list < "$staging/app.dump" >/dev/null
"$compose" exec -T inventree-db pg_restore --list < "$staging/inventree.dump" >/dev/null
pg_image=$("$compose" images -q app-db | head -1)
copy_volume() {
  local service=$1 source=$2 output=$3 container
  container=$("$compose" ps -aq "$service")
  [[ -n $container ]] || exit 1
  timeout 900 docker run --rm --network none --volumes-from "$container:ro" --entrypoint tar "$pg_image" \
    --exclude=./backup -czf - -C "$source" . > "$staging/$output"
}
copy_volume inventree-server /home/inventree/data inventree-data.tar.gz
copy_volume edge /data caddy-data.tar.gz
copy_volume edge /config caddy-config.tar.gz
tar -czf "$staging/config.tar.gz" -C "$root" .env compose.yaml compose.production.yaml compose.restore.yaml infrastructure
tar --exclude=node_modules --exclude=dist --exclude='*.tsbuildinfo' --exclude=__pycache__ --exclude='*.pyc' \
  -czf "$staging/source.tar.gz" -C "$root" apps packages infrastructure docs \
  package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json compose.yaml compose.production.yaml compose.restore.yaml .dockerignore
tar -czf "$staging/secrets.tar.gz" -C "$secret_dir" .
python3 - "$compose" "$staging/image-lock.json" <<'PY'
import json,subprocess,sys
compose,output=sys.argv[1:]
images={}
for service in ('api','edge','app-db','inventree-db','inventree-server','inventree-cache'):
    container=subprocess.check_output([compose,'ps','-aq',service],text=True).strip()
    identity=subprocess.check_output(['docker','inspect','--format','{{.Image}}',container],text=True).strip()
    image=json.loads(subprocess.check_output(['docker','image','inspect','--format','{{json .}}',identity],text=True))
    images[service]={'id':image['Id'],'repoDigests':image.get('RepoDigests',[]),
        'architecture':image['Architecture'],'os':image['Os']}
with open(output,'w') as f: json.dump(images,f,indent=2);f.write('\n')
PY
"$compose" exec -T app-db psql -U postgres -d medam_app -At -v ON_ERROR_STOP=1 -c "SELECT json_build_object('gate',(SELECT row_to_json(g) FROM inventory_mutation_gate g WHERE id='inventory'),'unresolved',(SELECT coalesce(json_agg(x),'[]'::json) FROM (SELECT id,kind,state FROM idempotency_records WHERE state IN ('PREPARED','DISPATCHING','UNCERTAIN','DISCREPANCY') ORDER BY id) x))" > "$staging/operation-state.json"
commit=$(git -C "$root" rev-parse HEAD 2>/dev/null || printf unknown)
python3 - "$staging" "$frozen_at" "$commit" <<'PY'
import json,sys
from pathlib import Path
folder=Path(sys.argv[1])
parts=['app.dump','inventree.dump','inventree-data.tar.gz','caddy-data.tar.gz','caddy-config.tar.gz','config.tar.gz','source.tar.gz','secrets.tar.gz','image-lock.json','operation-state.json']
(folder/'manifest.json').write_text(json.dumps({'format':2,'frozenAtUtc':sys.argv[2],'commit':sys.argv[3],
    'sourceArchiveAuthoritative':True,'inventreeVersion':'1.7.0','inventreeApiVersion':570,'postgresMajor':17,'parts':parts},indent=2)+'\n')
PY
(cd "$staging" && sha256sum app.dump inventree.dump inventree-data.tar.gz caddy-data.tar.gz caddy-config.tar.gz config.tar.gz source.tar.gz secrets.tar.gz image-lock.json operation-state.json manifest.json > SHA256SUMS)
# An offsite-success marker remains separate from the complete local checkpoint.
mv "$staging" "$complete"
python3 "$root/infrastructure/scripts/checkpoint.py" validate "$complete"
resume_services
resume_needed=0
rm -f -- "$backup_root/.maintenance"
printf 'Kompletny lokalny checkpoint: %s\n' "$complete"
if [[ $mode == --local-only ]]; then
  printf 'Nie wykonano offsite; nie aktualizuję metryki offsite/RPO.\n'
  exit 0
fi
command -v restic >/dev/null || { printf 'Brak restic; offsite nie wykonano.\n' >&2; exit 1; }
if [[ -n ${RESTIC_ENV_FILE:-} ]]; then
  python3 - "$RESTIC_ENV_FILE" <<'PY'
import os,stat,sys
s=os.lstat(sys.argv[1])
if not stat.S_ISREG(s.st_mode) or s.st_mode & 0o077 or s.st_uid not in (0,os.getuid()):
    raise SystemExit('RESTIC_ENV_FILE must be an operator-owned private regular file.')
PY
  set -a
  # Trusted, local operator-owned shell configuration; never downloaded.
  source "$RESTIC_ENV_FILE"
  set +a
fi
: "${RESTIC_REPOSITORY:?Ustaw repozytorium restic poza VPS}"
: "${RESTIC_PASSWORD_FILE:?Ustaw plik hasła restic}"
case "$RESTIC_REPOSITORY" in
  s3:*|sftp:*|rest:https://*|b2:*|azure:*|gs:*|swift:*|rclone:*) ;;
  *) printf 'Offsite wymaga zdalnego backendu restic (nie lokalnej ścieżki).\n' >&2; exit 1 ;;
esac
python3 - "$RESTIC_PASSWORD_FILE" <<'PY'
import os,stat,sys
s=os.lstat(sys.argv[1])
if not stat.S_ISREG(s.st_mode) or s.st_mode & 0o077 or s.st_uid not in (0,os.getuid()):
    raise SystemExit('Restic password must be an operator-owned private regular file.')
PY
timeout 1800 restic backup --tag medam --tag "$checkpoint" "$complete"
restic snapshots --tag medam --tag "$checkpoint" --json > "$backup_root/.last-offsite-snapshot.json.tmp"
python3 - "$backup_root/.last-offsite-snapshot.json.tmp" "$checkpoint" <<'PY'
import json,sys
snapshots=json.load(open(sys.argv[1]))
if not any('medam' in s.get('tags',[]) and sys.argv[2] in s.get('tags',[]) for s in snapshots):
    raise SystemExit('No matching completed offsite snapshot found.')
PY
mv "$backup_root/.last-offsite-snapshot.json.tmp" "$backup_root/.last-offsite-snapshot.json"
printf '%s\n' "$frozen_at" > "$backup_root/.last-complete-offsite-checkpoint.tmp"
mv "$backup_root/.last-complete-offsite-checkpoint.tmp" "$backup_root/last-complete-offsite-checkpoint"
printf 'Offsite zapisany. Wiek danych liczony od: %s\n' "$frozen_at"
