import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { Actor, OperationState } from '@medam/shared';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../errors.js';
import { audit, withTransaction } from '../../db/index.js';
import type { AuditEntry, StockItem } from '../../integrations/inventree/client.js';
import { assertQuantum, decimal, eligibilityProblems, ownedStock, physicalProblems, policyFor, todayWarsaw, warehouseExists } from '../inventory/service.js';
import { requireCurrentSession } from '../auth/service.js';

export type OperationKind = 'consumption' | 'transfer' | 'receipt' | 'adjustment';
export interface MutationInput { stockItemId?: number; partId?: number; warehouseId?: number; destinationWarehouseId?: number; quantity: string; lot?: string; exp?: string; direction?: 'increase' | 'decrease'; reason?: string }
interface Snapshot { id: number; partId: number; locationId: number; quantity: string; lot: string; exp: string | null; name: string; destinationId?: number }
export interface OperationRow extends QueryResultRow {
  id: string; actor_id: string; kind: OperationKind; key: string; request_hash: string;
  state: OperationState; request: MutationInput & { _snapshot?: Snapshot };
  response: Record<string, unknown> | null; upstream_refs: number[]; created_at: Date; updated_at: Date;
}
export interface PublicOperation {
  id: string; kind: OperationKind; state: OperationState; requestedQuantity: string;
  appliedQuantity?: string; stockItemId?: number; name?: string;
  createdAt: string; updatedAt: string; error?: { code: string; message: string };
}
interface Execution { operation: PublicOperation; httpStatus: number }
const unresolved = new Set<OperationState>(['PREPARED', 'DISPATCHING', 'UNCERTAIN', 'DISCREPANCY']);

