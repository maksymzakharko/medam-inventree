import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../../apps/api/src/modules/auth/service.js';
import { ADMIN_ID, MANAGER_ID, createTestEnvironment, medicId, type TestBrowser, type TestEnvironment } from '../fixtures/app-fixture.js';

describe('authorization changes while an authenticated HTTP request is waiting for its body', () => {
  let env: TestEnvironment;
  let address: string;
  beforeAll(async () => {
    env = await createTestEnvironment();
    address = await env.app.listen({ port: 0, host: '127.0.0.1' });
  });
  beforeEach(async () => { await env.reset(); });
  afterAll(async () => { await env?.close(); });

  async function delayedWrite(browser: TestBrowser, path: string, operationId: string, payload: unknown, changeAuthorization: () => Promise<void>) {
    const cookie = browser.cookieHeader().match(/(?:^|; )medam_session=([^;]+)/)?.[1];
    if (!cookie) throw new Error('Missing test login session');
    const tokenHash = hashToken(cookie);
    const baseline = (await env.db.query<{ last_seen_at: Date }>(`UPDATE sessions SET last_seen_at=now()-interval '30 seconds'
      WHERE token_hash=$1 RETURNING last_seen_at`, [tokenHash])).rows[0]!.last_seen_at.getTime();
    const body = JSON.stringify(payload);
    let request!: ReturnType<typeof httpRequest>;
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      request = httpRequest(new URL(path, address), {
        method: 'POST',
        headers: {
          ...browser.headers(true),
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'idempotency-key': operationId,
        },
      }, incoming => {
        let responseBody = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk: string) => { responseBody += chunk; });
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: responseBody }));
        incoming.on('error', reject);
      });
      request.on('error', reject);
    });
    // Cleanup can abort the intentionally incomplete body after a failed assertion.
    void response.catch(() => undefined);
    try {
      request.flushHeaders();
      // The onRequest session lookup updates last_seen_at before body parsing. Observing
      // that committed change proves this request captured the old actor; no timing sleep
      // or production-only synchronization hook is needed.
      await expect.poll(async () => {
        const row = (await env.db.query<{ last_seen_at: Date }>('SELECT last_seen_at FROM sessions WHERE token_hash=$1', [tokenHash])).rows[0];
        return row?.last_seen_at.getTime() ?? baseline;
      }, { timeout: 5000, interval: 10 }).toBeGreaterThan(baseline);
      await changeAuthorization();
      request.end(body);
      return await response;
    } finally {
      request.destroy();
    }
  }

  async function expectRejectedWithoutWrite(result: { status: number; body: string }, operationId: string) {
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body)).toHaveProperty('error.code');
    expect(env.upstream.mutationCount).toBe(0);
    expect(env.upstream.requests.filter(entry => entry.method === 'POST')).toHaveLength(0);
    expect(env.upstream.stock.get(1001)?.quantity).toBe('100');
    expect((await env.db.query('SELECT id FROM idempotency_records WHERE id=$1', [operationId])).rowCount).toBe(0);
    expect((await env.db.query("SELECT operation_id FROM inventory_mutation_gate WHERE id='inventory'")).rows[0].operation_id).toBeNull();
  }

  it('rejects a medic consumption when the account was deactivated after headers were authenticated', async () => {
    const medic = env.browser();
    const admin = env.browser();
    await medic.login();
    await admin.login('administrator');
    const id = randomUUID();
    const result = await delayedWrite(medic, '/api/consumptions', id, { stockItemId: 1001, quantity: '1' }, async () => {
      const changed = await admin.request('PATCH', `/api/admin/users/${medicId(1)}`, { version: 1, active: false });
      expect(changed.statusCode).toBe(200);
    });
    await expectRejectedWithoutWrite(result, id);
  });

  it('rejects a medic consumption for the former warehouse after reassignment and requires a fresh login', async () => {
    const medic = env.browser();
    const admin = env.browser();
    await medic.login();
    await admin.login('administrator');
    // Free MAG-02 through the real administrator endpoint before starting the race.
    expect((await admin.request('PATCH', `/api/admin/users/${medicId(2)}`, { version: 1, active: false })).statusCode).toBe(200);
    const id = randomUUID();
    const result = await delayedWrite(medic, '/api/consumptions', id, { stockItemId: 1001, quantity: '1' }, async () => {
      const changed = await admin.request('PATCH', `/api/admin/users/${medicId(1)}`, { version: 1, warehouseId: 102 });
      expect(changed.statusCode).toBe(200);
    });
    await expectRejectedWithoutWrite(result, id);
    expect((await medic.request('GET', '/api/my-stock')).statusCode).toBe(401);
    await medic.login();
    const own = await medic.request('GET', '/api/my-stock');
    expect(own.statusCode).toBe(200);
    expect(own.json().items.map((item: { id: number }) => item.id)).toEqual([1002]);
    expect((await medic.request('GET', '/api/my-stock/1001')).statusCode).toBe(404);
  });

  it('rejects an administrative receipt when a second administrator demotes its author before the body arrives', async () => {
    const admin = env.browser();
    await admin.login('administrator');
    expect((await admin.request('PATCH', `/api/admin/users/${MANAGER_ID}`, { version: 1, role: 'admin' })).statusCode).toBe(200);
    expect((await admin.request('PATCH', `/api/admin/users/${medicId(1)}`, { version: 1, active: false })).statusCode).toBe(200);
    const secondAdmin = env.browser();
    await secondAdmin.login('magazynier');
    const id = randomUUID();
    const result = await delayedWrite(admin, '/api/admin/receipts', id, { partId: 1, warehouseId: 100, quantity: '1', lot: 'DENIED-STALE-ADMIN', exp: '2099-12-31' }, async () => {
      const changed = await secondAdmin.request('PATCH', `/api/admin/users/${ADMIN_ID}`, { version: 1, role: 'medic', warehouseId: 101 });
      expect(changed.statusCode).toBe(200);
    });
    await expectRejectedWithoutWrite(result, id);
    expect(Array.from(env.upstream.stock.values()).some(stock => stock.batch === 'DENIED-STALE-ADMIN')).toBe(false);
    expect((await admin.request('GET', '/api/admin/users')).statusCode).toBe(401);
  });
});
