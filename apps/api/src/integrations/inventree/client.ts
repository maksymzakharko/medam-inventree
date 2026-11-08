import { z } from 'zod';
import { ApiError } from '../../errors.js';

const pk = z.number().int().positive();
const amount = z.union([z.number().finite(), z.string().regex(/^\d+(?:\.\d+)?$/)]).transform(String);
export const stockSchema = z.object({
  pk, part: pk, quantity: amount, location: pk.nullable(), status: z.number().int(),
  status_custom_key: z.number().int().nullable().optional().default(null),
  batch: z.string().nullable(), expiry_date: z.iso.date().nullable(),
  in_stock: z.boolean(), allocated: amount.nullable().optional().default(null),
  is_building: z.boolean().optional().default(false),
  serial: z.string().nullable().optional().default(null),
  belongs_to: pk.nullable().optional().default(null),
  customer: pk.nullable().optional().default(null),
  consumed_by: pk.nullable().optional().default(null),
  sales_order: pk.nullable().optional().default(null),
  parent: pk.nullable().optional().default(null),
}).passthrough();
export const partSchema = z.object({
  pk, name: z.string().min(1), units: z.string(), active: z.boolean(),
  minimum_stock: amount.optional().default('0'),
}).passthrough();
export const locationSchema = z.object({
  pk, name: z.string(), structural: z.boolean().optional().default(false),
  external: z.boolean().optional().default(false),
}).passthrough();
export const auditSchema = z.object({
  pk, timestamp: z.string(), actor: pk.nullable(), event_type: z.number().int().nullable(),
  model_type: z.string(), object_pk: z.string(), notes: z.string().nullable(),
  cid: z.string().nullable(), deltas: z.record(z.string(), z.unknown()).nullable(),
  changes: z.unknown().optional(),
}).passthrough();
export type StockItem = z.infer<typeof stockSchema>;
export type Part = z.infer<typeof partSchema>;
export type Location = z.infer<typeof locationSchema>;
export type AuditEntry = z.infer<typeof auditSchema>;
export interface InventreeConfig {
  baseUrl: string; token: string; timeoutMs: number;
  expectedVersion?: string; expectedApiVersion?: number;
}
export class InventreeError extends ApiError {
  constructor(statusCode: number, code: string, message: string, public readonly upstreamStatus?: number) {
    super(statusCode, code, message);
  }
}

