import { readFile, lstat, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { z } from 'zod';
import { CreateUserSchema, UuidSchema } from '@medam/shared';
import { loadConfig } from '../config.js';
import { audit, createPool, withTransaction, type Pool } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../modules/auth/passwords.js';
import { issuePasswordReset, normalizeLogin } from '../modules/auth/service.js';
import { createUser } from '../modules/users/service.js';
import { resolveNotApplied, resolveObservedEffect } from '../modules/consumption/operations.js';
import { InventreeClient, type Location } from '../integrations/inventree/client.js';

const usage = `MEDAM — narzędzia administracyjne (bez danych pacjentów)

  migrate
  bootstrap-admin --login LOGIN [--password-file PLIK]
  create-user --actor UUID --login LOGIN --role medic|warehouse_manager|admin [--warehouse MAG-01|PK]
  reset-password --actor UUID --user UUID [--output NOWY_PLIK]
  sync-warehouses --actor UUID
  reconcile-warehouse --actor UUID --operation UUID --resolution applied|not_applied
    [--location PK] --confirm-upstream-stopped --reason POWÓD
  reconcile-not-applied --actor UUID --operation UUID --confirm-upstream-stopped --reason POWÓD
  reconcile-observed --actor UUID --operation UUID --actual-quantity ILOŚĆ
    --confirm-upstream-stopped --reason POWÓD

Hasła podawaj przez ukryty prompt terminala lub plik 0600, nigdy w argumencie.
Reset wydaje jednorazowy token (15 minut) przez terminal lub nowy plik 0600.
Migracje używają APP_MIGRATION_DATABASE_URL[_FILE], awaryjnie APP_DATABASE_URL[_FILE].
Pozostałe komendy używają APP_DATABASE_URL[_FILE]; synchronizacja wymaga konfiguracji InvenTree.
Potwierdzenie braku skutku jest dostępne tylko po zatrzymaniu API i wszystkich
autorów zapisów InvenTree, zakończeniu żądań w toku oraz zbadaniu audytu i stanu.
Flaga jest świadomym poświadczeniem operatora, nie automatycznym dowodem.
`;

async function readSetting(key: string): Promise<string | undefined> {
  const file = process.env[`${key}_FILE`];
  return file ? (await readFile(file, 'utf8')).trim() : process.env[key];
}

async function databaseUrl(migration = false): Promise<string> {
  const value = (migration ? await readSetting('APP_MIGRATION_DATABASE_URL') : undefined)
    ?? await readSetting('APP_DATABASE_URL');
  if (!value) throw new Error('Brak adresu bazy aplikacji. Ustaw APP_DATABASE_URL_FILE.');
  return value;
}

async function hiddenQuestion(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('Hasło wymaga terminala TTY lub --password-file.');
  process.stderr.write(question);
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const terminal = createInterface({ input: process.stdin, output: muted, terminal: true });
  try { return await terminal.question(''); }
  finally { terminal.close(); process.stderr.write('\n'); }
}

async function getPassword(file?: string): Promise<string> {
  if (file) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error('Plik hasła musi być zwykłym plikiem bez dostępu grupy/innych (0600).');
    }
    return (await readFile(file, 'utf8')).replace(/\r?\n$/, '');
  }
  const first = await hiddenQuestion('Nowe hasło (12–128 znaków): ');
  const second = await hiddenQuestion('Powtórz hasło: ');
  if (first !== second) throw new Error('Hasła nie są zgodne.');
  return first;
}

async function requireAdmin(db: Pool, actorId: string): Promise<void> {
  UuidSchema.parse(actorId);
  const result = await db.query('SELECT id FROM users WHERE id=$1 AND active=true AND role=$2', [actorId, 'admin']);
  if (!result.rowCount) throw new Error('Identyfikator operatora musi wskazywać aktywnego administratora.');
}

async function warehouseId(db: Pool, value: string | undefined): Promise<number | undefined> {
  if (!value) return undefined;
  const result = /^MAG-(?:0[0-9]|1[01])$/.test(value)
    ? await db.query<{location_id:number}>('SELECT location_id FROM warehouse_mappings WHERE code=$1 AND enabled=true', [value])
    : await db.query<{location_id:number}>('SELECT location_id FROM warehouse_mappings WHERE location_id=$1 AND enabled=true', [z.coerce.number().int().positive().parse(value)]);
  const id = result.rows[0]?.location_id;
  if (!id) throw new Error('Nie znaleziono aktywnego mapowania magazynu. Najpierw sync-warehouses.');
  return id;
}

