import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { ApiError } from './errors.js';
import { audit } from './db/index.js';
import { InventreeClient } from './integrations/inventree/client.js';
import { registerAuth } from './modules/auth/routes.js';
import { registerUsers } from './modules/users/routes.js';
import { registerInventory } from './modules/inventory/routes.js';
import { registerConsumptions } from './modules/consumption/routes.js';
import { registerMovements } from './modules/movements/routes.js';
import { registerReports } from './modules/reports/routes.js';
import { registerAudit } from './modules/audit/routes.js';

export interface BuildAppOptions { config: Config; db: Pool; inventory?: InventreeClient; logger?: boolean }

export async function buildApp(options: BuildAppOptions) {
  const { config, db } = options;
  const inventory = options.inventory ?? new InventreeClient({
    baseUrl: config.inventreeUrl, token: config.inventreeToken, timeoutMs: config.inventreeTimeoutMs,
    expectedVersion: config.inventreeExpectedVersion, expectedApiVersion: config.inventreeExpectedApiVersion,
  });
  const ctx: AppContext = { config, db, inventory };
  const app = Fastify({
    logger: options.logger === false ? false : {
      level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.token', '*.csrfToken'],
    },
    bodyLimit: 16 * 1024, trustProxy: config.trustProxy, requestIdHeader: false,
    connectionTimeout: 10000, requestTimeout: 30000,
    disableRequestLogging: true,
  });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(helmet, { global: true });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler(async (error, request, reply) => {
    const err = error as Error & { code?: string; statusCode?: number };
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Nie udało się obsłużyć żądania. Spróbuj sprawdzić stan operacji.';
    if (error instanceof ApiError) {
      status = error.statusCode; code = error.code; message = error.message;
    } else if (error instanceof ZodError || err.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || err.code === 'FST_ERR_VALIDATION') {
      status = 400; code = 'VALIDATION_ERROR'; message = 'Sprawdź wymagane pola i ich format.';
    } else if (err.code?.startsWith('FST_CSRF_')) {
      status = 403; code = 'CSRF_INVALID'; message = 'Sesja formularza wygasła. Odśwież aplikację.';
    } else if (err.statusCode === 429) {
      status = 429; code = 'RATE_LIMIT'; message = 'Zbyt wiele żądań. Spróbuj ponownie za chwilę.';
    } else if ([400, 413, 415].includes(err.statusCode ?? 0)) {
      status = err.statusCode!; code = 'INVALID_REQUEST'; message = 'Nieprawidłowe żądanie.';
    }
    if (status >= 500) request.log.error({ code, requestId: request.id }, 'Nieudane żądanie API');
    if (status === 403 || status === 404) {
      await audit(db, { actorId: request.actor?.id ?? null, action: 'access.denied', outcome: 'denied',
        details: { code, method: request.method, route: request.routeOptions.url ?? 'unknown' } }).catch(() => undefined);
    }
    return reply.code(status).send({ error: { code, message, requestId: request.id } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Nie znaleziono zasobu.' } }));

  await registerAuth(app, ctx);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute', hook: 'preHandler', keyGenerator: request => request.actor?.id ?? request.ip });
  await registerUsers(app, ctx);
  await registerInventory(app, ctx);
  await registerConsumptions(app, ctx);
  await registerMovements(app, ctx);
  await registerReports(app, ctx);
  await registerAudit(app, ctx);

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      await inventory.checkVersion();
      const gate = await db.query<{ operation_id: string | null }>("SELECT operation_id FROM inventory_mutation_gate WHERE id='inventory'");
      if (!gate.rows.length) throw new Error('Missing gate');
      return { status: 'ok', writesReady: gate.rows[0]!.operation_id === null };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  return app;
}
