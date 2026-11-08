import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AdjustmentSchema, ReceiptSchema, ReconcileSchema, TransferSchema, UuidSchema } from '@medam/shared';
import type { AppContext } from '../../context.js';
import { requireRecentAuth, requireRole } from '../auth/routes.js';
import { operationId } from '../consumption/routes.js';
import { executeMutation, publicOperation, reconcileOperation, type MutationInput, type OperationKind, type OperationRow } from '../consumption/operations.js';

export async function registerMovements(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const register=(path:string,kind:OperationKind,schema:z.ZodType<MutationInput>)=>{
    app.post(path,async(request,reply)=>{
      const actor=requireRole(request,['warehouse_manager','admin']);
      z.object({}).strict().parse(request.query);
      const executed=await executeMutation(ctx,actor,request.sessionTokenHash,kind,operationId(request.headers),schema.parse(request.body));
      return reply.code(executed.httpStatus).header('Location',`/api/operations/${executed.operation.id}`).send(executed.operation);
    });
  };
  register('/api/admin/warehouse-transfers','transfer',TransferSchema);
  register('/api/admin/receipts','receipt',ReceiptSchema);
  register('/api/admin/adjustments','adjustment',AdjustmentSchema);
  app.get('/api/admin/operations',async request=>{
    requireRole(request,['admin']);
    const query=z.object({state:z.enum(['review','all']).default('review'),cursor:z.string().regex(/^\d{1,5}$/).optional(),limit:z.coerce.number().int().positive().max(100).default(50)}).strict().parse(request.query);
    const offset=Number(query.cursor??0);
    const states=query.state==='review'?['PREPARED','DISPATCHING','UNCERTAIN','DISCREPANCY']:null;
    const rows=await ctx.db.query<OperationRow>(`SELECT * FROM idempotency_records WHERE ($1::text[] IS NULL OR state=ANY($1::text[])) ORDER BY created_at DESC,id LIMIT $2 OFFSET $3`,[states,query.limit+1,offset]);
    return {items:rows.rows.slice(0,query.limit).map(publicOperation),nextCursor:rows.rows.length>query.limit?String(offset+query.limit):null};
  });
  app.post('/api/admin/operations/:id/reconcile',async request=>{
    const actor=requireRole(request,['admin']);
    z.object({}).strict().parse(request.query);
    await requireRecentAuth(request,ctx);
    const id=z.object({id:UuidSchema}).strict().parse(request.params).id;
    const input=ReconcileSchema.parse(request.body);
    return reconcileOperation(ctx,actor,request.sessionTokenHash,id,input.resolution,input.evidenceIds,input.reason);
  });
}
