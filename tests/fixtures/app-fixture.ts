import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import pg from 'pg';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { loadConfig } from '../../apps/api/src/config.js';
import { migrate } from '../../apps/api/src/db/migrate.js';
import { InventreeStub } from './inventree-stub.js';

export const TEST_PASSWORD = 'Haslo-wylacznie-testowe-2026!';
export const TEST_ORIGIN = 'http://127.0.0.1:5179';
export const medicId = (i: number) => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
export const ADMIN_ID = '20000000-0000-4000-8000-000000000001';
export const MANAGER_ID = '20000000-0000-4000-8000-000000000002';

/** Explicit test database name is a guard against destructive fixture execution elsewhere. */
export function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error('TEST_DATABASE_URL is required. Create an isolated database named medam_test (never a production database).');
  const parsed = new URL(value);
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (!/^medam_test(?:_|$)/.test(name)) throw new Error('Fixture refuses database without the medam_test prefix.');
  return value;
}

export class TestBrowser {
  private jar = new Map<string, string>();
  csrfToken = '';
  constructor(readonly app: FastifyInstance) {}

  cookieHeader() { return Array.from(this.jar).map(([name, value]) => `${name}=${value}`).join('; '); }
  headers(unsafe = false): Record<string, string> {
    return { cookie: this.cookieHeader(), ...(unsafe ? { origin: TEST_ORIGIN, 'x-csrf-token': this.csrfToken } : {}) };
  }

  async request(method: InjectOptions['method'], url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) {
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase());
    const options: InjectOptions = { method, url, headers: { ...this.headers(unsafe), ...extraHeaders } };
    if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
    const response = await this.app.inject(options);
    this.capture(response);
    return response;
  }

  capture(response: LightMyRequestResponse) {
    const raw = response.headers['set-cookie'];
    for (const cookie of raw ? Array.isArray(raw) ? raw : [raw] : []) {
      const pair = cookie.split(';')[0];
      if (!pair) continue;
      const at = pair.indexOf('=');
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (!value || /Max-Age=0/i.test(cookie)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    if (String(response.headers['content-type']).includes('application/json')) {
      const data = response.json() as { csrfToken?: string };
      if (data.csrfToken) this.csrfToken = data.csrfToken;
    }
  }

  async login(login = 'ratownik01', password = TEST_PASSWORD) {
    const csrf = await this.request('GET', '/api/auth/csrf');
    if (csrf.statusCode !== 200) throw new Error(`CSRF setup failed (${csrf.statusCode}): ${csrf.body}`);
    const result = await this.request('POST', '/api/auth/login', { login, password });
    if (result.statusCode !== 200) throw new Error(`Login fixture failed (${result.statusCode}): ${result.body}`);
    return result;
  }
}

export async function createTestEnvironment() {
  const databaseUrl = testDatabaseUrl();
  const db = new pg.Pool({ connectionString: databaseUrl, max: 25 });
  await migrate(db);
  const upstream = await new InventreeStub().start();
  const config = loadConfig({
    NODE_ENV: 'test', APP_ORIGIN: TEST_ORIGIN, APP_DATABASE_URL: databaseUrl,
    SESSION_SECRET: randomBytes(48).toString('base64url'), COOKIE_SECURE: 'false',
    INVENTREE_URL: upstream.url, INVENTREE_TOKEN: upstream.token,
    INVENTREE_TIMEOUT_MS: '500', INVENTREE_EXPECTED_VERSION: '1.7.0',
    INVENTREE_EXPECTED_API_VERSION: '570',
  });
  let app = await buildApp({ config, db, logger: false });
  await app.ready();
  const passwordHash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

  async function reset() {
    upstream.reset();
    // This connection passed the dedicated-database guard above. Never reuse against customer data.
    await db.query('TRUNCATE users, warehouse_mappings, login_rate_limits CASCADE');
    await db.query("INSERT INTO inventory_mutation_gate(id) VALUES ('inventory') ON CONFLICT DO NOTHING");
    for (let i = 0; i < 12; i++) {
      await db.query('INSERT INTO warehouse_mappings(location_id,code,name) VALUES ($1,$2,$3)', [100 + i, `MAG-${String(i).padStart(2, '0')}`, i === 0 ? 'Magazyn główny' : i === 11 ? 'Gabinet' : `Ratownik ${i}`]);
      await db.query('INSERT INTO warehouse_product_policies(location_id,part_id,minimum,quantum) VALUES ($1,1,5,1)', [100 + i]);
    }
    for (let i = 1; i <= 10; i++) {
      await db.query('INSERT INTO users(id,login,password_hash,role) VALUES ($1,$2,$3,$4)', [medicId(i), `ratownik${String(i).padStart(2, '0')}`, passwordHash, 'medic']);
      await db.query('INSERT INTO user_warehouse_assignments(user_id,location_id) VALUES ($1,$2)', [medicId(i), 100 + i]);
    }
    await db.query('INSERT INTO users(id,login,password_hash,role) VALUES ($1,$2,$3,$4),($5,$6,$3,$7)', [ADMIN_ID, 'administrator', passwordHash, 'admin', MANAGER_ID, 'magazynier', 'warehouse_manager']);
  }

  await reset();
  return {
    get app() { return app; }, db, config, upstream, reset,
    browser: () => new TestBrowser(app),
    async restart() {
      await app.close();
      app = await buildApp({ config, db, logger: false });
      await app.ready();
    },
    async close() { await app.close(); await upstream.close(); await db.end(); },
  };
}

export type TestEnvironment = Awaited<ReturnType<typeof createTestEnvironment>>;
