import { z } from 'zod';
import { PolicySchema } from '@medam/shared';
import { Decimal } from 'decimal.js';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../errors.js';
import { audit, withTransaction } from '../../db/index.js';
import { requireRole } from '../auth/routes.js';
import { requireCurrentSession } from '../auth/service.js';
import { getStockDto, listStockDto, policyFor, warehouseExists } from './service.js';

const idParams = z.object({ id: z.coerce.number().int().positive() }).strict();
const querySchema = z.object({ q: z.string().trim().max(80).default(''), filter: z.enum(['all', 'low', 'expiring', 'blocked']).default('all'), cursor: z.string().regex(/^\d{1,5}$/).optional(), limit: z.coerce.number().int().min(1).max(50).default(50) }).strict();
export async function registerInventory(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const list = async (locationId: number, rawQuery: unknown) => {
    const query = querySchema.parse(rawQuery);
    const all = await listStockDto(ctx, locationId);
    const matching = all.filter(item => (!query.q || `${item.name} ${item.lot}`.toLocaleLowerCase('pl').includes(query.q.toLocaleLowerCase('pl')))
      && (query.filter === 'all' || (query.filter === 'low' && item.warnings.includes('LOW_STOCK')) || (query.filter === 'expiring' && item.warnings.some(warning => ['EXPIRING', 'EXPIRING_SOON', 'EXPIRED'].includes(warning))) || (query.filter === 'blocked' && !item.eligibleForConsumption)));
    const offset = Number(query.cursor ?? 0);
    return { items: matching.slice(offset, offset + query.limit), nextCursor: offset + query.limit < matching.length ? String(offset + query.limit) : null };
  };
  app.get('/api/my-stock', async request => {
    const actor = requireRole(request, ['medic']);
    if (!actor.warehouse) throw new ApiError(403, 'WAREHOUSE_ASSIGNMENT_REQUIRED', 'Brak przypisania magazynu.');
    return list(actor.warehouse.id, request.query);
  });
  app.get('/api/my-stock/:id', async request => {
    const actor = requireRole(request, ['medic']);
    z.object({}).strict().parse(request.query);
    return getStockDto(ctx, actor, idParams.parse(request.params).id);
  });
  app.get('/api/admin/warehouses', async request => {
    requireRole(request, ['warehouse_manager', 'admin']); z.object({}).strict().parse(request.query);
    const result = await ctx.db.query<{ location_id: number; code: string; name: string }>('SELECT location_id,code,name FROM warehouse_mappings WHERE enabled=true ORDER BY code');
    return { items: result.rows.map(row => ({ id: row.location_id, code: row.code, name: row.name })) };
  });
  app.get('/api/admin/warehouses/:id/stock', async request => {
    requireRole(request, ['warehouse_manager', 'admin']);
    return list(idParams.parse(request.params).id, request.query);
  });
  const policyParams=z.object({id:z.coerce.number().int().positive(),partId:z.coerce.number().int().positive()}).strict();
  app.get('/api/admin/warehouses/:id/policies/:partId',async request=>{
    requireRole(request,['warehouse_manager','admin']);
    z.object({}).strict().parse(request.query);
    const params=policyParams.parse(request.params);
    await warehouseExists(ctx,params.id);
    await ctx.inventory.getPart(params.partId);
    const policy=await policyFor(ctx,params.id,params.partId);
    return {warehouseId:params.id,partId:params.partId,minimum:new Decimal(policy.minimum).toFixed(),quantum:new Decimal(policy.quantum).toFixed()};
  });
  app.put('/api/admin/warehouses/:id/policies/:partId',async request=>{
    const actor=requireRole(request,['warehouse_manager','admin']);
    z.object({}).strict().parse(request.query);
    const params=policyParams.parse(request.params), input=PolicySchema.parse(request.body);
    await warehouseExists(ctx,params.id);
    const part=await ctx.inventory.getPart(params.partId);
    if(part.pk!==params.partId||!part.active||!part.units.trim()) throw new ApiError(409,'PART_NOT_ELIGIBLE','Produkt nie jest dopuszczony do konfiguracji.');
    const minimum=new Decimal(input.minimum).toFixed(),quantum=new Decimal(input.quantum).toFixed();
    await withTransaction(ctx.db,async client=>{
      const gate=await client.query<{operation_id:string|null}>('SELECT operation_id FROM inventory_mutation_gate WHERE id=$1 FOR UPDATE',['inventory']);
      if(!gate.rows[0]) throw new ApiError(503,'GATE_UNAVAILABLE','Zapisy są niedostępne.');
      await requireCurrentSession(client,ctx.config,request.sessionTokenHash,actor.id,['warehouse_manager','admin']);
      if(gate.rows[0].operation_id) throw new ApiError(423,'INVENTORY_LOCKED','Zakończ lub uzgodnij aktywną operację przed zmianą reguł ilościowych.');
      const previous=await client.query<{minimum:string;quantum:string}>('SELECT minimum::text,quantum::text FROM warehouse_product_policies WHERE location_id=$1 AND part_id=$2',[params.id,params.partId]);
      await client.query('INSERT INTO warehouse_product_policies(location_id,part_id,minimum,quantum) VALUES($1,$2,$3,$4) ON CONFLICT(location_id,part_id) DO UPDATE SET minimum=EXCLUDED.minimum,quantum=EXCLUDED.quantum',[params.id,params.partId,minimum,quantum]);
      await audit(client,{actorId:actor.id,action:'inventory.policy_updated',outcome:'success',resourceRefs:{warehouseId:params.id,partId:params.partId},details:{previous:previous.rows[0]??{minimum:'0',quantum:'1'},minimum,quantum}});
    });
    return {warehouseId:params.id,partId:params.partId,minimum,quantum};
  });
  app.get('/api/admin/parts', async request => {
    requireRole(request, ['warehouse_manager', 'admin']);
    const query = z.object({ q: z.string().trim().max(80).default(''), cursor: z.string().regex(/^\d{1,5}$/).optional(), limit: z.coerce.number().int().positive().max(50).default(50) }).strict().parse(request.query);
    const offset = Number(query.cursor ?? 0);
    const page = await ctx.inventory.listParts(query.q, offset, query.limit);
    return { items: page.results.map(part => ({ id: part.pk, name: part.name, unit: part.units })), nextCursor: page.next ? String(offset + query.limit) : null };
  });
}
