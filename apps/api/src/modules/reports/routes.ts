import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ProblemReportSchema, UuidSchema } from '@medam/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../errors.js';
import { audit, withTransaction } from '../../db/index.js';
import { requireAuth, requireRole } from '../auth/routes.js';
import { ownedStock } from '../inventory/service.js';

const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(30), cursor: z.uuid().optional(), status: z.enum(['open','in_progress','resolved']).optional() }).strict();
interface ProblemRow { id:string; reporter_id:string; location_id:number; stock_item_id:number|null; category:string; description:string; status:string; created_at:Date }
const dto = (r:ProblemRow) => ({ id:r.id, category:r.category, description:r.description, status:r.status, stockItemId:r.stock_item_id, createdAt:r.created_at.toISOString() });

export async function registerReports(app:FastifyInstance, ctx:AppContext) {
  app.post('/api/problem-reports', async (request, reply) => {
    const actor = requireRole(request, ['medic']);
    z.object({}).strict().parse(request.query);
    if (!actor.warehouse) throw new ApiError(403,'WAREHOUSE_ASSIGNMENT_REQUIRED','Brak przypisania magazynu.');
    const input = ProblemReportSchema.parse(request.body);
    const key = UuidSchema.parse(request.headers['idempotency-key']);
    const fingerprint = createHash('sha256').update(JSON.stringify({ category:input.category, stockItemId:input.stockItemId??null, description:input.description })).digest('hex');
    const previous = await ctx.db.query<ProblemRow & {request_hash:string}>('SELECT * FROM problem_reports WHERE reporter_id=$1 AND idempotency_key=$2',[actor.id,key]);
    if (previous.rows[0]) {
      if (previous.rows[0].request_hash !== fingerprint) throw new ApiError(409,'IDEMPOTENCY_CONFLICT','Ten identyfikator ma już inne dane zgłoszenia.');
      return reply.code(201).send(dto(previous.rows[0]));
    }
    if (input.stockItemId !== undefined) {
      const stock = await ownedStock(ctx,actor,input.stockItemId);
      if (stock.location !== actor.warehouse.id) throw new ApiError(404,'NOT_FOUND','Nie znaleziono zasobu.');
    }
    const report = await withTransaction(ctx.db, async client => {
      const inserted = await client.query<ProblemRow>(`INSERT INTO problem_reports
        (id,reporter_id,location_id,stock_item_id,category,description,idempotency_key,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(reporter_id,idempotency_key) DO NOTHING RETURNING *`,
      [randomUUID(),actor.id,actor.warehouse!.id,input.stockItemId??null,input.category,input.description,key,fingerprint]);
      if (!inserted.rows[0]) {
        const existing = await client.query<ProblemRow & {request_hash:string}>('SELECT * FROM problem_reports WHERE reporter_id=$1 AND idempotency_key=$2',[actor.id,key]);
        if (!existing.rows[0] || existing.rows[0].request_hash !== fingerprint) throw new ApiError(409,'IDEMPOTENCY_CONFLICT','Niezgodne ponowienie zgłoszenia.');
        return existing.rows[0];
      }
      await audit(client,{actorId:actor.id,action:'problem.created',outcome:'success',resourceRefs:{reportId:inserted.rows[0].id,locationId:actor.warehouse!.id}});
      return inserted.rows[0];
    });
    return reply.code(201).send(dto(report));
  });
  app.get('/api/problem-reports', async request => {
    const actor = requireAuth(request);
    const q = listSchema.parse(request.query);
    const rows = await ctx.db.query<ProblemRow>(`SELECT p.* FROM problem_reports p
      WHERE ($1::uuid IS NULL OR p.reporter_id=$1) AND ($2::text IS NULL OR p.status=$2)
      AND ($3::uuid IS NULL OR (p.created_at,p.id)<(SELECT created_at,id FROM problem_reports WHERE id=$3 AND ($1::uuid IS NULL OR reporter_id=$1)))
      ORDER BY p.created_at DESC,p.id DESC LIMIT $4`,[actor.role==='medic'?actor.id:null,q.status??null,q.cursor??null,q.limit+1]);
    return {items:rows.rows.slice(0,q.limit).map(dto),nextCursor:rows.rows.length>q.limit?rows.rows[q.limit-1]!.id:null};
  });
  app.patch('/api/admin/problem-reports/:id', async request => {
    const actor = requireRole(request,['warehouse_manager','admin']);
    const id = UuidSchema.parse((request.params as {id:string}).id);
    const body = z.object({status:z.enum(['open','in_progress','resolved'])}).strict().parse(request.body);
    return withTransaction(ctx.db,async client=>{
      const result=await client.query<ProblemRow>('UPDATE problem_reports SET status=$2,updated_at=now() WHERE id=$1 RETURNING *',[id,body.status]);
      if(!result.rows[0])throw new ApiError(404,'NOT_FOUND','Nie znaleziono zgłoszenia.');
      await audit(client,{actorId:actor.id,action:'problem.updated',outcome:'success',resourceRefs:{reportId:id},details:{status:body.status}});
      return dto(result.rows[0]);
    });
  });
}