const labels = ['Magazyn główny', ...Array.from({ length: 10 }, (_, i) => `Ratownik ${String(i + 1).padStart(2, '0')}`), 'Gabinet stacjonarny'];
const codeOf = (location: Location): string | undefined => location.name.match(/^(MAG-(?:0[0-9]|1[01]))(?:\s|$)/)?.[1];

/** A failed create is never retried: its durable operation retains the global gate. */
async function createWarehouse(db: Pool, inventory: InventreeClient, actorId: string, code: string): Promise<Location> {
  const operationId = randomUUID();
  await withTransaction(db, async client => {
    const gate = await client.query<{operation_id:string|null}>('SELECT operation_id FROM inventory_mutation_gate WHERE id=$1 FOR UPDATE', ['inventory']);
    if (!gate.rowCount || gate.rows[0]?.operation_id) throw new Error('Magazyn ma nierozstrzygniętą operację. Najpierw uzgodnij wynik; nie ponawiaj tworzenia.');
    await client.query(`INSERT INTO idempotency_records(id,actor_id,kind,key,request_hash,state,request)
      VALUES($1,$2,'warehouse_create',$1,encode(sha256($3::bytea),'hex'),'PREPARED',$4::jsonb)`,
    [operationId, actorId, Buffer.from(code), JSON.stringify({ code })]);
    await client.query('UPDATE inventory_mutation_gate SET operation_id=$1,updated_at=now() WHERE id=$2', [operationId, 'inventory']);
    await audit(client, { actorId, operationId, action: 'warehouse.create', outcome: 'prepared', resourceRefs: { code } });
    await client.query("UPDATE idempotency_records SET state='DISPATCHING',updated_at=now() WHERE id=$1 AND state='PREPARED'", [operationId]);
  });
  try {
    const location = await inventory.createLocation(code);
    if (location.name !== code || location.external || location.structural) throw new Error('Niezgodna odpowiedź utworzenia lokalizacji.');
    await withTransaction(db, async client => {
      const update = await client.query(`UPDATE idempotency_records SET state='SUCCEEDED',response=$2::jsonb,
        upstream_refs=$3::jsonb,updated_at=now() WHERE id=$1 AND state='DISPATCHING'`,
      [operationId, JSON.stringify({ id: operationId, state: 'SUCCEEDED', locationId: location.pk }), JSON.stringify([{ locationId: location.pk }])]);
      if (update.rowCount !== 1) throw new Error('Operacja wymaga uzgodnienia.');
      await audit(client, { actorId, operationId, action: 'warehouse.create', outcome: 'succeeded', resourceRefs: { code, locationId: location.pk } });
      await client.query('UPDATE inventory_mutation_gate SET operation_id=NULL,updated_at=now() WHERE id=$1 AND operation_id=$2', ['inventory', operationId]);
    });
    return location;
  } catch {
    await withTransaction(db, async client => {
      await client.query("UPDATE idempotency_records SET state='UNCERTAIN',updated_at=now() WHERE id=$1 AND state='DISPATCHING'", [operationId]);
      await audit(client, { actorId, operationId, action: 'warehouse.create', outcome: 'uncertain', resourceRefs: { code } });
    }).catch(() => undefined);
    throw new Error(`Wynik utworzenia ${code} wymaga sprawdzenia. Operacja ${operationId}. Nie ponawiaj POST; brama pozostaje zamknięta.`);
  }
}