function canonical(input: MutationInput): MutationInput {
  return Object.fromEntries(Object.entries({ ...input, quantity: new Decimal(input.quantity).toFixed() }).sort(([a], [b]) => a.localeCompare(b))) as unknown as MutationInput;
}
function requestHash(kind: string, input: MutationInput): string {
  return createHash('sha256').update(JSON.stringify({ kind, ...canonical(input) })).digest('hex');
}
export function publicOperation(row: OperationRow): PublicOperation {
  const applied = row.response?.appliedQuantity;
  const error = row.response?.error;
  return { id: row.id, kind: row.kind, state: row.state, requestedQuantity: row.request.quantity,
    ...(typeof applied === 'string' ? { appliedQuantity: applied } : {}),
    ...(row.request.stockItemId === undefined ? {} : { stockItemId: row.request.stockItemId }),
    ...(row.request._snapshot?.name ? { name: row.request._snapshot.name } : {}),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    ...(error && typeof error === 'object' ? { error: error as {code: string;message: string} } : {}) };
}
function result(row: OperationRow): Execution {
  return { operation: publicOperation(row), httpStatus: row.state === 'REJECTED'
    ? typeof row.response?.httpStatus === 'number' ? row.response.httpStatus : 409
    : unresolved.has(row.state) ? 202 : 201 };
}
export async function getOperation(ctx: AppContext, actor: Actor, id: string): Promise<OperationRow> {
  const record = await ctx.db.query<OperationRow>('SELECT * FROM idempotency_records WHERE id=$1', [id]);
  const row = record.rows[0];
  if (!row || (actor.role !== 'admin' && row.actor_id !== actor.id)) throw new ApiError(404, 'NOT_FOUND', 'Nie znaleziono operacji.');
  return row;
}
async function reserve(ctx: AppContext, actor: Actor, sessionTokenHash: string | null, kind: OperationKind, id: string, input: MutationInput): Promise<{row: OperationRow;fresh: false} | {row: OperationRow;fresh: true;actor: Actor}> {
  const hash = requestHash(kind, input);
  const assertReplay = (row: OperationRow): void => {
    if (row.actor_id !== actor.id) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Identyfikator operacji jest niedostępny.');
    if (row.request_hash !== hash || row.kind !== kind) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Ten identyfikator został użyty z innymi danymi.');
  };
  // Replay is resolved before upstream reads and before the global gate check.
  const old = await ctx.db.query<OperationRow>('SELECT * FROM idempotency_records WHERE id=$1', [id]);
  if (old.rows[0]) { assertReplay(old.rows[0]); return { row: old.rows[0], fresh: false }; }
  return withTransaction(ctx.db, async client => {
    const gate = await client.query<{operation_id:string|null}>('SELECT operation_id FROM inventory_mutation_gate WHERE id=$1 FOR UPDATE', ['inventory']);
    if (!gate.rows[0]) throw new ApiError(503, 'GATE_UNAVAILABLE', 'Zapisy magazynowe są niedostępne.');
    const existing = await client.query<OperationRow>('SELECT * FROM idempotency_records WHERE id=$1', [id]);
    if (existing.rows[0]) { assertReplay(existing.rows[0]); return {row: existing.rows[0], fresh:false}; }
    const currentActor = await requireCurrentSession(client, ctx.config, sessionTokenHash, actor.id,
      kind === 'consumption' && actor.role === 'medic' ? ['medic'] : ['warehouse_manager', 'admin']);
    if (gate.rows[0].operation_id) throw new ApiError(423, 'INVENTORY_LOCKED', 'Inna operacja wymaga zakończenia lub uzgodnienia. Nie twórz nowego identyfikatora dla ponowienia.');
    const saved = await client.query<OperationRow>(`INSERT INTO idempotency_records(id,actor_id,kind,key,request_hash,state,request)
      VALUES($1,$2,$3,$1,$4,'PREPARED',$5::jsonb) RETURNING *`, [id, actor.id, kind, hash, JSON.stringify(canonical(input))]);
    await client.query('UPDATE inventory_mutation_gate SET operation_id=$1,updated_at=now() WHERE id=$2', [id, 'inventory']);
    await audit(client, {actorId:actor.id,operationId:id,action:`inventory.${kind}`,outcome:'PREPARED',details:{quantity:input.quantity},resourceRefs:{stockItemId:input.stockItemId??null}});
    return { row: saved.rows[0]!, fresh: true, actor: currentActor };
  });
}
async function preconditions(ctx: AppContext, actor: Actor, kind: OperationKind, input: MutationInput): Promise<Snapshot> {
  if (kind === 'receipt') {
    const location = input.warehouseId!; await warehouseExists(ctx, location);
    const [part, target, policy] = await Promise.all([ctx.inventory.getPart(input.partId!),ctx.inventory.getLocation(location),policyFor(ctx,location,input.partId!)]);
    if (part.pk !== input.partId || target.pk !== location || target.structural || target.external || !part.active || !part.units.trim()) throw new ApiError(409,'RECEIPT_NOT_ALLOWED','Produkt lub magazyn nie jest dopuszczony do przyjęcia.');
    if (!input.exp || input.exp < todayWarsaw()) throw new ApiError(409,'EXPIRED_BATCH','Nie można przyjąć przeterminowanej partii jako dopuszczonej do użycia.');
    assertQuantum(input.quantity,policy);
    return { id:0,partId:part.pk,locationId:location,quantity:'0',lot:input.lot!,exp:input.exp,name:part.name };
  }
  const stock = await ownedStock(ctx,actor,input.stockItemId!);
  const [part, policy] = await Promise.all([ctx.inventory.getPart(stock.part),policyFor(ctx,stock.location!,stock.part)]);
  if (part.pk !== stock.part) throw new ApiError(502,'UPSTREAM_SCOPE','Nieprawidłowa odpowiedź produktu.');
  assertQuantum(input.quantity,policy);
  const increasing = kind === 'adjustment' && input.direction === 'increase';
  const reasons = kind === 'consumption' || increasing ? eligibilityProblems(stock,part,increasing) : physicalProblems(stock);
  if (reasons.length) throw new ApiError(409,'BATCH_NOT_ELIGIBLE','Ta partia nie jest dostępna dla wybranej operacji.');
  if (!increasing && new Decimal(input.quantity).gt(decimal(stock.quantity))) throw new ApiError(409,'INSUFFICIENT_STOCK','Żądana ilość przekracza dostępny stan.');
  if (increasing && decimal(stock.quantity).plus(input.quantity).gt('9999999999.99999')) throw new ApiError(400,'QUANTITY_LIMIT','Przekroczono maksymalną ilość.');
  const snapshot: Snapshot = {id:stock.pk,partId:stock.part,locationId:stock.location!,quantity:stock.quantity,lot:stock.batch??'',exp:stock.expiry_date,name:part.name};
  if (kind === 'transfer') {
    const destination = input.destinationWarehouseId!;
    if (destination === stock.location) throw new ApiError(400,'SAME_WAREHOUSE','Wybierz inny magazyn docelowy.');
    await warehouseExists(ctx,destination);
    const target = await ctx.inventory.getLocation(destination);
    if (target.pk !== destination || target.external || target.structural) throw new ApiError(409,'TRANSFER_NOT_ALLOWED','Magazyn docelowy nie może przyjąć zapasu.');
    snapshot.destinationId = destination;
  }
  return snapshot;
}
function referencePk(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (value && typeof value === 'object' && 'pk' in value) { const pk = Number(value.pk); return Number.isSafeInteger(pk) && pk>0 ? pk:null; }
  return null;
}
function evidenceAmount(value: unknown): Decimal | null {
  if ((typeof value!=='number'&&typeof value!=='string') || String(value).length>40) return null;
  try { const amount=new Decimal(value); return amount.isFinite()&&amount.gte(0)&&amount.decimalPlaces()<=5 ? amount:null; } catch {return null;}
}
function sameBatch(stock: StockItem, snap: Snapshot): boolean { return stock.part===snap.partId && (stock.batch??'')===snap.lot && stock.expiry_date===snap.exp; }
export interface Verification { state:'SUCCEEDED'|'DISCREPANCY'|'UNCERTAIN'; appliedQuantity?:string; evidenceIds:number[]; stockIds?:number[] }
export async function verifyEvidence(ctx: AppContext, row: OperationRow, entries: AuditEntry[]): Promise<Verification> {
  const snapshot=row.request._snapshot;
  if(!snapshot) return {state:'UNCERTAIN',evidenceIds:[]};
  const actorId=await ctx.inventory.getCurrentUserId();
  const correlated=entries.filter(entry=>entry.model_type==='stock.stockitem' && entry.actor===actorId
    && (entry.cid===row.id || (row.kind!=='receipt'&&entry.notes===`medam-op:${row.id}`))
    && Date.parse(entry.timestamp)>=new Date(row.created_at).getTime()-5000);
  const ids=correlated.map(entry=>entry.pk);
  if(new Set(ids).size!==ids.length) return {state:'DISCREPANCY',evidenceIds:ids};
  const quantity=new Decimal(row.request.quantity);
  if(row.kind==='consumption'||row.kind==='adjustment') {
    const increasing=row.kind==='adjustment'&&row.request.direction==='increase';
    const expected=increasing?11:12;
    const matches=correlated.filter(entry=>entry.event_type===expected&&entry.object_pk===String(snapshot.id));
    if(matches.length!==1||correlated.some(entry=>entry.event_type!==expected||entry.object_pk!==String(snapshot.id))) return {state:matches.length>1?'DISCREPANCY':'UNCERTAIN',evidenceIds:ids};
    const amount=evidenceAmount(matches[0]!.deltas?.[increasing?'added':'removed']);
    if(!amount) return {state:'UNCERTAIN',evidenceIds:ids};
    return {state:amount.eq(quantity)?'SUCCEEDED':'DISCREPANCY',appliedQuantity:amount.toFixed(),evidenceIds:ids,stockIds:[snapshot.id]};
  }
  if(row.kind==='receipt') {
    const created=correlated.filter(entry=>entry.event_type===1 && entry.cid===row.id);
    if(created.length!==1) return {state:created.length>1?'DISCREPANCY':'UNCERTAIN',evidenceIds:ids};
    const stockId=Number(created[0]!.object_pk);
    if(!Number.isSafeInteger(stockId)||stockId<=0) return {state:'UNCERTAIN',evidenceIds:ids};
    const current=await ctx.inventory.getStock(stockId);
    if(!sameBatch(current,snapshot)||current.location!==snapshot.locationId) return {state:'DISCREPANCY',evidenceIds:ids};
    const actual=decimal(current.quantity);
    return {state:actual.eq(quantity)?'SUCCEEDED':'DISCREPANCY',appliedQuantity:actual.toFixed(),evidenceIds:ids,stockIds:[stockId]};
  }
  // Full transfer is a single movement event; partial transfer emits parent42/child40.
  const full=correlated.filter(entry=>entry.event_type===20&&entry.object_pk===String(snapshot.id));
  if(full.length===1&&correlated.length===1) {
    const current=await ctx.inventory.getStock(snapshot.id);
    const recorded=evidenceAmount(full[0]!.deltas?.quantity);
    if(!sameBatch(current,snapshot)||current.location!==snapshot.destinationId||!recorded||!recorded.eq(quantity)||!decimal(current.quantity).eq(quantity)||!new Decimal(snapshot.quantity).eq(quantity)) return {state:'DISCREPANCY',evidenceIds:ids};
    return {state:'SUCCEEDED',appliedQuantity:quantity.toFixed(),evidenceIds:ids,stockIds:[snapshot.id]};
  }
  const parent=correlated.filter(entry=>entry.event_type===42&&entry.object_pk===String(snapshot.id));
  const child=correlated.filter(entry=>entry.event_type===40);
  if(parent.length!==1||child.length!==1||correlated.length!==2) return {state:correlated.length?'DISCREPANCY':'UNCERTAIN',evidenceIds:ids};
  const childId=Number(child[0]!.object_pk), amount=evidenceAmount(parent[0]!.deltas?.removed);
  if(!Number.isSafeInteger(childId)||childId<=0||!amount||referencePk(parent[0]!.deltas?.stockitem)!==childId||referencePk(child[0]!.deltas?.stockitem)!==snapshot.id) return {state:'UNCERTAIN',evidenceIds:ids};
  const [current,source]=await Promise.all([ctx.inventory.getStock(childId),ctx.inventory.getStock(snapshot.id)]);
  if(!sameBatch(current,snapshot)||current.parent!==snapshot.id||current.location!==snapshot.destinationId||source.location!==snapshot.locationId||!decimal(current.quantity).eq(amount)||!decimal(source.quantity).eq(new Decimal(snapshot.quantity).minus(amount))) return {state:'DISCREPANCY',evidenceIds:ids};
  return {state:amount.eq(quantity)?'SUCCEEDED':'DISCREPANCY',appliedQuantity:amount.toFixed(),evidenceIds:ids,stockIds:[snapshot.id,childId]};
}
async function finish(ctx: AppContext, row: OperationRow, state: OperationState, response: Record<string,unknown>, refs: number[], allowed: OperationState[]): Promise<OperationRow> {
  return withTransaction(ctx.db,async client=>{
    await client.query('SELECT operation_id FROM inventory_mutation_gate WHERE id=$1 FOR UPDATE',['inventory']);
    const updated=await client.query<OperationRow>(`UPDATE idempotency_records SET state=$2,response=$3::jsonb,upstream_refs=$4::jsonb,updated_at=now()
      WHERE id=$1 AND state=ANY($5::text[]) RETURNING *`,[row.id,state,JSON.stringify(response),JSON.stringify(refs),allowed]);
    const actual=updated.rows[0];
    if(!actual) { const current=await client.query<OperationRow>('SELECT * FROM idempotency_records WHERE id=$1',[row.id]);return current.rows[0]!; }
    await audit(client,{actorId:row.actor_id,operationId:row.id,action:`inventory.${row.kind}`,outcome:state,resourceRefs:{stockItemId:row.request.stockItemId??null},details:{quantity:row.request.quantity,name:row.request._snapshot?.name??null,...response,evidenceIds:refs}});
    if(!unresolved.has(state)) await client.query('UPDATE inventory_mutation_gate SET operation_id=NULL,updated_at=now() WHERE id=$1 AND operation_id=$2',['inventory',row.id]);
    return actual;
  });
}
export async function executeMutation(ctx: AppContext, actor: Actor, sessionTokenHash: string | null, kind: OperationKind, id: string, input: MutationInput): Promise<Execution> {
  const reserved=await reserve(ctx,actor,sessionTokenHash,kind,id,input);
  if(!reserved.fresh) return result(reserved.row);
  actor=reserved.actor;
  let row=reserved.row;
  let snapshot: Snapshot;
  try { snapshot=await preconditions(ctx,actor,kind,input); }
  catch(error) {
    const known=error instanceof ApiError?error:new ApiError(503,'VALIDATION_UNAVAILABLE','Nie można sprawdzić stanu partii.');
    row=await finish(ctx,row,'REJECTED',{error:{code:known.code,message:known.message},httpStatus:known.statusCode},[],['PREPARED']);
    return result(row);
  }
  // Snapshot is historical evidence of the validation, not a second editable stock state.
  const dispatch=await withTransaction(ctx.db,async client=>{
    const updated=await client.query<OperationRow>(`UPDATE idempotency_records SET state='DISPATCHING',request=$2::jsonb,updated_at=now()
      WHERE id=$1 AND state='PREPARED' RETURNING *`,[id,JSON.stringify({...canonical(input),_snapshot:snapshot})]);
    if(updated.rows[0]) await audit(client,{actorId:actor.id,operationId:id,action:`inventory.${kind}.dispatch`,outcome:'DISPATCHING'});
    return updated.rows[0];
  });
  if(!dispatch) return result(await getOperation(ctx,actor,id));
  row=dispatch;
  try {
    if(kind==='receipt') await ctx.inventory.createStock(row.id,{part:input.partId!,location:input.warehouseId!,quantity:input.quantity,batch:input.lot!,expiry_date:input.exp!});
    else await ctx.inventory.adjustStock(kind==='transfer'?'transfer':kind==='adjustment'&&input.direction==='increase'?'add':'remove',row.id,input.stockItemId!,input.quantity,input.destinationWarehouseId);
    const entries=await ctx.inventory.auditForOperation(row.id,input.stockItemId,new Date(row.created_at).toISOString());
    const verified=await verifyEvidence(ctx,row,entries);
    row=await finish(ctx,row,verified.state,{...(verified.appliedQuantity===undefined?{}:{appliedQuantity:verified.appliedQuantity}),stockIds:verified.stockIds??[]},verified.evidenceIds,['DISPATCHING']);
  } catch {
    // A timeout/HTTP failure can occur after commit upstream. No resend, no TTL unlock.
    row=await finish(ctx,row,'UNCERTAIN',{error:{code:'OPERATION_UNCERTAIN',message:'Wynik wymaga sprawdzenia. Nie powtarzaj operacji z nowym identyfikatorem.'}},[],['DISPATCHING']);
  }
  return result(row);
}
export async function reconcileOperation(ctx: AppContext, actor: Actor, sessionTokenHash: string | null, id: string, resolution:'applied'|'partial'|'not_applied', evidenceIds:number[], reason:string): Promise<PublicOperation> {
  const row=await getOperation(ctx,actor,id);
  if(!['DISPATCHING','UNCERTAIN','DISCREPANCY'].includes(row.state)) throw new ApiError(409,'OPERATION_STATE','Ta operacja nie wymaga uzgodnienia.');
  if(resolution==='not_applied') throw new ApiError(409,'MAINTENANCE_REQUIRED','Brak wpisu audytu nie dowodzi niewykonania. Potwierdzenie braku skutku wymaga trybu maintenance i narzędzia administratora.');
  if(evidenceIds.length===0) throw new ApiError(400,'EVIDENCE_REQUIRED','Podaj identyfikatory dowodów audytu InvenTree.');
  const entries=await Promise.all([...new Set(evidenceIds)].map(pk=>ctx.inventory.auditById(pk)));
  // Include all correlated events: operator cannot hide a duplicate mutation by selecting one ID.
  const discovered=await ctx.inventory.auditForOperation(row.id,row.request.stockItemId,new Date(row.created_at).toISOString());
  const combined=[...new Map([...entries,...discovered].map(entry=>[entry.pk,entry])).values()];
  const verified=await verifyEvidence(ctx,row,combined);
  if(resolution==='applied'&&verified.state!=='SUCCEEDED') throw new ApiError(409,'EVIDENCE_MISMATCH','Dowody nie potwierdzają pełnego wykonania operacji.');
  if(resolution==='partial'&&(verified.state!=='DISCREPANCY'||verified.appliedQuantity===undefined||!new Decimal(verified.appliedQuantity).gt(0)||!new Decimal(verified.appliedQuantity).lt(row.request.quantity))) throw new ApiError(409,'EVIDENCE_MISMATCH','Dowody nie potwierdzają częściowego wykonania.');
  const state=resolution==='applied'?'RECONCILED_APPLIED':'RECONCILED_PARTIAL';
  const updated=await withTransaction(ctx.db,async client=>{
    const gate=await client.query<{operation_id:string|null}>('SELECT operation_id FROM inventory_mutation_gate WHERE id=$1 FOR UPDATE',['inventory']);
    if(!gate.rows[0]) throw new ApiError(503,'GATE_UNAVAILABLE','Zapisy magazynowe są niedostępne.');
    if(gate.rows[0].operation_id!==row.id) throw new ApiError(409,'OPERATION_STATE','Brama nie należy do wskazanej operacji.');
    await requireCurrentSession(client,ctx.config,sessionTokenHash,actor.id,['admin'],true);
    const saved=await client.query<OperationRow>(`UPDATE idempotency_records SET state=$2,response=$3::jsonb,upstream_refs=$4::jsonb,updated_at=now()
      WHERE id=$1 AND state=$5 RETURNING *`,[id,state,JSON.stringify({appliedQuantity:verified.appliedQuantity,reason}),JSON.stringify(verified.evidenceIds),row.state]);
    if(!saved.rows[0]) throw new ApiError(409,'OPERATION_STATE','Stan operacji zmienił się podczas uzgadniania.');
    await audit(client,{actorId:actor.id,operationId:id,action:'inventory.reconcile',outcome:state,details:{reason,evidenceIds:verified.evidenceIds,appliedQuantity:verified.appliedQuantity}});
    await client.query('UPDATE inventory_mutation_gate SET operation_id=NULL,updated_at=now() WHERE id=$1 AND operation_id=$2',['inventory',id]);
    return saved.rows[0];
  });
  return publicOperation(updated);
}
/** Operator-only maintenance primitive. Caller must stop upstream writers before attestation. */
export async function resolveNotApplied(pool: Pool, id: string, actorId: string, reason: string): Promise<void> {
  if(reason.trim().length<10) throw new ApiError(400,'REASON_REQUIRED','Podaj pełne uzasadnienie uzgodnienia.');
  await withTransaction(pool,async client=>{
    await client.query('SELECT operation_id FROM inventory_mutation_gate WHERE id=$1 FOR UPDATE',['inventory']);
    const operator=await client.query('SELECT id FROM users WHERE id=$1 AND active=true AND role=$2',[actorId,'admin']);
    if(!operator.rowCount) throw new ApiError(403,'FORBIDDEN','Potwierdzenie wymaga aktywnego administratora.');
    const saved=await client.query<OperationRow>(`UPDATE idempotency_records SET state='RECONCILED_NOT_APPLIED',response=$2::jsonb,updated_at=now()
      WHERE id=$1 AND state IN ('PREPARED','DISPATCHING','UNCERTAIN') RETURNING *`,[id,JSON.stringify({reason,appliedQuantity:'0',maintenanceAttestation:true})]);
    if(!saved.rows[0]) throw new ApiError(409,'OPERATION_STATE','Nie można zamknąć tej operacji jako niewykonanej.');
    await audit(client,{actorId,operationId:id,action:'inventory.reconcile.maintenance',outcome:'RECONCILED_NOT_APPLIED',details:{reason,upstreamWritersStopped:true}});
    await client.query('UPDATE inventory_mutation_gate SET operation_id=NULL,updated_at=now() WHERE id=$1 AND operation_id=$2',['inventory',id]);
  });
}

