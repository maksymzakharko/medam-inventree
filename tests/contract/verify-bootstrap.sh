#!/usr/bin/env bash
# Exercise the real CLI only in the fresh, disposable CI stack. Preserve all data.
set -euo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
[[ ${CI:-} == true && ${MEDAM_BOOTSTRAP_TEST:-} == ci-only-ephemeral ]] || {
  printf 'Bootstrap verification requires the explicitly selected disposable CI stack.\n' >&2
  exit 1
}
[[ -f $root/.env && ! -L $root/.env ]] || {
  printf 'A regular local CI configuration is required.\n' >&2
  exit 1
}
config_value() { sed -n "s/^$1=//p" "$root/.env" | tail -1; }
project=$(config_value COMPOSE_PROJECT_NAME)
[[ $project =~ ^medam(-[a-z0-9-]+)?$ && $(config_value MEDAM_MODE) == local &&
   $(config_value SECRETS_DIR) == ./secrets ]] || {
  printf 'Bootstrap verification requires a local medam CI project and its private secrets directory.\n' >&2
  exit 1
}
compose="$root/infrastructure/scripts/medam-compose.sh"
evidence=$(mktemp -d /tmp/medam-bootstrap-evidence.XXXXXXXX)
password_file="$root/secrets/ci-bootstrap-admin-password"
app_query() {
  "$compose" exec -T app-db psql -X -qAt -U postgres -d medam_app -v ON_ERROR_STOP=1 \
    -c "BEGIN READ ONLY; $1; COMMIT"
}
locations() {
  "$compose" exec -T inventree-db psql -X -qAt -U postgres -d inventree -v ON_ERROR_STOP=1 \
    -c "BEGIN READ ONLY; SELECT COALESCE(json_agg(row_to_json(l) ORDER BY l.id),'[]'::json) FROM
      (SELECT id,name,parent_id,structural,external FROM stock_stocklocation) l; COMMIT"
}
application_state() {
  app_query "SELECT json_build_object(
    'mappings',(SELECT COALESCE(json_agg(row_to_json(m) ORDER BY m.code),'[]'::json)
      FROM (SELECT code,location_id,name,enabled FROM warehouse_mappings) m),
    'creates',(SELECT COALESCE(json_agg(row_to_json(o) ORDER BY o.id),'[]'::json)
      FROM (SELECT id,state,request,upstream_refs FROM idempotency_records WHERE kind='warehouse_create') o),
    'gate',(SELECT operation_id FROM inventory_mutation_gate WHERE id='inventory'),
    'gates',(SELECT count(*) FROM inventory_mutation_gate WHERE id='inventory'),
    'mappingAudits',(SELECT count(*) FROM application_audit_events WHERE action='warehouse.mapping_verified' AND outcome='succeeded'))"
}

[[ $(app_query "SELECT count(*) FROM users") == 0 &&
   $(app_query "SELECT count(*) FROM warehouse_mappings") == 0 ]] || {
  printf 'Bootstrap verification requires a fresh application database.\n' >&2
  exit 1
}
locations > "$evidence/locations.before.json"
python3 - "$evidence/locations.before.json" "$password_file" <<'PY'
import json
import os
from pathlib import Path
import re
import secrets
import sys

assert not any(re.match(r'^MAG-(?:0[0-9]|1[01])(?:\s|$)', row['name'])
               for row in json.loads(Path(sys.argv[1]).read_text())), 'Existing bootstrap locations'
