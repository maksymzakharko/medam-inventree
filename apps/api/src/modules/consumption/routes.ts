import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ConsumptionSchema, UuidSchema } from '@medam/shared';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../errors.js';
import { requireAuth, requireRole } from '../auth/routes.js';
import { executeMutation, getOperation, publicOperation } from './operations.js';

export function operationId(headers: Record<string, unknown>): string {
  const raw=headers['idempotency-key'];
  if(typeof raw!=='string') throw new ApiError(400,'IDEMPOTENCY_KEY_REQUIRED','Żądanie wymaga identyfikatora operacji.');
  return UuidSchema.parse(raw);
}
export async function registerConsumptions(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/consumptions',async(request,reply)=>{
    const actor=requireRole(request,['medic']);
    z.object({}).strict().parse(request.query);
    const input=ConsumptionSchema.parse(request.body);
    const executed=await executeMutation(ctx,actor,request.sessionTokenHash,'consumption',operationId(request.headers),input);
    return reply.code(executed.httpStatus).header('Location',`/api/operations/${executed.operation.id}`).send(executed.operation);
  });
  app.post('/api/admin/consumptions',async(request,reply)=>{
    const actor=requireRole(request,['warehouse_manager','admin']);
    z.object({}).strict().parse(request.query);
    const input=ConsumptionSchema.parse(request.body);
    const executed=await executeMutation(ctx,actor,request.sessionTokenHash,'consumption',operationId(request.headers),input);
    return reply.code(executed.httpStatus).header('Location',`/api/operations/${executed.operation.id}`).send(executed.operation);
  });
  app.get('/api/operations/:id',async request=>{
    const actor=requireAuth(request);
    z.object({}).strict().parse(request.query);
    const id=z.object({id:UuidSchema}).strict().parse(request.params).id;
    return publicOperation(await getOperation(ctx,actor,id));
  });
}
