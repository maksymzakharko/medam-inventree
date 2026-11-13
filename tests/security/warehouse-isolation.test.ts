import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnvironment, type TestEnvironment } from '../fixtures/app-fixture.js';

describe('all ten medic identities remain isolated across twelve warehouses', () => {
  let env: TestEnvironment;
  beforeAll(async () => { env = await createTestEnvironment(); });
  beforeEach(async () => { await env.reset(); });
  afterAll(async () => { await env?.close(); });

  it.each(Array.from({ length: 10 }, (_, n) => n + 1))('medic %i sees its own stock and cannot read or mutate the other eleven', async (i) => {
    const browser = env.browser();
    await browser.login(`ratownik${String(i).padStart(2, '0')}`);
    const own = await browser.request('GET', '/api/my-stock');
    expect(own.statusCode).toBe(200);
    expect(own.json().items.map((item: { id: number }) => item.id)).toEqual([1000 + i]);
    expect((await browser.request('GET', `/api/my-stock/${1000 + i}`)).statusCode).toBe(200);

    for (let other = 0; other < 12; other++) {
      if (other === i) continue;
      expect((await browser.request('GET', `/api/my-stock/${1000 + other}`)).statusCode).toBe(404);
      const consume = await browser.request('POST', '/api/consumptions', { stockItemId: 1000 + other, quantity: '1' }, { 'idempotency-key': randomUUID() });
      expect(consume.statusCode).toBe(404);
      const report = await browser.request('POST', '/api/problem-reports', { stockItemId: 1000 + other, category: 'damage', description: 'Test cudzej pozycji magazynowej' }, { 'idempotency-key': randomUUID() });
      expect(report.statusCode).toBe(404);
    }
    expect(env.upstream.mutationCount).toBe(0);
    expect((await env.db.query('SELECT count(*)::int AS n FROM problem_reports')).rows[0].n).toBe(0);
    for (const request of env.upstream.requests.filter((request) => request.path === '/api/stock/')) {
      expect(request.query.get('location')).toBe(String(100 + i));
      expect(request.query.get('cascade')).toBe('false');
    }
  });

  it('rejects added warehouse, user and actor fields rather than forwarding upstream filters', async () => {
    const browser = env.browser();
    await browser.login();
    for (const field of ['warehouseId', 'userId', 'actorId', 'location', 'cascade']) {
      expect((await browser.request('GET', `/api/my-stock?${field}=102`)).statusCode).toBe(400);
      expect((await browser.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '1', [field]: 102 }, { 'idempotency-key': randomUUID() })).statusCode).toBe(400);
    }
    expect(env.upstream.mutationCount).toBe(0);
  });

  it('fails closed when the upstream returns a foreign item, including on a later page', async () => {
    const browser = env.browser();
    await browser.login();
    env.upstream.leakForeignStock = true;
    const leaked = await browser.request('GET', '/api/my-stock');
    expect(leaked.statusCode).toBe(502);
    expect(leaked.body).not.toContain('TEST-LOT-02');
    env.upstream.leakForeignStock = false;
    const baseline = env.upstream.stock.get(1001)!;
    for (let i = 0; i < 104; i++) env.upstream.stock.set(7000 + i, { ...baseline, pk: 7000 + i });
    env.upstream.leakForeignOnLastPage = true;
    const laterPage = await browser.request('GET', '/api/my-stock');
    expect(laterPage.statusCode).toBe(502);
    expect(laterPage.body).not.toContain('TEST-LOT-00');
    expect(env.upstream.requests.some((request) => request.query.get('offset') === '100')).toBe(true);
  });

  it('protects history, problems, operation status and administrative export independently', async () => {
    const first = env.browser();
    await first.login();
    const operationId = randomUUID();
    const consumption = await first.request('POST', '/api/consumptions', { stockItemId: 1001, quantity: '1' }, { 'idempotency-key': operationId });
    expect(consumption.statusCode).toBe(201);
    const report = await first.request('POST', '/api/problem-reports', { stockItemId: 1001, category: 'damage', description: 'Uszkodzona ampułka z własnego magazynu' }, { 'idempotency-key': randomUUID() });
    expect(report.statusCode).toBe(201);
    const second = env.browser();
    await second.login('ratownik02');
    expect((await second.request('GET', `/api/operations/${operationId}`)).statusCode).toBe(404);
    const problems = await second.request('GET', '/api/problem-reports');
    expect(problems.statusCode).toBe(200);
    expect(problems.body).not.toContain('Uszkodzona ampułka');
    const history = await second.request('GET', '/api/my-history');
    expect(history.statusCode).toBe(200);
    expect(history.body).not.toContain(operationId);
    expect((await second.request('GET', '/api/my-history?userId=10000000-0000-4000-8000-000000000001')).statusCode).toBe(400);
    for (const path of ['/api/admin/warehouses', '/api/admin/audit', '/api/admin/exports?kind=stock', '/api/admin/users', '/api/admin/operations?state=review']) {
      expect((await second.request('GET', path)).statusCode).toBe(403);
    }
  });
});
