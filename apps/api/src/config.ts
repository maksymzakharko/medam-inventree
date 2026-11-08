import { readFileSync } from 'node:fs';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ORIGIN: z.url().default('http://localhost:8080'),
  APP_DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
  SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(24).default(12),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TRUST_PROXY: z.string().optional(),
  INVENTREE_URL: z.url(),
  INVENTREE_TOKEN: z.string().min(1),
  INVENTREE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(10000),
  INVENTREE_EXPECTED_VERSION: z.string().default('1.7.0'),
  INVENTREE_EXPECTED_API_VERSION: z.coerce.number().int().positive().default(570),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const values = { ...env };
  for (const key of ['APP_DATABASE_URL', 'SESSION_SECRET', 'INVENTREE_TOKEN']) {
    const file = values[`${key}_FILE`];
    if (file) values[key] = readFileSync(file, 'utf8').trim();
  }
  const parsed = EnvSchema.safeParse(values);
  if (!parsed.success) throw new Error(`Nieprawidłowa konfiguracja: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  const e = parsed.data;
  const origin = new URL(e.APP_ORIGIN);
  if (origin.origin !== e.APP_ORIGIN || origin.username || origin.password) throw new Error('APP_ORIGIN musi zawierać wyłącznie origin bez ścieżki.');
  const cookieSecure = e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : origin.protocol === 'https:';
  if (e.NODE_ENV === 'production' && (!cookieSecure || origin.protocol !== 'https:')) throw new Error('Produkcja wymaga HTTPS i bezpiecznych ciasteczek.');
  const upstream = new URL(e.INVENTREE_URL);
  if (upstream.username || upstream.password || !['http:', 'https:'].includes(upstream.protocol)) throw new Error('Nieprawidłowy URL InvenTree.');
  return {
    nodeEnv: e.NODE_ENV, appOrigin: e.APP_ORIGIN, databaseUrl: e.APP_DATABASE_URL,
    sessionSecret: e.SESSION_SECRET, cookieSecure,
    sessionIdleMinutes: e.SESSION_IDLE_MINUTES, sessionMaxHours: e.SESSION_MAX_HOURS,
    host: e.API_HOST, port: e.API_PORT, trustProxy: e.TRUST_PROXY || false,
    inventreeUrl: e.INVENTREE_URL, inventreeToken: e.INVENTREE_TOKEN,
    inventreeTimeoutMs: e.INVENTREE_TIMEOUT_MS,
    inventreeExpectedVersion: e.INVENTREE_EXPECTED_VERSION,
    inventreeExpectedApiVersion: e.INVENTREE_EXPECTED_API_VERSION,
  };
}
export type Config = ReturnType<typeof loadConfig>;