password = Path(sys.argv[2])
assert password.parent.is_dir() and not password.parent.is_symlink(), 'Invalid secret directory'
assert password.parent.stat().st_mode & 0o077 == 0, 'Secret directory must be private'
# Exclusive creation preserves an existing credential; no value enters a shell argument or log.
with os.fdopen(os.open(password, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w') as out:
    out.write(secrets.token_urlsafe(36) + '\n')
PY

# The normal entrypoint reads deployment secrets and drops to UID 1000. This tiny
# CI target receives only the generated password on stdin and creates the 0600
# password file as that same UID before executing the actual compiled CLI.
# The host original remains private and is preserved for inspection on the runner.
cat > "$evidence/bootstrap-admin.mjs" <<'JS'
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
assert.equal(process.env.CI, 'true');
assert.equal(process.env.MEDAM_BOOTSTRAP_TEST, 'ci-only-ephemeral');
assert.equal(process.getuid(), 1000);
const password = readFileSync(0, 'utf8');
assert(/^[A-Za-z0-9_-]{48}\n$/.test(password), 'Invalid generated password file');
const file = `${mkdtempSync('/tmp/medam-bootstrap-password.')}/password`;
writeFileSync(file, password, { flag: 'wx', mode: 0o600 });
process.argv = [process.argv[0], '/app/dist/cli/index.js', 'bootstrap-admin',
  '--login', 'ci-bootstrap-admin', '--password-file', file];
await import('./dist/cli/index.js');
JS
chmod 0644 "$evidence/bootstrap-admin.mjs"
"$compose" run --rm --no-deps -T \
  -e CI=true -e MEDAM_BOOTSTRAP_TEST=ci-only-ephemeral \
  -v "$evidence/bootstrap-admin.mjs:/app/bootstrap-admin.mjs:ro" \
  app-cli bootstrap-admin.mjs < "$password_file"
actor=$(app_query "SELECT id FROM users WHERE login='ci-bootstrap-admin' AND role='admin' AND active=true
  AND password_hash LIKE '\$argon2id\$%' AND (SELECT count(*) FROM users)=1
  AND (SELECT count(*) FROM application_audit_events WHERE action='users.bootstrap_admin' AND outcome='created')=1")
[[ $actor =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
  printf 'The real CLI did not create and audit exactly one active administrator.\n' >&2
  exit 1
}

cat > "$evidence/check-permissions.py" <<'PY'
import os
import sys

assert os.environ.get('CI') == 'true'
assert os.environ.get('MEDAM_BOOTSTRAP_TEST') == 'ci-only-ephemeral'
sys.path.insert(0, '/home/inventree/src/backend/InvenTree')
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'InvenTree.settings')
import django
django.setup()
from django.contrib.auth import get_user_model
from django.db import connection

with connection.cursor() as cursor:
    cursor.execute('SET default_transaction_read_only=on')
user = get_user_model().objects.get(username='medam-service')
assert user.is_active and not user.is_staff and not user.is_superuser
assert not user.has_usable_password() and not user.user_permissions.exists()
assert list(user.groups.values_list('name', flat=True)) == ['MEDAM integration managed']
for action in ('view', 'add', 'change'):
    assert user.has_perm(f'stock.{action}_stockitem'), f'Missing stock {action}'
assert user.has_perm('stock.view_stocklocation'), 'Missing location view'
assert user.has_perm('part.view_part'), 'Missing part view'
finalized = sys.argv[1] == 'finalized'
assert user.has_perm('stock.add_stocklocation') is (not finalized), 'Incorrect location creation permission'
if finalized:
    assert not user.has_perm('stock.change_stocklocation'), 'Location change permission survived finalization'
assert not any(p.split('.', 1)[1].startswith('delete_') for p in user.get_all_permissions()), 'DELETE grant'
print('Integration permissions verified: ' + ('finalized.' if finalized else 'temporary location creation enabled.'))
PY
chmod 0644 "$evidence/check-permissions.py"
permissions() {
  "$compose" run --rm --no-deps -T \
    -e CI=true -e MEDAM_BOOTSTRAP_TEST=ci-only-ephemeral \
    -v "$evidence/check-permissions.py:/medam/check-permissions.py:ro" \
    inventree-server python /medam/check-permissions.py "$1"
}
permissions bootstrap
"$compose" run --rm --no-deps -T app-cli dist/cli/index.js sync-warehouses --actor "$actor"
locations > "$evidence/locations.first.json"
application_state > "$evidence/application.first.json"
"$compose" run --rm --no-deps -T app-cli dist/cli/index.js sync-warehouses --actor "$actor"
locations > "$evidence/locations.second.json"
application_state > "$evidence/application.second.json"
python3 - "$evidence" <<'PY'
import json
from pathlib import Path
import sys

directory = Path(sys.argv[1])
read = lambda name: json.loads((directory / name).read_text())
before = read('locations.before.json')
first, second = (read(f'locations.{phase}.json') for phase in ('first', 'second'))
initial, repeated = (read(f'application.{phase}.json') for phase in ('first', 'second'))
assert len(first) == len(before) + 12, 'First synchronization must create exactly twelve locations'
assert first == second, 'Repeated synchronization changed InvenTree locations'
assert initial['mappings'] == repeated['mappings'], 'Repeated synchronization changed mappings'
assert initial['creates'] == repeated['creates'], 'Repeated synchronization created another durable operation'
labels = ['Magazyn główny', *(f'Ratownik {i:02}' for i in range(1, 11)), 'Gabinet stacjonarny']
assert len(initial['mappings']) == len(initial['creates']) == 12
for i, mapping in enumerate(initial['mappings']):
    code = f'MAG-{i:02}'
    assert mapping['code'] == code and mapping['name'] == labels[i] and mapping['enabled'] is True
    matching = [row for row in first if row['name'] == code]
    assert len(matching) == 1 and matching[0]['id'] == mapping['location_id'], 'Incorrect upstream mapping'
    assert matching[0]['parent_id'] is None and not matching[0]['structural'] and not matching[0]['external']
    operations = [op for op in initial['creates'] if op['request']['code'] == code]
    assert len(operations) == 1 and operations[0]['state'] == 'SUCCEEDED'
    assert operations[0]['upstream_refs'] == [{'locationId': mapping['location_id']}]
assert initial['mappingAudits'] == 12 and repeated['mappingAudits'] == 24
assert initial['gates'] == repeated['gates'] == 1 and initial['gate'] is repeated['gate'] is None
print('Real CLI bootstrap passed: one audited administrator, twelve upstream locations and stable mappings; second sync creates nothing.')
PY

# Finalization starts API/edge. The following CI step explicitly waits for their
# health before checking actual readiness and the public application.
"$root/infrastructure/scripts/finalize-bootstrap.sh"
permissions finalized
printf 'Bootstrap finalization passed; private CI password and evidence preserved.\n'
