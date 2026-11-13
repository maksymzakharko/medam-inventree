#!/usr/bin/env bash
# Rehearse restore into fresh, isolated resources. Never replace existing data.
set -euo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
usage() {
  printf 'Użycie: %s CHECKPOINT --target /nowy/katalog --project medam-restore-NAZWA [--app-port 18080] [--admin-port 18090] [--subnet 172.30.11.0/28] [--build-app-images]\n' "$0" >&2
  exit 2
}
(($#)) || usage
checkpoint=$1; shift
target= project= app_port=18080 admin_port=18090 subnet=172.30.11.0/28 build=0
while (($#)); do
  case "$1" in
    --target) target=${2:?}; shift 2 ;;
    --project) project=${2:?}; shift 2 ;;
    --app-port) app_port=${2:?}; shift 2 ;;
    --admin-port) admin_port=${2:?}; shift 2 ;;
    --subnet) subnet=${2:?}; shift 2 ;;
    --build-app-images) build=1; shift ;;
    *) usage ;;
  esac
done
[[ $target == /* && ! -e $target && ! -L $target ]] || { printf 'Cel musi być nowym, nieistniejącym katalogiem absolutnym.\n' >&2; exit 1; }
[[ $project =~ ^medam-restore-[a-z0-9][a-z0-9-]{1,40}$ ]] || usage
[[ $app_port =~ ^[0-9]+$ && $admin_port =~ ^[0-9]+$ ]] || usage
((app_port >= 1024 && app_port <= 65535 && admin_port >= 1024 && admin_port <= 65535 && app_port != admin_port)) || usage
python3 - "$subnet" <<'PY'
import ipaddress,sys
n=ipaddress.ip_network(sys.argv[1], strict=True)
if n.version != 4 or not n.is_private or n.prefixlen != 28:
    raise SystemExit('Restore requires a private IPv4 /28 ingress subnet.')
PY
python3 "$root/infrastructure/scripts/checkpoint.py" validate "$checkpoint"
for command in docker flock; do command -v "$command" >/dev/null || exit 1; done
exec 9>"$(dirname -- "$target")/.medam-restore.lock"
flock -n 9 || { printf 'Inne odtworzenie już trwa w tym katalogu.\n' >&2; exit 1; }
# Check all labelled resources, including stopped containers and orphaned volumes.
for resource in container volume network; do
  options=(-q)
  [[ $resource != container ]] || options+=(-a)
  existing=$(docker "$resource" ls "${options[@]}" --filter "label=com.docker.compose.project=$project")
  [[ -z $existing ]] || { printf 'Projekt %s ma istniejące zasoby: odmawiam nadpisania.\n' "$project" >&2; exit 1; }
done
python3 "$root/infrastructure/scripts/checkpoint.py" extract "$checkpoint" "$target"
checkpoint=$(cd -- "$checkpoint" && pwd)
trap 'printf "Odtworzenie przerwane. Zachowano cel i jego nowe zasoby do kontroli: %s\n" "$target" >&2' ERR
python3 - "$checkpoint" "$target" "$project" "$app_port" "$admin_port" "$subnet" "$build" <<'PY'
import json,os,sys
from pathlib import Path
checkpoint,target,project,app_port,admin_port,subnet,build=sys.argv[1:]
target=Path(target)
images=json.loads((Path(checkpoint)/'image-lock.json').read_text())
api=f'{project}-api:checkpoint' if build=='1' else images['api']['id']
edge=f'{project}-edge:checkpoint' if build=='1' else images['edge']['id']
config={'COMPOSE_PROJECT_NAME':project,'MEDAM_MODE':'restore','APP_ORIGIN':f'http://localhost:{app_port}',
    'APP_DOMAIN':'restore.invalid','APP_HTTP_PORT':app_port,'ADMIN_HTTP_PORT':admin_port,
    'INVENTREE_SITE_URL':f'http://localhost:{admin_port}','MEDAM_INGRESS_SUBNET':subnet,
    'SECRETS_DIR':'./secrets','BACKUP_ROOT':'./backups','API_IMAGE':api,'EDGE_IMAGE':edge}
(target/'.env').write_text(''.join(f'{k}={v}\n' for k,v in config.items()))
# Recreated roles use the original private passwords, with only isolated DNS names.
for key,role in [('app_database_url','medam_runtime'),('app_migration_database_url','medam_migrator')]:
    password=(target/'secrets'/('app_runtime_password' if role=='medam_runtime' else 'app_migrator_password')).read_text().strip()
    from urllib.parse import quote
    (target/'secrets'/key).write_text(f'postgresql://{role}:{quote(password,safe="")}@app-db:5432/medam_app\n')
# Test sessions cannot use production cookies; keep the InvenTree pepper for its token validation.
(target/'secrets'/'session_secret').write_text(os.urandom(32).hex()+'\n')
PY
compose=(docker compose --project-directory "$target" --env-file "$target/.env" -f "$target/compose.yaml" -f "$target/compose.restore.yaml")
"${compose[@]}" config --quiet
if ((build)); then
  "${compose[@]}" build api edge
else
  for service in api edge; do
    identity=$(python3 - "$checkpoint/image-lock.json" "$service" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))[sys.argv[2]]['id'])
PY
)
    docker image inspect "$identity" --format '{{.Id}}' >/dev/null || {
      printf 'Brak obrazu aplikacji. Załaduj go z zaufanego wydania lub użyj --build-app-images.\n' >&2; exit 1;
    }
  done
fi
"${compose[@]}" up -d --no-deps --wait --wait-timeout 180 app-db inventree-db inventree-cache
check_image() {
  local service=$1 container actual expected
  container=$("${compose[@]}" ps -aq "$service")
  actual=$(docker inspect --format '{{.Image}}' "$container")
  expected=$(python3 - "$checkpoint/image-lock.json" "$service" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))[sys.argv[2]]['id'])
PY
)
  [[ $actual == "$expected" ]] || { printf 'Obraz/architektura %s nie odpowiada checkpointowi; zatrzymano restore.\n' "$service" >&2; exit 1; }
}
check_image app-db
check_image inventree-db
check_image inventree-cache
# Empty databases only. No --clean, --create, migrations, or mutation replay.
"${compose[@]}" exec -T app-db pg_restore -U postgres -d medam_app --exit-on-error --no-owner --role=medam_migrator < "$checkpoint/app.dump"
"${compose[@]}" exec -T inventree-db pg_restore -U postgres -d inventree --exit-on-error --no-owner --role=inventree < "$checkpoint/inventree.dump"
"${compose[@]}" run --rm --no-deps -T app-grants
"${compose[@]}" exec -T app-db psql -U postgres -d medam_app -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
UPDATE sessions SET revoked_at=coalesce(revoked_at,now());
UPDATE password_reset_tokens SET consumed_at=coalesce(consumed_at,now());
INSERT INTO application_audit_events(action,outcome,details)
VALUES('system.isolated_restore','completed','{"sessionsRevoked":true,"resetLinksRevoked":true,"inventoryGatePreserved":true}');
COMMIT;
SQL
# Create containers without starting processes; a one-off helper mounts only their new volumes.
"${compose[@]}" up --no-start --no-deps --no-build inventree-server edge
check_image inventree-server
restore_volume() {
  local service=$1 destination=$2 archive=$3 container image
  container=$("${compose[@]}" ps -aq "$service")
  image=$("${compose[@]}" images -q app-db | head -1)
  docker run --rm -i --network none --volumes-from "$container" --entrypoint tar "$image" \
    -xzf - -C "$destination" < "$checkpoint/$archive"
}
restore_volume inventree-server /home/inventree/data inventree-data.tar.gz
# Certificate/config archives are retained as evidence, never served on the test host.
"${compose[@]}" up -d --no-deps --wait --wait-timeout 240 inventree-server
"${compose[@]}" up -d --no-deps --wait --wait-timeout 180 api
"${compose[@]}" up -d --no-deps --wait --wait-timeout 90 edge
"${compose[@]}" exec -T api node --input-type=module -e 'const r=await fetch("http://127.0.0.1:3000/health/ready");process.exit(r.ok?0:1)'
printf 'Odtworzono izolowaną kopię: http://localhost:%s\n' "$app_port"
printf 'Worker i panel administracyjny nie zostały uruchomione. Brama operacji zachowana.\n'
printf 'Zapisz wynik kontroli danych, pomiar RPO/RTO i testów użytkowników; sam start nie potwierdza pełnego odtworzenia.\n'