async function syncWarehouses(db: Pool, actorId: string): Promise<void> {
  await requireAdmin(db, actorId);
  const config = loadConfig();
  const inventory = new InventreeClient({ baseUrl: config.inventreeUrl, token: config.inventreeToken,
    timeoutMs: config.inventreeTimeoutMs, expectedVersion: config.inventreeExpectedVersion,
    expectedApiVersion: config.inventreeExpectedApiVersion });
  await inventory.checkVersion();
  const lock = await db.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext('medam-warehouse-bootstrap'))");
    const locations = await inventory.listLocations();
    for (let index = 0; index < labels.length; index += 1) {
      const code = `MAG-${String(index).padStart(2, '0')}`;
      const matches = locations.filter(location => codeOf(location) === code);
      if (matches.length > 1) throw new Error(`Duplikaty kodu ${code} w InvenTree. Przerwano bez wybierania pierwszej lokalizacji.`);
      const mapping = await db.query<{location_id:number}>('SELECT location_id FROM warehouse_mappings WHERE code=$1', [code]);
      let location = matches[0];
      if (mapping.rows[0] && (!location || location.pk !== mapping.rows[0].location_id)) {
        throw new Error(`Mapowanie ${code} nie odpowiada lokalizacji InvenTree. Wymagane ręczne uzgodnienie.`);
      }
      if (!location) {
        location = await createWarehouse(db, inventory, actorId, code);
        locations.push(location);
      }
      if (location.external || location.structural) throw new Error(`${code} jest lokalizacją zewnętrzną lub strukturalną.`);
      await withTransaction(db, async client => {
        const result = await client.query(`INSERT INTO warehouse_mappings(location_id,code,name)
          VALUES($1,$2,$3) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name
          WHERE warehouse_mappings.location_id=EXCLUDED.location_id RETURNING location_id`, [location.pk, code, labels[index]]);
        if (result.rowCount !== 1) throw new Error(`Konflikt stabilnego identyfikatora ${code}.`);
        await audit(client, { actorId, action: 'warehouse.mapping_verified', outcome: 'succeeded', resourceRefs: { code, locationId: location.pk } });
      });
      process.stdout.write(`${code} → location ${location.pk}\n`);
    }
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('medam-warehouse-bootstrap'))").catch(() => undefined);
    lock.release();
  }
}

async function reconcileWarehouse(db: Pool, options: { actorId: string; operationId: string;
  resolution: 'applied' | 'not_applied'; locationId?: number; confirmed: boolean; reason: string }): Promise<void> {
  if (!options.confirmed) throw new Error('Najpierw wyklucz aktywne pierwotne żądanie i potwierdź --confirm-upstream-stopped.');
  await requireAdmin(db, options.actorId);
  z.string().trim().min(10).max(1000).parse(options.reason);
  const existing = await db.query<{request:unknown; state:string}>('SELECT request,state FROM idempotency_records WHERE id=$1 AND kind=$2', [options.operationId, 'warehouse_create']);
  const operation = existing.rows[0];
  if (!operation || !['UNCERTAIN', 'DISCREPANCY', 'DISPATCHING'].includes(operation.state)) throw new Error('Nie znaleziono nierozstrzygniętej operacji tworzenia magazynu.');
  const { code } = z.object({ code: z.string().regex(/^MAG-(?:0[0-9]|1[01])$/) }).parse(operation.request);
  const config = loadConfig();
  const inventory = new InventreeClient({ baseUrl: config.inventreeUrl, token: config.inventreeToken,
    timeoutMs: config.inventreeTimeoutMs, expectedVersion: config.inventreeExpectedVersion,
    expectedApiVersion: config.inventreeExpectedApiVersion });
  await inventory.checkVersion();
  const matches = (await inventory.listLocations()).filter(location => codeOf(location) === code);
  const location = matches[0];
  if (options.resolution === 'applied') {
    if (!options.locationId || matches.length !== 1 || location?.pk !== options.locationId || location.external || location.structural) {
      throw new Error('Potwierdzenie wymaga jednej zgodnej lokalizacji InvenTree z podanym PK i kodem.');
    }
  } else if (options.locationId !== undefined || matches.length !== 0) {
    throw new Error('Nie można stwierdzić braku wykonania: istnieje lokalizacja o tym kodzie lub podano PK.');
  }
  // Absence alone is insufficient: the operator must first exclude any delayed in-flight request.
  // This controlled CLI records that maintenance attestation; it never resends a create.
  await withTransaction(db, async client => {
    const gate = await client.query<{operation_id:string|null}>('SELECT operation_id FROM inventory_mutation_gate WHERE id=$1 FOR UPDATE', ['inventory']);
    if (gate.rows[0]?.operation_id !== options.operationId) throw new Error('Brama nie należy do wskazanej operacji.');
    const state = options.resolution === 'applied' ? 'RECONCILED_APPLIED' : 'RECONCILED_NOT_APPLIED';
    const updated = await client.query(`UPDATE idempotency_records SET state=$2,response=$3::jsonb,
      upstream_refs=$4::jsonb,updated_at=now() WHERE id=$1 AND kind='warehouse_create'
      AND state IN ('DISPATCHING','UNCERTAIN','DISCREPANCY')`, [options.operationId, state,
      JSON.stringify({ id: options.operationId, state, ...(location ? { locationId: location.pk } : {}) }),
      JSON.stringify(location ? [{ locationId: location.pk }] : [])]);
    if (updated.rowCount !== 1) throw new Error('Stan operacji uległ zmianie.');
    if (location && options.resolution === 'applied') {
      const label = labels[Number(code.slice(4))];
      const mapped = await client.query(`INSERT INTO warehouse_mappings(location_id,code,name)
        VALUES($1,$2,$3) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name
        WHERE warehouse_mappings.location_id=EXCLUDED.location_id RETURNING location_id`, [location.pk, code, label]);
      if (mapped.rowCount !== 1) throw new Error('Konflikt stabilnego mapowania lokalizacji.');
    }
    await audit(client, { actorId: options.actorId, operationId: options.operationId,
      action: 'warehouse.reconciled', outcome: state,
      resourceRefs: { code, locationId: location?.pk ?? null },
      details: { reason: options.reason, upstreamRequestStopped: true, operatorAttestation: true } });
    await client.query('UPDATE inventory_mutation_gate SET operation_id=NULL,updated_at=now() WHERE id=$1 AND operation_id=$2', ['inventory', options.operationId]);
  });
  process.stdout.write('Operacja lokalizacji uzgodniona; nie wykonano ponownego POST.\n');
}

