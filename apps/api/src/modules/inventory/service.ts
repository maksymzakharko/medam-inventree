import { Decimal } from 'decimal.js';
import type { Actor, StockItem as StockDto } from '@medam/shared';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../errors.js';
import type { Part, StockItem } from '../../integrations/inventree/client.js';

export interface StockPolicy { minimum: string; quantum: string }
export function todayWarsaw(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (name: string) => parts.find(part => part.type === name)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}
export function decimal(value: string | number): Decimal {
  try {
    const amount = new Decimal(value);
    if (!amount.isFinite() || amount.isNegative() || amount.decimalPlaces() > 5 || amount.gt('9999999999.99999')) throw new Error();
    return amount;
  } catch { throw new ApiError(502, 'UPSTREAM_QUANTITY', 'Nieprawidłowa ilość w systemie magazynowym.'); }
}
export async function warehouseExists(ctx: AppContext, locationId: number): Promise<void> {
  const result = await ctx.db.query('SELECT location_id FROM warehouse_mappings WHERE location_id=$1 AND enabled=true', [locationId]);
  if (!result.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Nie znaleziono zasobu.');
}
export async function policyFor(ctx: AppContext, locationId: number, partId: number): Promise<StockPolicy> {
  const result = await ctx.db.query<{minimum: string; quantum: string}>('SELECT minimum::text,quantum::text FROM warehouse_product_policies WHERE location_id=$1 AND part_id=$2', [locationId, partId]);
  return result.rows[0] ?? { minimum: '0', quantum: '1' };
}
export function assertQuantum(quantity: string, policy: StockPolicy): void {
  const value = new Decimal(quantity), quantum = new Decimal(policy.quantum);
  if (!value.isFinite() || !value.gt(0) || value.gt('9999999999.99999') || value.decimalPlaces() > 5 || !quantum.gt(0) || !value.mod(quantum).isZero()) {
    throw new ApiError(400, 'QUANTITY_UNIT', 'Ilość jest niezgodna z jednostką preparatu.');
  }
}
export function physicalProblems(stock: StockItem): string[] {
  const problems: string[] = [];
  if (stock.is_building || stock.serial || stock.belongs_to || stock.customer || stock.consumed_by || stock.sales_order) problems.push('BLOCKED');
  if (stock.allocated === null || decimal(stock.allocated).gt(0)) problems.push('ALLOCATED');
  return problems;
}
export function eligibilityProblems(stock: StockItem, part: Part, allowZero = false): string[] {
  const problems = physicalProblems(stock);
  if (!part.active || !part.units.trim() || stock.status !== 10 || stock.status_custom_key !== null || (!allowZero && (!stock.in_stock || !decimal(stock.quantity).gt(0)))) problems.push('BLOCKED');
  if (!stock.batch?.trim()) problems.push('MISSING_LOT');
  if (!stock.expiry_date) problems.push('MISSING_EXP');
  else if (stock.expiry_date < todayWarsaw()) problems.push('EXPIRED');
  return [...new Set(problems)];
}
export async function ownedStock(ctx: AppContext, actor: Actor, id: number): Promise<StockItem> {
  let stock: StockItem;
  try { stock = await ctx.inventory.getStock(id); }
  catch (error) {
    if (error instanceof ApiError && error.statusCode === 404) throw new ApiError(404, 'NOT_FOUND', 'Nie znaleziono zasobu.');
    throw error;
  }
  if (stock.pk !== id) throw new ApiError(502, 'UPSTREAM_SCOPE', 'Nieprawidłowa odpowiedź magazynu.');
  if (stock.location === null || (actor.role === 'medic' && stock.location !== actor.warehouse?.id)) throw new ApiError(404, 'NOT_FOUND', 'Nie znaleziono zasobu.');
  await warehouseExists(ctx, stock.location);
  return stock;
}
export function stockToDto(stock: StockItem, part: Part, policy: StockPolicy, aggregateQuantity = stock.quantity): StockDto {
  const amount = decimal(stock.quantity), allocated = stock.allocated === null ? amount : decimal(stock.allocated);
  const warnings = eligibilityProblems(stock, part);
  if (new Decimal(aggregateQuantity).lt(policy.minimum)) warnings.push('LOW_STOCK');
  if (stock.expiry_date && stock.expiry_date >= todayWarsaw()) {
    const days = Math.round((Date.parse(`${stock.expiry_date}T00:00:00Z`) - Date.parse(`${todayWarsaw()}T00:00:00Z`)) / 86400000);
    if (days <= 7) warnings.push('EXPIRING_SOON'); else if (days <= 30) warnings.push('EXPIRING');
  }
  return { id: stock.pk, partId: stock.part, name: part.name, quantity: amount.toFixed(),
    availableQuantity: Decimal.max(amount.minus(allocated), 0).toFixed(), unit: part.units,
    lot: stock.batch ?? '', exp: stock.expiry_date, minimum: new Decimal(policy.minimum).toFixed(),
    warnings: [...new Set(warnings)], eligibleForConsumption: eligibilityProblems(stock, part).length === 0, status: stock.status };
}
export async function getStockDto(ctx: AppContext, actor: Actor, id: number): Promise<StockDto> {
  const stock = await ownedStock(ctx, actor, id);
  // Use the same per-product usable aggregate as the list, including other lots.
  const dto = (await listStockDto(ctx, stock.location!)).find(item => item.id === id);
  if (!dto) throw new ApiError(404, 'NOT_FOUND', 'Nie znaleziono zasobu.');
  return dto;
}
export async function listStockDto(ctx: AppContext, locationId: number): Promise<StockDto[]> {
  await warehouseExists(ctx, locationId);
  const stock = await ctx.inventory.stockAtLocation(locationId);
  const parts = new Map<number, Part>(), policies = new Map<number, StockPolicy>(), totals = new Map<number, Decimal>();
  for (const item of stock) totals.set(item.part, new Decimal(0));
  for (const partId of totals.keys()) {
    const [part, policy] = await Promise.all([ctx.inventory.getPart(partId), policyFor(ctx, locationId, partId)]);
    if (part.pk !== partId) throw new ApiError(502, 'UPSTREAM_SCOPE', 'Nieprawidłowa odpowiedź magazynu.');
    parts.set(partId, part); policies.set(partId, policy);
  }
  for (const item of stock) {
    if (eligibilityProblems(item, parts.get(item.part)!).length === 0) {
      const available = Decimal.max(decimal(item.quantity).minus(item.allocated ?? item.quantity), 0);
      totals.set(item.part, totals.get(item.part)!.plus(available));
    }
  }
  return stock.map(item => stockToDto(item, parts.get(item.part)!, policies.get(item.part)!, totals.get(item.part)!.toFixed()))
    .sort((a, b) => Number(b.eligibleForConsumption) - Number(a.eligibleForConsumption) || (a.exp ?? '9999').localeCompare(b.exp ?? '9999') || a.name.localeCompare(b.name, 'pl') || a.id - b.id);
}
