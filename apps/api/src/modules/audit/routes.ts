import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { audit } from '../../db/index.js';
import { ApiError } from '../../errors.js';
import { requireAuth, requireRole } from '../auth/routes.js';

const range = { from:z.iso.datetime().optional(),to:z.iso.datetime().optional(),cursor:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(100).default(30) };
const historyQuery = z.object(range).strict();
const adminQuery = z.object({...range,actor:z.uuid().optional(),operationId:z.uuid().optional()}).strict();
interface AuditRow {id:string;operation_id:string|null;actor_id:string|null;action:string;outcome:string;created_at:Date;details:Record<string,unknown>;resource_refs:Record<string,unknown>}
const dto=(r:AuditRow)=>({id:r.id,operationId:r.operation_id,action:r.action,outcome:r.outcome,createdAt:r.created_at.toISOString(),details:{...r.resource_refs,...r.details}});
function validateRange(from?:string,to?:string,maxDays=90){
  const end=to?Date.parse(to):Date.now();
  const start=from?Date.parse(from):end-maxDays*86400000;
  if(start>end||end-start>maxDays*86400000)throw new ApiError(400,'DATE_RANGE','Zakres dat jest nieprawidłowy lub zbyt szeroki.');
  return [new Date(start).toISOString(),new Date(end).toISOString()];
}
function csv(value:unknown):string {
  let text=value===null||value===undefined?'':String(value);
  if(/^[=+@\-\t\r\n]/.test(text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}

export async function registerAudit(app:FastifyInstance,ctx:AppContext){
  app.get('/api/my-history',async request=>{
    const actor=requireAuth(request);const q=historyQuery.parse(request.query);
    const [from,to]=validateRange(q.from,q.to);
    const result=await ctx.db.query<AuditRow>(`SELECT * FROM application_audit_events WHERE actor_id=$1
      AND created_at BETWEEN $2 AND $3 AND action NOT LIKE 'auth.%' AND action NOT LIKE 'access.%'
      AND ($4::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM application_audit_events WHERE id=$4 AND actor_id=$1))
      ORDER BY created_at DESC,id DESC LIMIT $5`,[actor.id,from,to,q.cursor??null,q.limit+1]);
    return {items:result.rows.slice(0,q.limit).map(dto),nextCursor:result.rows.length>q.limit?result.rows[q.limit-1]!.id:null};
  });
  app.get('/api/admin/audit',async request=>{
    const actor=requireRole(request,['warehouse_manager','admin']);const q=adminQuery.parse(request.query);
    const [from,to]=validateRange(q.from,q.to);
    const result=await ctx.db.query<AuditRow>(`SELECT * FROM application_audit_events WHERE created_at BETWEEN $1 AND $2
      AND ($3::uuid IS NULL OR actor_id=$3) AND ($4::uuid IS NULL OR operation_id=$4)
      AND ($5::boolean OR (action NOT LIKE 'auth.%' AND action NOT LIKE 'user.%' AND action NOT LIKE 'users.%' AND action NOT LIKE 'access.%'))
      AND ($6::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM application_audit_events WHERE id=$6))
      ORDER BY created_at DESC,id DESC LIMIT $7`,[from,to,q.actor??null,q.operationId??null,actor.role==='admin',q.cursor??null,q.limit+1]);
    await audit(ctx.db,{actorId:actor.id,action:'audit.viewed',outcome:'success',details:{from,to}});
    return {items:result.rows.slice(0,q.limit).map(dto),nextCursor:result.rows.length>q.limit?result.rows[q.limit-1]!.id:null};
  });
  app.get('/api/admin/exports',{config:{rateLimit:{max:5,timeWindow:'1 hour'}}},async(request,reply)=>{
    const actor=requireRole(request,['warehouse_manager','admin']);
    const q=z.object({kind:z.enum(['stock','operations','problems']),warehouseId:z.coerce.number().int().positive().optional(),from:z.iso.datetime().optional(),to:z.iso.datetime().optional()}).strict().parse(request.query);
    const [from,to]=validateRange(q.from,q.to,366);
    if(q.warehouseId){
      const known=await ctx.db.query('SELECT 1 FROM warehouse_mappings WHERE location_id=$1 AND enabled=true',[q.warehouseId]);
      if(!known.rowCount)throw new ApiError(404,'NOT_FOUND','Nie znaleziono magazynu.');
    }
    let lines:unknown[][]=[];
    if(q.kind==='stock'){
      const mappings=await ctx.db.query<{location_id:number;code:string}>('SELECT location_id,code FROM warehouse_mappings WHERE enabled=true AND ($1::integer IS NULL OR location_id=$1) ORDER BY location_id',[q.warehouseId??null]);
      if(q.warehouseId&&!mappings.rows.length)throw new ApiError(404,'NOT_FOUND','Nie znaleziono magazynu.');
      lines.push(['magazyn','stock_item_id','produkt','ilość','jednostka','LOT','EXP']);
      for(const w of mappings.rows){
        for(const stock of await ctx.inventory.stockAtLocation(w.location_id)){
          const part=await ctx.inventory.getPart(stock.part);
          lines.push([w.code,stock.pk,part.name,stock.quantity,part.units,stock.batch,stock.expiry_date]);
          if(lines.length>10001)throw new ApiError(400,'EXPORT_LIMIT','Eksport przekracza limit 10000 wierszy.');
        }
      }
    }else if(q.kind==='operations'){
      const rows=await ctx.db.query<AuditRow>(`SELECT e.* FROM application_audit_events e
        LEFT JOIN idempotency_records o ON o.id=e.operation_id
        WHERE e.created_at BETWEEN $1 AND $2
        AND ($3::integer IS NULL OR e.resource_refs->>'locationId'=$3::text
          OR o.request#>>'{_snapshot,locationId}'=$3::text
          OR o.request#>>'{_snapshot,destinationId}'=$3::text)
        AND e.action NOT LIKE 'auth.%' AND e.action NOT LIKE 'user.%' AND e.action NOT LIKE 'users.%' AND e.action NOT LIKE 'access.%'
        ORDER BY e.created_at,e.id LIMIT 10001`,[from,to,q.warehouseId??null]);
      if(rows.rows.length>10000)throw new ApiError(400,'EXPORT_LIMIT','Eksport przekracza limit 10000 wierszy.');
      lines=[['id','operacja','aktor','data','akcja','wynik'],...rows.rows.map(r=>[r.id,r.operation_id,r.actor_id,r.created_at.toISOString(),r.action,r.outcome])];
    }else{
      const rows=await ctx.db.query<{id:string;location_id:number;category:string;description:string;status:string;created_at:Date}>(`SELECT * FROM problem_reports WHERE created_at BETWEEN $1 AND $2 AND ($3::integer IS NULL OR location_id=$3) ORDER BY created_at,id LIMIT 10001`,[from,to,q.warehouseId??null]);
      if(rows.rows.length>10000)throw new ApiError(400,'EXPORT_LIMIT','Eksport przekracza limit 10000 wierszy.');
      lines=[['id','magazyn','kategoria','opis','status','data'],...rows.rows.map(r=>[r.id,r.location_id,r.category,r.description,r.status,r.created_at.toISOString()])];
    }
    await audit(ctx.db,{actorId:actor.id,action:'export.created',outcome:'success',details:{kind:q.kind,from,to,rows:lines.length-1}});
    return reply.header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition',`attachment; filename="medam-${q.kind}.csv"`).send('\uFEFF'+lines.map(row=>row.map(csv).join(';')).join('\r\n'));
  });
}