async function run(): Promise<void> {
  const { values, positionals } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, login: { type: 'string' }, role: { type: 'string' },
    actor: { type: 'string' }, user: { type: 'string' }, warehouse: { type: 'string' },
    'password-file': { type: 'string' }, output: { type: 'string' },
    operation: { type: 'string' }, location: { type: 'string' }, resolution: { type: 'string' },
    'actual-quantity': { type: 'string' },
    'confirm-upstream-stopped': { type: 'boolean' }, reason: { type: 'string' },
  }, allowPositionals: true, strict: true });
  const command = positionals[0];
  if (values.help || !command) { process.stdout.write(usage); return; }
  if (positionals.length !== 1 || !['migrate', 'bootstrap-admin', 'create-user', 'reset-password', 'sync-warehouses', 'reconcile-warehouse', 'reconcile-not-applied', 'reconcile-observed'].includes(command)) {
    throw new Error('Nieznana komenda. Użyj --help.');
  }
  const db = createPool(await databaseUrl(command === 'migrate'));
  try {
    if (command === 'migrate') { await migrate(db); process.stdout.write('Migracje zakończone.\n'); return; }
    if (command === 'bootstrap-admin') {
      const login = z.string().min(3).max(254).parse(normalizeLogin(values.login ?? ''));
      const passwordHash = await hashPassword(await getPassword(values['password-file']));
      const administratorId = await withTransaction(db, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('medam-bootstrap-admin'))");
        const admins = await client.query("SELECT id FROM users WHERE role='admin'");
        if (admins.rowCount) throw new Error('Administrator już istnieje. Użyj procedury zarządzania użytkownikami.');
        const id = randomUUID();
        await client.query("INSERT INTO users(id,login,password_hash,role) VALUES($1,$2,$3,'admin')", [id, login, passwordHash]);
        await audit(client, { actorId: id, action: 'users.bootstrap_admin', outcome: 'created', resourceRefs: { userId: id } });
        return id;
      });
      process.stdout.write(`Administrator utworzony: ${administratorId}\n`);
      return;
    }
    const actorId = UuidSchema.parse(values.actor);
    await requireAdmin(db, actorId);
    if (command === 'create-user') {
      const warehouse = await warehouseId(db, values.warehouse);
      const input = CreateUserSchema.parse({ login: values.login, role: values.role, ...(warehouse === undefined ? {} : { warehouseId: warehouse }) });
      const user = await createUser(db, actorId, input);
      process.stdout.write(`Konto utworzone: ${user.id}. Wydaj token przez reset-password.\n`);
      return;
    }
    if (command === 'reset-password') {
      const userId = UuidSchema.parse(values.user);
      if (!values.output && !process.stdout.isTTY) throw new Error('Wydanie tokenu wymaga terminala TTY albo --output z nazwą nowego pliku 0600.');
      // Keep the newly created file descriptor: no second path lookup or symlink race.
      const output = values.output ? await open(values.output, 'wx', 0o600) : undefined;
      try {
        const token = await issuePasswordReset(db, userId, actorId);
        const appOrigin = (process.env.APP_ORIGIN ?? '').replace(/\/$/, '');
        const text = appOrigin ? `${appOrigin}/reset-password#token=${encodeURIComponent(token)}\n` : `${token}\n`;
        if (output) { await output.writeFile(text, 'utf8'); process.stdout.write('Token resetu zapisany w prywatnym pliku; ważność 15 minut.\n'); }
        else { process.stdout.write(`Jednorazowy reset (15 minut):\n${text}`); }
      } finally { await output?.close(); }
      return;
    }
    if (command === 'sync-warehouses') await syncWarehouses(db, actorId);
    if (command === 'reconcile-not-applied') {
      if (values['confirm-upstream-stopped'] !== true) throw new Error('Najpierw zatrzymaj API i wszystkich autorów zapisów InvenTree, zakończ żądania w toku i potwierdź --confirm-upstream-stopped.');
      const id = UuidSchema.parse(values.operation);
      const reason = z.string().trim().min(10).max(1000).parse(values.reason);
      const operation = await db.query<{kind:string}>('SELECT kind FROM idempotency_records WHERE id=$1', [id]);
      if (!operation.rows[0] || !['consumption','transfer','receipt','adjustment'].includes(operation.rows[0].kind)) {
        throw new Error('Ta komenda dotyczy wyłącznie operacji zapasów. Dla lokalizacji użyj reconcile-warehouse.');
      }
      await resolveNotApplied(db, id, actorId, reason);
      process.stdout.write('Zapisano poświadczenie braku skutku; nie wykonano ponowienia ani kompensacji.\n');
    }
    if (command === 'reconcile-observed') {
      if (values['confirm-upstream-stopped'] !== true) throw new Error('Najpierw zatrzymaj API i wszystkich autorów zapisów InvenTree, zakończ żądania w toku i potwierdź --confirm-upstream-stopped.');
      const id = UuidSchema.parse(values.operation);
      const reason = z.string().trim().min(10).max(1000).parse(values.reason);
      const actualQuantity = z.string().regex(/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,5})?$/).parse(values['actual-quantity']);
      const operation = await db.query<{kind:string}>('SELECT kind FROM idempotency_records WHERE id=$1', [id]);
      if (!operation.rows[0] || !['consumption','transfer','receipt','adjustment'].includes(operation.rows[0].kind)) {
        throw new Error('Ta komenda dotyczy wyłącznie operacji zapasów. Dla lokalizacji użyj reconcile-warehouse.');
      }
      await resolveObservedEffect(db, id, actorId, actualQuantity, reason);
      process.stdout.write('Zapisano potwierdzoną rozbieżność z rzeczywistą ilością. Nie uznano jej za pełny sukces; bez ponowienia ani kompensacji.\n');
    }
    if (command === 'reconcile-warehouse') await reconcileWarehouse(db, {
      actorId, operationId: UuidSchema.parse(values.operation),
      resolution: z.enum(['applied', 'not_applied']).parse(values.resolution),
      ...(values.location === undefined ? {} : { locationId: z.coerce.number().int().positive().parse(values.location) }),
      confirmed: values['confirm-upstream-stopped'] === true,
      reason: z.string().trim().min(10).max(1000).parse(values.reason),
    });
  } finally { await db.end(); }
}

void run().catch(error => {
  // PostgreSQL and transport errors can contain connection details: never print raw diagnostics.
  if (error instanceof z.ZodError) process.stderr.write('Nieprawidłowe argumenty. Użyj --help.\n');
  else if (error instanceof Error && !('code' in error) && !('severity' in error)) process.stderr.write(`${error.message}\n`);
  else process.stderr.write('Operacja administracyjna nie powiodła się. Sprawdź uprawnienia i prywatne logi bez ujawniania sekretów.\n');
  process.exitCode = 1;
});
