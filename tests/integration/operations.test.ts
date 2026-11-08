import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnvironment, type TestEnvironment } from '../fixtures/app-fixture.js';

describe('durable operations with a real database and a fault-controlled HTTP transport double', () => {
  let env: TestEnvironment;
  beforeAll(async () => { env = await createTestEnvironment(); });
  beforeEach(async () => { await env.reset(); });
  afterAll(async () => { await env?.close(); });

  it('normalizes an uppercase operation key before correlating upstream evidence and replays either spelling', async () => {
    const browser = env.browser();
    await browser.login();
    const id = randomUUID();
    const first = await browser.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '2' }, { 'idempotency-key': id.toUpperCase() });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ id, state: 'SUCCEEDED', appliedQuantity: '2' });
    expect(env.upstream.audit.map(event => event.cid)).toEqual([id]);
    const replay = await browser.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '2' }, { 'idempotency-key': id });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({ id, state: 'SUCCEEDED' });
    expect(env.upstream.mutationCount).toBe(1);
    expect((await browser.request('GET', `/api/operations/${id.toUpperCase()}`)).json().id).toBe(id);
  });

  it('sends one mutation for twenty simultaneous identical keys and replays without fetching missing stock', async () => {
    const browser = env.browser();
    await browser.login();
    const id = randomUUID();
    const requests = Array.from({ length: 20 }, () => browser.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '2' }, { 'idempotency-key': id }));
    const responses = await Promise.all(requests);
    expect(responses.every((response) => [201, 202].includes(response.statusCode))).toBe(true);
    expect(env.upstream.mutationCount).toBe(1);
    expect(env.upstream.stock.get(1001)?.quantity).toBe('98');
    expect((await browser.request('GET', `/api/operations/${id}`)).json().state).toBe('SUCCEEDED');
    env.upstream.stock.delete(1001);
    const replay = await browser.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '2' }, { 'idempotency-key': id });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({ id, state: 'SUCCEEDED' });
    const conflict = await browser.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '3' }, { 'idempotency-key': id });
    expect(conflict.statusCode).toBe(409);
    expect(env.upstream.mutationCount).toBe(1);
    const gate = await env.db.query("SELECT operation_id FROM inventory_mutation_gate WHERE id='inventory'");
    expect(gate.rows[0].operation_id).toBeNull();
    const audit = await env.db.query('SELECT outcome FROM application_audit_events WHERE operation_id=$1', [id]);
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps an ambiguous operation and its global gate through restart without resending', async () => {
    const browser = env.browser();
    await browser.login();
    const cookie = browser.cookieHeader();
    const id = randomUUID();
    env.upstream.behaviour = 'timeout-after-apply';
    const first = await browser.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '2' }, { 'idempotency-key': id });
    expect(first.statusCode).toBe(202);
    expect(first.json().state).toBe('UNCERTAIN');
    expect(env.upstream.mutationCount).toBe(1);
    expect(env.upstream.stock.get(1001)?.quantity).toBe('98');
    await env.restart();
    const status = await env.app.inject({ method: 'GET', url: `/api/operations/${id}`, headers: { cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json().state).toBe('UNCERTAIN');
    const restored = env.browser();
    await restored.login();
    const replay = await restored.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '2' }, { 'idempotency-key': id });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().state).toBe('UNCERTAIN');
    expect((await restored.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '1' }, { 'idempotency-key': randomUUID() })).statusCode).toBe(423);
    expect(env.upstream.mutationCount).toBe(1);
    const gate = await env.db.query("SELECT operation_id FROM inventory_mutation_gate WHERE id='inventory'");
    expect(gate.rows[0].operation_id).toBe(id);
    // App-only reporting and logout remain usable while stock writes are blocked.
    expect((await restored.request('POST', '/api/problem-reports', { category: 'other', description: 'Potrzebne uzgodnienie operacji bez ponawiania' }, { 'idempotency-key': randomUUID() })).statusCode).toBe(201);
    expect((await restored.request('POST', '/api/auth/logout', {})).statusCode).toBe(204);
  });

  it('does not report full success for a 201 with a partial actual delta and reconciles the partial result', async () => {
    const medic = env.browser();
    await medic.login();
    const id = randomUUID();
    env.upstream.behaviour = 'partial';
    const response = await medic.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '3' }, { 'idempotency-key': id });
    expect(response.statusCode).toBe(202);
    expect(response.json().state).toBe('DISCREPANCY');
    expect(response.json().appliedQuantity).toBe('1');
    const admin = env.browser();
    await admin.login('administrator');
    const reconciled = await admin.request('POST', `/api/admin/operations/${id}/reconcile`, { resolution: 'partial', evidenceIds: env.upstream.audit.map((event) => event.pk), reason: 'Potwierdzona faktyczna ilość według audytu InvenTree.' });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toMatchObject({ state: 'RECONCILED_PARTIAL', appliedQuantity: '1' });
    expect((await env.db.query("SELECT operation_id FROM inventory_mutation_gate WHERE id='inventory'")).rows[0].operation_id).toBeNull();
    expect(env.upstream.mutationCount).toBe(1);
  });

  it.each(['missing-audit', 'duplicate-audit'] as const)('keeps the gate closed when proof is %s', async (behaviour) => {
    const browser = env.browser();
    await browser.login();
    const id = randomUUID();
    env.upstream.behaviour = behaviour;
    const response = await browser.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '1' }, { 'idempotency-key': id });
    expect(response.statusCode).toBe(202);
    expect(['UNCERTAIN', 'DISCREPANCY']).toContain(response.json().state);
    expect((await env.db.query("SELECT operation_id FROM inventory_mutation_gate WHERE id='inventory'")).rows[0].operation_id).toBe(id);
    expect(env.upstream.mutationCount).toBe(1);
  });

  it('rejects invalid quantity, expired, allocated and unavailable stock before an upstream mutation', async () => {
    const browser = env.browser();
    await browser.login();
    for (const quantity of ['0', '-1', '1e2', '1,5', '10000000000', '0.000001', '01']) {
      expect((await browser.request('POST', '/api/consumptions', { stockItemId: 1001, quantity }, { 'idempotency-key': randomUUID() })).statusCode).toBe(400);
    }
    expect((await browser.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '101' }, { 'idempotency-key': randomUUID() })).statusCode).toBe(409);
    const stock = env.upstream.stock.get(1001)!;
    stock.expiry_date = '2000-01-01';
    expect((await browser.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '1' }, { 'idempotency-key': randomUUID() })).statusCode).toBe(409);
    stock.expiry_date = '2099-06-30'; stock.allocated = '1';
    expect((await browser.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '1' }, { 'idempotency-key': randomUUID() })).statusCode).toBe(409);
    stock.allocated = '0'; stock.status = 55;
    expect((await browser.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '1' }, { 'idempotency-key': randomUUID() })).statusCode).toBe(409);
    expect(env.upstream.mutationCount).toBe(0);
  });

  it('serializes different keys so two simultaneous consumptions cannot together exceed the stock', async () => {
    const browser = env.browser();
    await browser.login();
    const results = await Promise.all(Array.from({ length: 2 }, () => browser.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '70' }, { 'idempotency-key': randomUUID() })));
    expect(results.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(results.every((response) => [201, 409, 423].includes(response.statusCode))).toBe(true);
    expect(env.upstream.mutationCount).toBe(1);
    expect(env.upstream.stock.get(1001)?.quantity).toBe('30');
  });

  it('verifies a receipt by its authenticated cid and replays it without creating a duplicate lot', async () => {
    const admin = env.browser();
    await admin.login('administrator');
    const id = randomUUID();
    const receipt = { partId: 1, warehouseId: 101, quantity: '7', lot: 'NEW-LOT-TEST', exp: '2099-12-31' };
    const result = await admin.request('POST', '/api/admin/receipts', receipt, { 'idempotency-key': id });
    expect(result.statusCode).toBe(201);
    expect(result.json()).toMatchObject({ state: 'SUCCEEDED', appliedQuantity: '7' });
    const replay = await admin.request('POST', '/api/admin/receipts', receipt, { 'idempotency-key': id });
    expect(replay.statusCode).toBe(201);
    expect(env.upstream.mutationCount).toBe(1);
    expect(Array.from(env.upstream.stock.values()).filter((stock) => stock.batch === 'NEW-LOT-TEST')).toHaveLength(1);
  });

  it('verifies split transfer source and child ids while preserving LOT and EXP', async () => {
    const admin = env.browser();
    await admin.login('administrator');
    const transfer = await admin.request('POST', '/api/admin/warehouse-transfers', { stockItemId: 1000, destinationWarehouseId: 101, quantity: '5' }, { 'idempotency-key': randomUUID() });
    expect(transfer.statusCode).toBe(201);
    expect(transfer.json()).toMatchObject({ state: 'SUCCEEDED', appliedQuantity: '5' });
    expect(env.upstream.stock.get(1000)?.quantity).toBe('95');
    const moved = Array.from(env.upstream.stock.values()).find((stock) => stock.parent === 1000);
    expect(moved).toMatchObject({ quantity: '5', location: 101, batch: 'TEST-LOT-00', expiry_date: '2099-06-30' });
    expect(moved?.pk).not.toBe(1000);
    expect(env.upstream.mutationCount).toBe(1);
    expect(env.upstream.audit.map((entry) => entry.event_type)).toEqual([42, 40]);
  });

  it('allows an audited administrative loss of expired damaged stock while blocking medical consumption', async () => {
    const stock = env.upstream.stock.get(1001)!;
    stock.expiry_date = '2000-01-01'; stock.status = 55;
    const medic = env.browser();
    await medic.login();
    expect((await medic.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '2' }, { 'idempotency-key': randomUUID() })).statusCode).toBe(409);
    const admin = env.browser();
    await admin.login('administrator');
    const loss = await admin.request('POST', '/api/admin/adjustments', { stockItemId: 1001, quantity: '2', direction: 'decrease', reason: 'Przeterminowanie i uszkodzenie — rozliczenie straty.' }, { 'idempotency-key': randomUUID() });
    expect(loss.statusCode).toBe(201);
    expect(loss.json()).toMatchObject({ state: 'SUCCEEDED', appliedQuantity: '2' });
    expect(env.upstream.stock.get(1001)).toMatchObject({ quantity: '98', status: 55, expiry_date: '2000-01-01' });
    expect(env.upstream.mutationCount).toBe(1);
  });

  it('exports operations only for the selected source, destination or receipt warehouse', async () => {
    const medicOne = env.browser();
    const medicTwo = env.browser();
    const admin = env.browser();
    await medicOne.login();
    await medicTwo.login('ratownik02');
    await admin.login('administrator');
    const consumptionOne = randomUUID();
    const consumptionTwo = randomUUID();
    const transfer = randomUUID();
    const receipt = randomUUID();
    expect((await medicOne.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '1' }, { 'idempotency-key': consumptionOne })).statusCode).toBe(201);
    expect((await medicTwo.request('POST', '/api/consumptions', { stockItemId: 1002, quantity: '1' }, { 'idempotency-key': consumptionTwo })).statusCode).toBe(201);
    expect((await admin.request('POST', '/api/admin/warehouse-transfers', { stockItemId: 1000, destinationWarehouseId: 101, quantity: '5' }, { 'idempotency-key': transfer })).statusCode).toBe(201);
    expect((await admin.request('POST', '/api/admin/receipts', { partId: 1, warehouseId: 103, quantity: '7', lot: 'SCOPED-CSV-LOT', exp: '2099-12-31' }, { 'idempotency-key': receipt })).statusCode).toBe(201);

    for (const [warehouseId, included, excluded] of [
      [101, [consumptionOne, transfer], [consumptionTwo, receipt]],
      [100, [transfer], [consumptionOne, consumptionTwo, receipt]],
      [102, [consumptionTwo], [consumptionOne, transfer, receipt]],
      [103, [receipt], [consumptionOne, consumptionTwo, transfer]],
    ] as const) {
      const exported = await admin.request('GET', `/api/admin/exports?kind=operations&warehouseId=${warehouseId}`);
      expect(exported.statusCode).toBe(200);
      expect(exported.headers['content-type']).toContain('text/csv');
      for (const id of included) expect(exported.body).toContain(`"${id}"`);
      for (const id of excluded) expect(exported.body).not.toContain(`"${id}"`);
    }
  });
});
