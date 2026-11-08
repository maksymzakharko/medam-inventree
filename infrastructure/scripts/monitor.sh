#!/usr/bin/env bash
# Read-only host/application checks. Delivery is disabled unless operator configures alert.sh.
set -euo pipefail
umask 077
if [[ ${1:-} == --help && $# -eq 1 ]]; then
  printf 'Użycie: %s\nZmienne: MONITOR_STATE_DIR, BACKUP_ROOT, MONITOR_HTTPS_ORIGIN, ALERT_WEBHOOK_FILE.\n' "$0"
  exit 0
fi
[[ $# -eq 0 ]] || { printf 'Użycie: %s [--help]\n' "$0" >&2; exit 2; }
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
compose="$root/infrastructure/scripts/medam-compose.sh"
for cmd in docker timeout python3 flock df; do command -v "$cmd" >/dev/null || { printf 'Brak: %s\n' "$cmd" >&2; exit 1; }; done
[[ -r $root/.env ]] || { printf 'Brak .env.\n' >&2; exit 1; }
config_value() { sed -n "s/^$1=//p" "$root/.env" | tail -1; }
backup_root=${BACKUP_ROOT:-$(config_value BACKUP_ROOT)}
backup_root=${backup_root:-./backups}
[[ $backup_root == /* ]] || backup_root="$root/$backup_root"
state_dir=${MONITOR_STATE_DIR:-/var/lib/medam-monitor}
mkdir -p "$state_dir"
chmod 0700 "$state_dir"
exec 9>"$state_dir/.lock"
flock -n 9 || exit 0
temporary=$(mktemp -d "$state_dir/.check.XXXXXXXX")
trap 'rm -f -- "$temporary/issues.tsv" "$temporary/containers.tsv" "$temporary/metrics.json" "$temporary/notifications" "$temporary/certificate.pem"; rmdir -- "$temporary"' EXIT
: > "$temporary/issues.tsv"
: > "$temporary/containers.tsv"
issue() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$temporary/issues.tsv"; }

for path in "$root" "$backup_root"; do
  if [[ ! -d $path ]]; then issue backup-directory critical 'Brak katalogu checkpointów.'; continue; fi
  usage=$(df -P "$path" | awk 'END {gsub(/%/, "", $5); print $5}')
  inodes=$(df -Pi "$path" | awk 'END {gsub(/%/, "", $5); print $5}')
  if ((usage >= 90)); then issue disk critical 'Dysk zajęty w co najmniej 90%.'
  elif ((usage >= 80)); then issue disk warning 'Dysk zajęty w co najmniej 80%.'; fi
  if ((inodes >= 90)); then issue inodes critical 'Wykorzystanie inode co najmniej 90%.'
  elif ((inodes >= 80)); then issue inodes warning 'Wykorzystanie inode co najmniej 80%.'; fi
done
python3 - "$temporary/issues.tsv" "$temporary/metrics.json" <<'PY'
import json, os, pathlib, sys
memory = {}
for line in pathlib.Path('/proc/meminfo').read_text().splitlines():
    key, value = line.split(':', 1)
    memory[key] = int(value.strip().split()[0])
used = 100 * (1 - memory['MemAvailable'] / memory['MemTotal'])
load = os.getloadavg()[0] / (os.cpu_count() or 1)
with open(sys.argv[1], 'a') as f:
    if used >= 97: f.write('memory\tcritical\tZużycie RAM co najmniej 97%.\n')
    elif used >= 90: f.write('memory\twarning\tZużycie RAM co najmniej 90%.\n')
    if load >= 2: f.write('load\twarning\tŚrednie obciążenie 1 min przekracza dwukrotność liczby CPU.\n')
pathlib.Path(sys.argv[2]).write_text(json.dumps({'memoryUsedPercent':round(used,1),'loadPerCpu':round(load,2)}))
PY

checkpoint="$backup_root/last-complete-offsite-checkpoint"
maintenance=0
if [[ -f $backup_root/.maintenance ]]; then
  marker_age=$(( $(date +%s) - $(stat -c %Y "$backup_root/.maintenance") ))
  if ((marker_age >= 0 && marker_age <= 3600)); then maintenance=1
  else issue maintenance critical 'Marker maintenance jest starszy niż godzinę; sprawdź wznowienie usług.'; fi
fi
if [[ ! -s $checkpoint ]]; then
  issue offsite critical 'Brak potwierdzonego checkpointu offsite; cel RPO nie jest potwierdzony.'
else
  if age=$(python3 - "$checkpoint" <<'PY'
import datetime, pathlib, sys
try:
    t = datetime.datetime.fromisoformat(pathlib.Path(sys.argv[1]).read_text().strip().replace('Z','+00:00'))
    if t.tzinfo is None: raise ValueError()
    age = int((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds())
    if age < -60: raise ValueError()
    print(max(0, age))
except (ValueError, OSError):
    sys.exit(1)
PY
  ); then
    if ((age > 14400)); then issue offsite critical 'Dane ostatniego kompletnego checkpointu offsite są starsze niż 4 godziny.'
    elif ((age > 12600)); then issue offsite warning 'Dane ostatniego kompletnego checkpointu offsite są starsze niż 3,5 godziny.'; fi
  else issue offsite critical 'Nieprawidłowy czas checkpointu offsite.'; fi
fi

if containers=$(timeout 20 "$compose" ps --all -q 2>/dev/null); then
  if [[ -z $containers ]]; then issue containers critical 'Brak kontenerów instancji.'; fi
  while IFS= read -r container; do
    [[ -n $container ]] || continue
    if ! timeout 10 docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}{{"\t"}}{{.State.Status}}{{"\t"}}{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}{{"\t"}}{{.RestartCount}}' "$container" >> "$temporary/containers.tsv" 2>/dev/null; then
      issue containers critical 'Nie można odczytać stanu kontenera.'
    fi
  done <<< "$containers"
  for service in app-db inventree-db inventree-cache inventree-server inventree-worker api edge; do
    if ((maintenance)) && [[ $service =~ ^(inventree-server|inventree-worker|api|edge)$ ]]; then continue; fi
    row=$(awk -F '\t' -v service="$service" '$1==service {print; exit}' "$temporary/containers.tsv")
    if [[ -z $row ]]; then issue "service-$service" critical "Brak wymaganej usługi: $service."; continue; fi
    IFS=$'\t' read -r _ status health _ <<< "$row"
    if [[ $status != running || $health == unhealthy ]]; then
      issue "service-$service" critical "Usługa $service nie działa lub healthcheck zgłasza błąd."
    elif [[ $health == starting ]]; then issue "service-$service" warning "Usługa $service nadal rozpoczyna pracę."; fi
  done
  if ((!maintenance)) && ! timeout 25 "$compose" exec -T api node --input-type=module -e 'try {const r=await fetch("http://127.0.0.1:3000/health/ready",{signal:AbortSignal.timeout(18000)});process.exit(r.ok?0:1)} catch {process.exit(1)}' >/dev/null 2>&1; then
    issue readiness critical 'API readiness niedostępne przez co najmniej 2 minuty.'
  fi
  sql="SET default_transaction_read_only=on; SET statement_timeout='5s'; SELECT count(*) FROM idempotency_records WHERE state IN ('UNCERTAIN','DISCREPANCY') OR (state IN ('PREPARED','DISPATCHING') AND updated_at < now()-interval '2 minutes'); SELECT (CASE WHEN (SELECT count(*) FROM inventory_mutation_gate WHERE id='inventory') <> 1 THEN 1 ELSE 0 END) + count(*) FROM inventory_mutation_gate g LEFT JOIN idempotency_records o ON o.id=g.operation_id WHERE g.operation_id IS NOT NULL AND (o.id IS NULL OR o.updated_at < now()-interval '2 minutes'); SELECT count(*) FROM pg_stat_activity WHERE datname='medam_app';"
  if db_metrics=$(timeout 15 "$compose" exec -T app-db psql -X -U postgres -d medam_app -qAt -v ON_ERROR_STOP=1 -c "$sql" 2>/dev/null); then
    mapfile -t values <<< "$db_metrics"
    if [[ ${values[0]:-} =~ ^[0-9]+$ && ${values[1]:-} =~ ^[0-9]+$ && ${values[2]:-} =~ ^[0-9]+$ ]]; then
      if ((values[0] > 0 || values[1] > 0)); then issue unresolved critical 'Operacja zapasów lub trwała brama wymaga uzgodnienia; nie ponawiaj zapisów.'; fi
      if ((values[2] >= 45)); then issue connections warning 'Baza aplikacji ma co najmniej 45 połączeń (limit 60).'; fi
    else issue database critical 'Nieprawidłowy wynik odczytu metryk bazy aplikacji.'; fi
  else issue database critical 'Nie można odczytać metryk bazy aplikacji.'; fi
  # The official read-only check context skips ready-phase writes; PostgreSQL also enforces read-only transactions.
  if ((!maintenance)); then
    if it_metrics=$(timeout 25 "$compose" exec -T inventree-server python -c 'import datetime,json,os,sys;from pathlib import Path;os.environ["INVENTREE_DB_PASSWORD"]=Path("/run/secrets/inventree_db_password").read_text().strip();os.environ["PGOPTIONS"]="-c default_transaction_read_only=on";sys.argv=["manage.py","check"];sys.path.insert(0,"/home/inventree/src/backend/InvenTree");os.environ.setdefault("DJANGO_SETTINGS_MODULE","InvenTree.settings");import django;django.setup();from django_q.brokers import get_broker;from common.models import InvenTreeSetting;from users.models import ApiToken;b=get_broker();tokens=list(ApiToken.objects.filter(user__username="medam-service",user__is_active=True,name="MEDAM backend",revoked=False));days=min(((t.expiry-datetime.date.today()).days for t in tokens),default=-1);print(json.dumps({"pending":b.queue_size(),"locked":b.lock_size(),"audit":InvenTreeSetting.get_setting("AUDIT_LOG_ENABLED",False,create=False,cache=False),"autoDeleteAudit":InvenTreeSetting.get_setting("AUDIT_LOG_DELETE_OLD_ENTRIES",False,create=False,cache=False),"tokenCount":len(tokens),"tokenDays":days}))' 2>/dev/null); then
      if ! printf '%s' "$it_metrics" | python3 -c '
import json,sys
try:
    m=json.load(sys.stdin)
    for key in ("pending","locked","tokenCount","tokenDays"):
        if not isinstance(m[key],int): raise ValueError()
except (KeyError,ValueError,TypeError): sys.exit(1)
out=open(sys.argv[1],"a")
def issue(key,severity,text): out.write(key+"\t"+severity+"\t"+text+"\n")
if m["pending"]>=100: issue("queue","critical","Kolejka InvenTree zawiera co najmniej 100 zadań.")
elif m["pending"]>=10: issue("queue","warning","Kolejka InvenTree zawiera co najmniej 10 zadań.")
if m["locked"]>=10: issue("queue-locked","warning","InvenTree ma co najmniej 10 zablokowanych zadań.")
if m["audit"] is not True: issue("audit","critical","Audyt InvenTree jest wyłączony; wstrzymaj zapisy i wyjaśnij konfigurację.")
if m["autoDeleteAudit"] is not False: issue("audit-retention","critical","Automatyczne usuwanie audytu InvenTree jest włączone.")
if m["tokenCount"]!=1 or m["tokenDays"]<0: issue("token","critical","Brak jednej aktywnej, niewygasłej tożsamości tokenu integracji.")
elif m["tokenDays"]<=30: issue("token","warning","Token integracji InvenTree wygasa w ciągu 30 dni; przygotuj kontrolowaną rotację.")
' "$temporary/issues.tsv"; then issue inventree-check warning 'Nieprawidłowa odpowiedź kontroli kolejki, audytu lub tokenu InvenTree.'; fi
    else issue inventree-check warning 'Nie można odczytać kolejki, audytu lub daty tokenu InvenTree.'; fi
  fi
else
  issue docker critical 'Docker lub odczyt Compose jest niedostępny.'
fi

# Optional certificate check verifies the public hostname/chain, never uses insecure TLS.
if ((!maintenance)) && [[ -n ${MONITOR_HTTPS_ORIGIN:-} ]]; then
  if [[ ! $MONITOR_HTTPS_ORIGIN =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]]; then
    issue https critical 'Nieprawidłowy MONITOR_HTTPS_ORIGIN (wymagane https://host bez ścieżki).'
  elif ! timeout 20 curl --silent --show-error --fail --max-time 15 "$MONITOR_HTTPS_ORIGIN/health/edge" >/dev/null 2>&1; then
    issue https critical 'Publiczny HTTPS lub łańcuch certyfikatu jest niedostępny.'
  elif command -v openssl >/dev/null; then
    endpoint=${MONITOR_HTTPS_ORIGIN#https://}
    host=${endpoint%%:*}
    [[ $endpoint == *:* ]] || endpoint="$endpoint:443"
    if timeout 15 openssl s_client -connect "$endpoint" -servername "$host" -showcerts </dev/null 2>/dev/null | openssl x509 -outform PEM > "$temporary/certificate.pem" 2>/dev/null; then
      if ! openssl x509 -in "$temporary/certificate.pem" -noout -checkend 1209600 >/dev/null 2>&1; then
        issue certificate warning 'Certyfikat HTTPS wygasa w ciągu 14 dni; sprawdź odnowienie ACME.'
      fi
    else issue certificate warning 'Nie można odczytać terminu ważności certyfikatu HTTPS.'; fi
  else issue certificate warning 'Brak openssl do kontroli terminu odnowienia certyfikatu HTTPS.'
  fi
fi

# One alert per state change, reminder every hour, and a recovery notification.
# This state contains operational counters only; no session, token, stock or patient data.
python3 - "$temporary" "$state_dir/state.json" <<'PY'
import json, pathlib, sys, time
folder, path = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
try: old = json.loads(path.read_text())
except (OSError, ValueError): old = {}
now = int(time.time())
issues = {}
for row in (folder/'issues.tsv').read_text().splitlines():
    key, severity, message = row.split('\t', 2)
    if key not in issues or severity == 'critical': issues[key] = {'severity':severity,'message':message}
restarts = {}
for row in (folder/'containers.tsv').read_text().splitlines():
    service, _, _, count = row.split('\t')
    restarts[service] = int(count)
    if restarts[service] > old.get('restarts',{}).get(service, restarts[service]):
        issues['restarts-'+service] = {'severity':'warning','message':f'Wzrósł licznik restartów usługi {service}.'}
notify = []
previous = old.get('issues', {})
for key, issue in issues.items():
    before = previous.get(key, {})
    issue['firstSeen'] = before.get('firstSeen',now)
    issue['lastSent'] = before.get('lastSent',0)
    # Readiness alarm follows two full minutes of failures; mutation issues are immediate.
    if key == 'readiness' and now-issue['firstSeen'] < 120: continue
    if issue['severity'] != before.get('severity') or now-issue['lastSent'] >= 3600:
        notify.append('MEDAM '+issue['severity']+': '+issue['message'])
        issue['lastSent'] = now
for key, issue in previous.items():
    if key not in issues and issue.get('lastSent',0): notify.append('MEDAM OK: ustąpił alarm '+key+'.')
state = {'checkedAtUtc':now,'issues':issues,'restarts':restarts,'host':json.loads((folder/'metrics.json').read_text())}
temporary = path.with_suffix('.new')
temporary.write_text(json.dumps(state,ensure_ascii=False,indent=2)+'\n')
temporary.replace(path)
(folder/'notifications').write_text('\n'.join(notify)+ ('\n' if notify else ''))
print('Monitoring: '+str(len(issues))+' aktywnych alarmów; szczegóły w prywatnym state.json.')
PY
delivery_failed=0
while IFS= read -r message; do
  [[ -n $message ]] || continue
  "$root/infrastructure/scripts/alert.sh" "$message" || delivery_failed=1
done < "$temporary/notifications"
# A failed configured delivery must not suppress the next attempt for an hour.
if ((delivery_failed)); then
  python3 - "$state_dir/state.json" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]);state=json.loads(p.read_text())
for issue in state['issues'].values(): issue['lastSent']=0
temporary=p.with_suffix('.new');temporary.write_text(json.dumps(state,ensure_ascii=False)+'\n');temporary.replace(p)
PY
  exit 1
fi