/**
 * Last-resort operator attestation, only while all upstream writers and in-flight requests
 * are stopped. This does not claim automatic proof, does not retry and never compensates.
 */
export async function resolveObservedEffect(pool: Pool, id: string, actorId: string, actualQuantity: string, reason: string): Promise<void> {
  if (reason.trim().length < 10 || reason.length > 1000) throw new ApiError(400,'REASON_REQUIRED','Podaj pełne uzasadnienie uzgodnienia.');
  if (!/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,5})?$/.test(actualQuantity)) throw new ApiError(400,'QUANTITY_INVALID','Podaj nieujemną ilość faktycznego efektu z maksymalnie pięcioma miejscami po przecinku.');
  const observed = new Decimal(actualQuantity);
  if (!observed.isFinite() || observed.lt(0) || observed.gt('9999999999.99999')) throw new ApiError(400,'QUANTITY_INVALID','Nieprawidłowa ilość faktycznego efektu.');
  await withTransaction(pool,async client=>{
    await client.query('SELECT operation_id FROM inventory_mutation_gate WHERE id=$1 FOR UPDATE',['inventory']);
    const operator=await client.query('SELECT id FROM users WHERE id=$1 AND active=true AND role=$2',[actorId,'admin']);
    if(!operator.rowCount) throw new ApiError(403,'FORBIDDEN','Potwierdzenie wymaga aktywnego administratora.');
    const saved=await client.query<OperationRow>(`UPDATE idempotency_records SET state='RECONCILED_DISCREPANCY',response=$2::jsonb,updated_at=now()
      WHERE id=$1 AND state IN ('DISPATCHING','UNCERTAIN','DISCREPANCY') AND kind IN ('consumption','transfer','receipt','adjustment') RETURNING *`,
    [id,JSON.stringify({reason,appliedQuantity:observed.toFixed(),maintenanceAttestation:true,manualDiscrepancy:true})]);
    if(!saved.rows[0]) throw new ApiError(409,'OPERATION_STATE','Nie można zamknąć tej operacji jako ręcznie uzgodnionej rozbieżności.');
    await audit(client,{actorId,operationId:id,action:'inventory.reconcile.observed',outcome:'RECONCILED_DISCREPANCY',details:{reason,actualQuantity:observed.toFixed(),requestedQuantity:saved.rows[0].request.quantity,upstreamWritersStopped:true,manualAttestation:true}});
    await client.query('UPDATE inventory_mutation_gate SET operation_id=NULL,updated_at=now() WHERE id=$1 AND operation_id=$2',['inventory',id]);
  });
}
