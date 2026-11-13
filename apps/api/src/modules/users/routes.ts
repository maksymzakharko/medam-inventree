import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateUserSchema, UpdateUserSchema, UuidSchema } from '@medam/shared';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../errors.js';
import { audit } from '../../db/index.js';
import { requireRole, requireRecentAuth } from '../auth/routes.js';
import { limitAuth, userWithWarehouseSql, type UserRow } from '../auth/service.js';
import { createUser, updateUser, userDto } from './service.js';

const IdParams = z.object({id: UuidSchema}).strict();
export async function registerUsers(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/admin/users', async request => {
    requireRole(request, ['admin']);
    z.object({}).strict().parse(request.query);
    const users = await ctx.db.query<UserRow>(`${userWithWarehouseSql} ORDER BY u.login LIMIT 200`);
    return {items: users.rows.map(userDto)};
  });
  app.post('/api/admin/users', async (request, reply) => {
    const actor = requireRole(request, ['admin']);
    await requireRecentAuth(request, ctx);
    const user = await createUser(ctx.db, actor.id, CreateUserSchema.parse(request.body));
    return reply.code(201).send({...user, bootstrapRequired: true});
  });
  app.patch('/api/admin/users/:id', async request => {
    const actor = requireRole(request, ['admin']);
    await requireRecentAuth(request, ctx);
    const {id} = IdParams.parse(request.params);
    return updateUser(ctx.db, actor.id, id, UpdateUserSchema.parse(request.body));
  });
  app.post('/api/admin/users/:id/password-reset', async (request, reply) => {
    const actor = requireRole(request, ['admin']);
    await requireRecentAuth(request, ctx);
    const {id} = IdParams.parse(request.params);
    z.object({}).strict().parse(request.body);
    await limitAuth(ctx.db, ctx.config, 'admin-reset-user', id, 3, 3600);
    const target = await ctx.db.query('SELECT id FROM users WHERE id=$1 AND active=true', [id]);
    if (!target.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Nie znaleziono aktywnego konta.');
    // There is intentionally no SMTP credential or delivery path in this MVP.
    // A supervised reset is completed by the administrator's CLI, not by returning tokens over this endpoint.
    await audit(ctx.db, {actorId: actor.id, action: 'users.password_reset_requested', outcome: 'accepted', resourceRefs: {userId: id}});
    return reply.code(202).send({resetRequested: true, resetInitiated: false,
      message: 'Zlecenie zapisano. Uprawniony administrator musi zweryfikować pracownika i wygenerować jednorazowy link poleceniem CLI.'});
  });
}