/** Fixed-origin typed integration. Mutation requests deliberately have no retry. */
export class InventreeClient {
  private readonly base: URL;
  private currentUserId: number | undefined;
  constructor(private readonly options: InventreeConfig) {
    this.base = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password) {
      throw new Error('Nieprawidłowy adres InvenTree.');
    }
  }

  private async request(path: string, method = 'GET', payload?: unknown, operationId?: string): Promise<unknown> {
    const url = new URL(path.replace(/^\//, ''), this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) {
      throw new InventreeError(502, 'UPSTREAM_SCOPE', 'Nieprawidłowy zakres integracji.');
    }
    const attempts = method === 'GET' ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetch(url, {
          method, redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs),
          headers: {
            Authorization: `Token ${this.options.token}`, Accept: 'application/json',
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(operationId ? { 'X-Request-ID': operationId } : {}),
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
        if (method === 'GET' && attempt + 1 < attempts && (response.status === 429 || response.status >= 500)) {
          await response.body?.cancel();
          const retryAfter = response.headers.get('retry-after');
          const seconds = retryAfter === null ? NaN : Number(retryAfter);
          const waitMs = Number.isFinite(seconds) ? Math.max(seconds * 1000, 0)
            : retryAfter ? Math.max(Date.parse(retryAfter) - Date.now(), 0) : 150;
          // A long Retry-After exceeds our bounded retry budget: fail, never retry early.
          if (waitMs > 1000) throw new InventreeError(503, 'UPSTREAM_RATE_LIMIT', 'System magazynowy jest chwilowo zajęty.');
          await new Promise(resolve => setTimeout(resolve, Number.isFinite(waitMs) ? waitMs : 150));
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new InventreeError(response.status === 404 ? 404 : 502,
            response.status === 404 ? 'UPSTREAM_NOT_FOUND' : 'UPSTREAM_REJECTED',
            response.status === 404 ? 'Nie znaleziono zasobu.' : 'System magazynowy nie potwierdził operacji.', response.status);
        }
        const text = await response.text();
        if (text.length > 4_000_000) throw new InventreeError(502, 'UPSTREAM_RESPONSE_LIMIT', 'Odpowiedź systemu magazynowego przekracza limit.');
        try { return JSON.parse(text) as unknown; }
        catch { throw new InventreeError(502, 'UPSTREAM_SCHEMA', 'Nieprawidłowa odpowiedź systemu magazynowego.'); }
      } catch (error) {
        if (error instanceof InventreeError) throw error;
        if (attempt + 1 < attempts) {
          await new Promise(resolve => setTimeout(resolve, 150));
          continue;
        }
        throw new InventreeError(503, 'UPSTREAM_UNAVAILABLE', 'Brak odpowiedzi systemu magazynowego.');
      }
    }
    throw new InventreeError(503, 'UPSTREAM_UNAVAILABLE', 'Brak odpowiedzi systemu magazynowego.');
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new InventreeError(502, 'UPSTREAM_SCHEMA', 'Nieprawidłowa odpowiedź systemu magazynowego.');
    return parsed.data;
  }

  private async page<T>(path: string, query: Record<string, string>, schema: z.ZodType<T>, offset: number, limit: number) {
    const params = new URLSearchParams({ ...query, limit: String(limit), offset: String(offset) });
    return this.parse(z.object({
      count: z.number().int().nonnegative(), next: z.string().nullable(),
      previous: z.string().nullable(), results: z.array(schema),
    }), await this.request(`${path}?${params}`));
  }

  /** We construct each page ourselves; upstream next links never receive credentials. */
  private async all<T>(path: string, query: Record<string, string>, schema: z.ZodType<T>, maximum = 2000): Promise<T[]> {
    const items: T[] = [];
    const started = Date.now();
    for (let offset = 0; offset < maximum; offset += 100) {
      const page = await this.page(path, query, schema, offset, 100);
      items.push(...page.results);
      if (!page.next) return items;
      if (page.results.length === 0 || Date.now() - started > 30_000) break;
    }
    throw new InventreeError(502, 'UPSTREAM_PAGE_LIMIT', 'Przekroczono limit odczytu danych magazynowych.');
  }

  async checkVersion() {
    const info = this.parse(z.object({ version: z.string(), apiVersion: z.number().int() }).passthrough(), await this.request('api/'));
    if ((this.options.expectedVersion && info.version !== this.options.expectedVersion)
      || (this.options.expectedApiVersion && info.apiVersion !== this.options.expectedApiVersion)) {
      throw new InventreeError(503, 'UPSTREAM_VERSION', 'Wersja systemu magazynowego wymaga sprawdzenia zgodności.');
    }
    await this.getCurrentUserId();
    return info;
  }

  async getCurrentUserId(): Promise<number> {
    if (this.currentUserId === undefined) {
      this.currentUserId = this.parse(z.object({ pk }).passthrough(), await this.request('api/user/me/')).pk;
    }
    return this.currentUserId;
  }
  async getStock(id: number): Promise<StockItem> { return this.parse(stockSchema, await this.request(`api/stock/${id}/`)); }
  async getPart(id: number): Promise<Part> { return this.parse(partSchema, await this.request(`api/part/${id}/`)); }
  async getLocation(id: number): Promise<Location> { return this.parse(locationSchema, await this.request(`api/stock/location/${id}/`)); }
  async listLocations(): Promise<Location[]> { return this.all('api/stock/location/', {}, locationSchema); }
  async createLocation(name: string): Promise<Location> {
    return this.parse(locationSchema, await this.request('api/stock/location/', 'POST', { name, structural: false, external: false }));
  }
  async listParts(q = '', offset = 0, limit = 50) {
    return this.page('api/part/', { active: 'true', search: q }, partSchema, offset, limit);
  }
  async stockAtLocation(locationId: number): Promise<StockItem[]> {
    const location = await this.getLocation(locationId);
    if (location.pk !== locationId || location.external || location.structural) {
      throw new InventreeError(502, 'UPSTREAM_SCOPE', 'Nieprawidłowe przypisanie magazynu.');
    }
    const items = await this.all('api/stock/', { location: String(locationId), cascade: 'false', ordering: 'expiry_date,pk' }, stockSchema);
    if (items.some(item => item.location !== locationId)) {
      throw new InventreeError(502, 'UPSTREAM_SCOPE', 'System magazynowy zwrócił dane spoza dozwolonego magazynu.');
    }
    return items;
  }
  async adjustStock(kind: 'remove' | 'add' | 'transfer', operationId: string, stockId: number, quantity: string, destination?: number): Promise<void> {
    const item = kind === 'transfer' ? { pk: stockId, quantity, merge: false } : { pk: stockId, quantity };
    await this.request(`api/stock/${kind}/`, 'POST', {
      items: [item], notes: `medam-op:${operationId}`, ...(destination === undefined ? {} : { location: destination }),
    }, operationId);
  }
  async createStock(operationId: string, data: { part: number; location: number; quantity: string; batch: string; expiry_date: string }): Promise<StockItem[]> {
    // StockItem create has no notes field. Correlation is the authenticated request cid.
    return this.parse(z.array(stockSchema), await this.request('api/stock/', 'POST', { ...data, status: 10, delete_on_deplete: false }, operationId));
  }
  async auditById(id: number): Promise<AuditEntry> { return this.parse(auditSchema, await this.request(`api/audit/${id}/`)); }
  async auditForOperation(operationId: string, stockId?: number, since?: string): Promise<AuditEntry[]> {
    const query: Record<string, string> = { model_type: 'stock.stockitem', cid: operationId, include_children: 'false' };
    const byCid = await this.all('api/audit/', query, auditSchema);
    const exact = byCid.filter(entry => entry.model_type === 'stock.stockitem' && entry.cid === operationId);
    if (exact.length > 0 || stockId === undefined || since === undefined) return exact;
    // A stripped request id cannot be searched via notes; scan a bounded item/date range.
    const fallback = await this.all('api/audit/', {
      model_type: 'stock.stockitem', model_id: String(stockId), include_children: 'false', min_date: since.slice(0, 10),
    }, auditSchema);
    return fallback.filter(entry => entry.model_type === 'stock.stockitem' && entry.notes === `medam-op:${operationId}`);
  }
}
