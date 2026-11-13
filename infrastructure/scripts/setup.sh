#!/usr/bin/env bash
set -euo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
mode=local
domain=
while (($#)); do
  case "$1" in
    --production) mode=production; shift ;;
    --domain) domain=${2:?Podaj domenę}; shift 2 ;;
    *) printf 'Użycie: %s [--production --domain magazyn.firma.pl]\n' "$0" >&2; exit 2 ;;
  esac
done
command -v openssl >/dev/null || { printf 'Wymagane openssl.\n' >&2; exit 1; }
if [[ $mode == production ]]; then
  [[ $domain =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ && $domain == *.* ]] || { printf 'Podaj prawidłową domenę bez schematu i ścieżki.\n' >&2; exit 2; }
fi
if [[ -e $root/.env ]]; then
  printf 'Istnieje .env: konfiguracja i sekrety pozostają bez zmian. Sprawdź ją ręcznie.\n'
  exit 0
fi
[[ ! -L $root/secrets ]] || { printf 'Katalog secrets nie może być dowiązaniem.\n' >&2; exit 1; }
mkdir -p "$root/secrets"
chmod 0700 "$root/secrets"
for name in app_pg_admin_password app_runtime_password app_migrator_password session_secret inventree_pg_admin_password inventree_db_password inventree_secret_key inventree_token; do
  [[ ! -L $root/secrets/$name ]] || { printf 'Plik sekretu nie może być dowiązaniem: %s\n' "$name" >&2; exit 1; }
  [[ -e $root/secrets/$name ]] || openssl rand -hex 32 > "$root/secrets/$name"
  chmod 0600 "$root/secrets/$name"
done
[[ ! -L $root/secrets/app_database_url && ! -L $root/secrets/app_migration_database_url ]] || { printf 'Adres bazy nie może być dowiązaniem.\n' >&2; exit 1; }
if [[ ! -e $root/secrets/app_database_url ]]; then
  printf 'postgresql://medam_runtime:%s@app-db:5432/medam_app\n' "$(cat "$root/secrets/app_runtime_password")" > "$root/secrets/app_database_url"
fi
if [[ ! -e $root/secrets/app_migration_database_url ]]; then
  printf 'postgresql://medam_migrator:%s@app-db:5432/medam_app\n' "$(cat "$root/secrets/app_migrator_password")" > "$root/secrets/app_migration_database_url"
fi
chmod 0600 "$root/secrets/"*
origin=http://localhost:8080
[[ $mode != production ]] || origin=https://$domain
cat > "$root/.env" <<EOF
COMPOSE_PROJECT_NAME=medam
MEDAM_MODE=$mode
APP_ORIGIN=$origin
APP_DOMAIN=${domain:-magazyn.example.invalid}
APP_HTTP_PORT=8080
ADMIN_HTTP_PORT=8090
INVENTREE_SITE_URL=http://localhost:8090
MEDAM_INGRESS_SUBNET=172.30.10.0/28
SECRETS_DIR=./secrets
BACKUP_ROOT=./backups
API_IMAGE=medam-api:local
EDGE_IMAGE=medam-edge:local
EOF
chmod 0600 "$root/.env"
printf 'Utworzono .env i losowe sekrety (bez wypisywania ich wartości).\n'
printf 'Tryb: %s. Następnie zbuduj obrazy i uruchom bootstrap zgodnie z docs/09-installation.md.\n' "$mode"
