import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnvironment, type TestEnvironment } from '../fixtures/app-fixture.js';

describe('stock eligibility, FEFO and per-warehouse product rules', () => {
  let env: TestEnvironment;
  beforeAll(async () => { env = await createTestEnvironment(); });
  beforeEach(async () => { await env.reset(); });
  afterAll(async () => { await env?.close(); });

  it('rejects impossible EXP dates received from the upstream instead of allowing a malformed batch', async () => {
    env.upstream.stock.get(1001)!.expiry_date = '2099-02-30';
    const browser = env.browser();
    await browser.login();
    expect((await browser.request('GET', '/api/my-stock')).statusCode).toBe(502);
    expect((await browser.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '1' }, { 'idempotency-key': randomUUID() })).statusCode).toBe(502);
    expect(env.upstream.mutationCount).toBe(0);
  });

  it('returns the same public not-found error for a foreign id and a nonexistent id', async () => {
    const browser = env.browser();
    await browser.login();
    const foreign = await browser.request('GET', '/api/my-stock/1002');
    const missing = await browser.request('GET', '/api/my-stock/999999');
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe(missing.json().error.code);
    expect(foreign.json().error.message).toBe(missing.json().error.message);
  });

  it('uses the sum of eligible lots for minimum stock and recommends eligible lots in FEFO order', async () => {
    const baseline = env.upstream.stock.get(1001)!;
    baseline.quantity = '3';
    env.upstream.stock.set(7001, { ...baseline, pk: 7001, quantity: '3', batch: 'SECOND-LOT', expiry_date: '2099-01-01' });
    env.upstream.stock.set(7002, { ...baseline, pk: 7002, quantity: '100', batch: 'BLOCKED-LOT', expiry_date: '2090-01-01', status: 55 });
    const browser = env.browser();
    await browser.login();
    const first = (await browser.request('GET', '/api/my-stock')).json().items as Array<{ id: number; eligibleForConsumption: boolean; warnings: string[] }>;
    expect(first.map((item) => item.id)).toEqual([7001, 1001, 7002]);
    expect(first.filter((item) => item.eligibleForConsumption).every((item) => !item.warnings.includes('LOW_STOCK'))).toBe(true);
    env.upstream.stock.get(7001)!.quantity = '1';
    const low = (await browser.request('GET', '/api/my-stock')).json().items as typeof first;
    expect(low.filter((item) => item.eligibleForConsumption).every((item) => item.warnings.includes('LOW_STOCK'))).toBe(true);
  });

  it('restricts policy editing to administrators/managers and applies the configured quantity quantum', async () => {
    const medic = env.browser();
    await medic.login();
    expect((await medic.request('PUT', '/api/admin/warehouses/101/policies/1', { minimum: '8', quantum: '0.5' })).statusCode).toBe(403);
    expect((await medic.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '0.5' }, { 'idempotency-key': randomUUID() })).statusCode).toBe(400);
    const admin = env.browser();
    await admin.login('administrator');
    expect((await admin.request('PUT', '/api/admin/warehouses/101/policies/1', { minimum: '8', quantum: '0.5' })).statusCode).toBe(200);
    const consume = await medic.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '0.5' }, { 'idempotency-key': randomUUID() });
    expect(consume.statusCode).toBe(201);
    expect(consume.json().appliedQuantity).toBe('0.5');
    expect(env.upstream.mutationCount).toBe(1);
  });
});
