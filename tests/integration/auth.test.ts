import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnvironment, medicId, TEST_PASSWORD, type TestEnvironment } from '../fixtures/app-fixture.js';
import { issuePasswordReset } from '../../apps/api/src/modules/auth/service.js';

describe('sessions, CSRF and supervised password reset — real PostgreSQL', () => {
  let env: TestEnvironment;
  beforeAll(async () => { env = await createTestEnvironment(); });
  beforeEach(async () => { await env.reset(); });
  afterAll(async () => { await env?.close(); });

  it('requires a session and protects login with CSRF and exact Origin', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    const browser = env.browser();
    await browser.request('GET', '/api/auth/csrf');
    const missingCsrf = await browser.request('POST', '/api/auth/login', { login: 'ratownik01', password: TEST_PASSWORD }, { 'x-csrf-token': '' });
    expect(missingCsrf.statusCode).toBe(403);
    const wrongOrigin = await browser.request('POST', '/api/auth/login', { login: 'ratownik01', password: TEST_PASSWORD }, { origin: 'https://attacker.invalid' });
    expect(wrongOrigin.statusCode).toBe(403);
    const login = await browser.login();
    const cookies = String(login.headers['set-cookie']);
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('SameSite=Lax');
    const me = await browser.request('GET', '/api/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().user.warehouse).toMatchObject({ id: 101, code: 'MAG-01' });
    expect(me.headers['cache-control']).toContain('no-store');
  });

  it('does not expose whether a login exists and persists login rate limits', async () => {
    const browser = env.browser();
    await browser.request('GET', '/api/auth/csrf');
    const existing = await browser.request('POST', '/api/auth/login', { login: 'ratownik01', password: 'incorrect' });
    const missing = await browser.request('POST', '/api/auth/login', { login: 'unknown-user', password: 'incorrect' });
    expect(existing.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(existing.json().error.message).toBe(missing.json().error.message);
    for (let i = 0; i < 4; i++) await browser.request('POST', '/api/auth/login', { login: 'ratownik01', password: 'incorrect' });
    const limited = await browser.request('POST', '/api/auth/login', { login: 'ratownik01', password: 'incorrect' });
    expect(limited.statusCode).toBe(429);
    expect((await env.db.query('SELECT count(*)::int AS n FROM login_rate_limits')).rows[0].n).toBeGreaterThan(0);
    await env.restart();
    const afterRestart = env.browser();
    await afterRestart.request('GET', '/api/auth/csrf');
    expect((await afterRestart.request('POST', '/api/auth/login', { login: 'ratownik01', password: TEST_PASSWORD })).statusCode).toBe(429);
  });

  it('revokes logout and expired sessions rather than trusting a browser cookie', async () => {
    const browser = env.browser();
    await browser.login();
    const oldCookie = browser.cookieHeader();
    expect((await browser.request('POST', '/api/auth/logout', {})).statusCode).toBe(204);
    expect((await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: oldCookie } })).statusCode).toBe(401);
    await browser.login();
    await env.db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [medicId(1)]);
    expect((await browser.request('GET', '/api/me')).statusCode).toBe(401);
  });

  it('disables an active session immediately when its user is deactivated', async () => {
    const browser = env.browser();
    await browser.login();
    await env.db.query('UPDATE users SET active=false WHERE id=$1', [medicId(1)]);
    expect((await browser.request('GET', '/api/my-stock')).statusCode).toBe(401);
  });

  it('uses a hashed, expiring, single-use reset token and revokes all previous sessions', async () => {
    const oldSession = env.browser();
    await oldSession.login();
    const token = await issuePasswordReset(env.db, medicId(1), null);
    const stored = await env.db.query('SELECT token_hash FROM password_reset_tokens WHERE user_id=$1', [medicId(1)]);
    expect(stored.rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.rows[0].token_hash).not.toBe(token);
    const reset = env.browser();
    await reset.request('GET', '/api/auth/csrf');
    const changed = await reset.request('POST', '/api/auth/password-reset/confirm', { token, newPassword: `${TEST_PASSWORD}-new` });
    expect(changed.statusCode).toBe(204);
    expect((await oldSession.request('GET', '/api/me')).statusCode).toBe(401);
    await reset.request('GET', '/api/auth/csrf');
    expect((await reset.request('POST', '/api/auth/password-reset/confirm', { token, newPassword: TEST_PASSWORD })).statusCode).toBe(400);
    expect((await reset.login('ratownik01', `${TEST_PASSWORD}-new`)).statusCode).toBe(200);
    const completed = await env.db.query("SELECT count(*)::int AS n FROM application_audit_events WHERE action='auth.password_reset_completed'");
    expect(completed.rows[0].n).toBe(1);
  });
});
