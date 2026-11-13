import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveObservedEffect } from '../../apps/api/src/modules/consumption/operations.js';
import { ADMIN_ID, MANAGER_ID, createTestEnvironment, medicId, testDatabaseUrl, type TestEnvironment } from '../fixtures/app-fixture.js';

const reason = 'Sprawdzono rzeczywisty stan i audyt po zatrzymaniu wszystkich autorów zapisów.';
const cliFile = fileURLToPath(new URL('../../apps/api/src/cli/index.ts', import.meta.url));

/** Run the actual operator entry point; the dedicated database URL is never a command argument. */
async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cliFile, ...args], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, APP_DATABASE_URL: testDatabaseUrl(), APP_DATABASE_URL_FILE: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

describe('manual reconciliation of an observed exceptional effect', () => {
  let env: TestEnvironment;
  beforeAll(async () => { env = await createTestEnvironment(); });
  beforeEach(async () => { await env.reset(); });
  afterAll(async () => { await env?.close(); });

  async function ambiguousConsumption() {
    const browser = env.browser();
    await browser.login();
    const id = randomUUID();
    env.upstream.behaviour = 'timeout-after-apply';
    const response = await browser.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '2' }, { 'idempotency-key': id });
    expect(response.statusCode).toBe(202);
    expect(response.json().state).toBe('UNCERTAIN');
    return { id };
  }

  async function expectUnresolved(id: string) {
    expect((await env.db.query('SELECT state FROM idempotency_records WHERE id=$1', [id])).rows[0].state).toBe('UNCERTAIN');
    expect((await env.db.query("SELECT operation_id FROM inventory_mutation_gate WHERE id='inventory'")).rows[0].operation_id).toBe(id);
    expect((await env.db.query("SELECT id FROM application_audit_events WHERE operation_id=$1 AND action='inventory.reconcile.observed'", [id])).rowCount).toBe(0);
    expect(env.upstream.mutationCount).toBe(1);
  }

  it('persists a distinct terminal state, observed quantity and operator audit, then replays without a second upstream write', async () => {
    const { id } = await ambiguousConsumption();
    expect(env.upstream.stock.get(1001)?.quantity).toBe('98');
    await resolveObservedEffect(env.db, id, ADMIN_ID, '2.00000', reason);

    const saved = (await env.db.query('SELECT state,response FROM idempotency_records WHERE id=$1', [id])).rows[0];
    expect(saved).toMatchObject({
      state: 'RECONCILED_DISCREPANCY',
      response: { appliedQuantity: '2', reason, maintenanceAttestation: true, manualDiscrepancy: true },
    });
    const audit = (await env.db.query("SELECT actor_id,outcome,details FROM application_audit_events WHERE operation_id=$1 AND action='inventory.reconcile.observed'", [id])).rows;
    expect(audit).toEqual([expect.objectContaining({
      actor_id: ADMIN_ID,
      outcome: 'RECONCILED_DISCREPANCY',
      details: { reason, actualQuantity: '2', requestedQuantity: '2', upstreamWritersStopped: true, manualAttestation: true },
    })]);
    expect((await env.db.query("SELECT operation_id FROM inventory_mutation_gate WHERE id='inventory'")).rows[0].operation_id).toBeNull();

    await env.restart();
    const restored = env.browser();
    await restored.login();
    const status = await restored.request('GET', `/api/operations/${id}`);
    expect(status.json()).toMatchObject({ state: 'RECONCILED_DISCREPANCY', requestedQuantity: '2', appliedQuantity: '2' });
    const replay = await restored.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '2' }, { 'idempotency-key': id });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().state).toBe('RECONCILED_DISCREPANCY');
    expect(env.upstream.mutationCount).toBe(1);
  });

  it('rejects non-admin or inactive operators, invalid quantities and incomplete reasons without releasing the gate', async () => {
    const { id } = await ambiguousConsumption();
    for (const actorId of [medicId(1), MANAGER_ID, randomUUID()]) {
      await expect(resolveObservedEffect(env.db, id, actorId, '2', reason)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await env.db.query('UPDATE users SET active=false WHERE id=$1', [ADMIN_ID]);
    await expect(resolveObservedEffect(env.db, id, ADMIN_ID, '2', reason)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await env.db.query('UPDATE users SET active=true WHERE id=$1', [ADMIN_ID]);
    for (const quantity of ['-1', '1e2', '01', '1,5', '1.000001', '10000000000', '']) {
      await expect(resolveObservedEffect(env.db, id, ADMIN_ID, quantity, reason)).rejects.toMatchObject({ code: 'QUANTITY_INVALID' });
    }
    for (const invalidReason of ['krótko', ' '.repeat(20), 'x'.repeat(1001)]) {
      await expect(resolveObservedEffect(env.db, id, ADMIN_ID, '2', invalidReason)).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    }
    await expectUnresolved(id);
  });

  it('rolls back operation and gate changes if appending the required audit fails', async () => {
    const { id } = await ambiguousConsumption();
    await env.db.query(`CREATE FUNCTION medam_test_fail_reconciliation_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test maintenance audit unavailable'; END;
    $$`);
    try {
      await env.db.query(`CREATE TRIGGER medam_test_fail_reconciliation_audit BEFORE INSERT ON application_audit_events
        FOR EACH ROW WHEN (NEW.action = 'inventory.reconcile.observed') EXECUTE FUNCTION medam_test_fail_reconciliation_audit()`);
      await expect(resolveObservedEffect(env.db, id, ADMIN_ID, '2', reason)).rejects.toMatchObject({ message: 'test maintenance audit unavailable' });
      await expectUnresolved(id);
    } finally {
      await env.db.query('DROP TRIGGER IF EXISTS medam_test_fail_reconciliation_audit ON application_audit_events');
      await env.db.query('DROP FUNCTION medam_test_fail_reconciliation_audit()');
    }
  });

  it('refuses to overwrite a terminal attestation with a second observed effect', async () => {
    const { id } = await ambiguousConsumption();
    await resolveObservedEffect(env.db, id, ADMIN_ID, '2', reason);
    await expect(resolveObservedEffect(env.db, id, ADMIN_ID, '0', 'Inna próba rozliczenia wcześniej zakończonej operacji.')).rejects.toMatchObject({ code: 'OPERATION_STATE' });
    expect((await env.db.query('SELECT state,response FROM idempotency_records WHERE id=$1', [id])).rows[0]).toMatchObject({ state: 'RECONCILED_DISCREPANCY', response: { appliedQuantity: '2', reason } });
    expect((await env.db.query("SELECT id FROM application_audit_events WHERE operation_id=$1 AND action='inventory.reconcile.observed'", [id])).rowCount).toBe(1);
    expect(env.upstream.mutationCount).toBe(1);
  });

  it('requires explicit upstream-stopped attestation in the actual CLI and rejects a warehouse operation', async () => {
    const { id } = await ambiguousConsumption();
    const args = ['reconcile-observed', '--actor', ADMIN_ID, '--operation', id, '--actual-quantity', '2', '--reason', reason];
    const unconfirmed = await runCli(args);
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.stderr).toContain('--confirm-upstream-stopped');
    await expectUnresolved(id);

    await env.db.query("UPDATE idempotency_records SET kind='warehouse_create' WHERE id=$1", [id]);
    const wrongKind = await runCli([...args, '--confirm-upstream-stopped']);
    expect(wrongKind.code).toBe(1);
    expect(wrongKind.stderr).toContain('reconcile-warehouse');
    await expect(resolveObservedEffect(env.db, id, ADMIN_ID, '2', reason)).rejects.toMatchObject({ code: 'OPERATION_STATE' });
    await expectUnresolved(id);
  });

  it('runs the confirmed CLI against the isolated database without retrying or compensating upstream', async () => {
    const { id } = await ambiguousConsumption();
    const result = await runCli(['reconcile-observed', '--actor', ADMIN_ID, '--operation', id, '--actual-quantity', '2', '--reason', reason, '--confirm-upstream-stopped']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Nie uznano jej za pełny sukces');
    expect((await env.db.query('SELECT state,response FROM idempotency_records WHERE id=$1', [id])).rows[0]).toMatchObject({ state: 'RECONCILED_DISCREPANCY', response: { appliedQuantity: '2' } });
    expect((await env.db.query("SELECT operation_id FROM inventory_mutation_gate WHERE id='inventory'")).rows[0].operation_id).toBeNull();
    expect(env.upstream.stock.get(1001)?.quantity).toBe('98');
    expect(env.upstream.mutationCount).toBe(1);
  });
});
