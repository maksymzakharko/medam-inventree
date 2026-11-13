import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

/** Test-only transport double. Never imported by production code or deployed. */
export interface FixtureStock {
  pk: number;
  part: number;
  quantity: string;
  location: number | null;
  status: number;
  in_stock: boolean;
  allocated: string;
  batch: string | null;
  expiry_date: string | null;
  status_custom_key: number | null;
  serial: string | null;
  is_building: boolean;
  belongs_to: number | null;
  customer: number | null;
  consumed_by: number | null;
  sales_order: number | null;
  parent: number | null;
}

export interface FixtureAudit {
  pk: number;
  timestamp: string;
  actor: number;
  event_type: number;
  model_type: string;
  object_pk: string;
  notes: string;
  deltas: Record<string, unknown>;
  changes: Record<string, unknown>;
  cid: string;
}

type Behaviour = 'normal' | 'timeout-after-apply' | 'partial' | 'missing-audit' | 'duplicate-audit';

export class InventreeStub {
  readonly token = randomUUID();
  readonly stock = new Map<number, FixtureStock>();
  readonly audit: FixtureAudit[] = [];
  readonly requests: Array<{ method: string; path: string; query: URLSearchParams; body: unknown }> = [];
  behaviour: Behaviour = 'normal';
  leakForeignStock = false;
  leakForeignOnLastPage = false;
  malformedStock = false;
  mutationCount = 0;
  url = '';
  private server = createServer((req, res) => { void this.handle(req, res); });

  reset() {
    this.stock.clear();
    for (let i = 0; i < 12; i++) {
      const location = 100 + i;
      this.stock.set(1000 + i, {
        pk: 1000 + i, part: 1, quantity: '100', location, status: 10,
        in_stock: true, allocated: '0', batch: `TEST-LOT-${String(i).padStart(2, '0')}`,
        expiry_date: '2099-06-30', status_custom_key: null, serial: null,
        is_building: false, belongs_to: null, customer: null, consumed_by: null,
        sales_order: null, parent: null,
      });
    }
    this.audit.length = 0;
    this.requests.length = 0;
    this.behaviour = 'normal';
    this.leakForeignStock = false;
    this.leakForeignOnLastPage = false;
    this.malformedStock = false;
    this.mutationCount = 0;
  }

  async start() {
    this.reset();
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') throw new Error('No fixture listening address');
    this.url = `http://127.0.0.1:${addr.port}`;
    return this;
  }

  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close((err) => err ? reject(err) : resolve()));
  }

  private json(res: ServerResponse, data: unknown, status = 200) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private page(res: ServerResponse, url: URL, rows: unknown[]) {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 100));
    const next = offset + limit < rows.length
      ? `${this.url}${url.pathname}?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), offset: String(offset + limit), limit: String(limit) })}`
      : null;
    this.json(res, { count: rows.length, next, previous: null, results: rows.slice(offset, offset + limit) });
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
  }

  private track(req: IncomingMessage, stock: FixtureStock, eventType: number, notes: string, deltas: Record<string, unknown>) {
    if (this.behaviour === 'missing-audit') return;
    const event: FixtureAudit = {
      pk: this.audit.length + 1, timestamp: new Date().toISOString(), actor: 99,
      event_type: eventType, model_type: 'stock.stockitem', object_pk: String(stock.pk),
      notes, cid: String(req.headers['x-request-id'] ?? ''), deltas, changes: {},
    };
    this.audit.push(event);
    if (this.behaviour === 'duplicate-audit') this.audit.push({ ...event, pk: event.pk + 1 });
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? '/', this.url || 'http://127.0.0.1');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      if (req.headers.authorization !== `Token ${this.token}`) return this.json(res, { detail: 'Invalid token' }, 401);
      const body = method === 'GET' ? null : await this.body(req);
      this.requests.push({ method, path, query: url.searchParams, body });

      if (method === 'GET' && path === '/api/') return this.json(res, { server: 'InvenTree', version: '1.7.0', apiVersion: 570, api_version: 570 });
      if (method === 'GET' && path === '/api/user/me/') return this.json(res, { pk: 99, username: 'medam-service' });
      if (method === 'GET' && path === '/api/stock/status/') return this.json(res, [{ key: 10, value: 'OK' }, { key: 55, value: 'Damaged' }]);
      if (method === 'GET' && path === '/api/part/1/') return this.json(res, { pk: 1, name: 'Witamina C TEST', units: 'piece', active: true, minimum_stock: '5' });
      if (method === 'GET' && path === '/api/part/') return this.page(res, url, [{ pk: 1, name: 'Witamina C TEST', units: 'piece', active: true, minimum_stock: '5' }]);
      if (method === 'GET' && path === '/api/stock/location/') return this.page(res, url, Array.from({ length: 12 }, (_, i) => ({ pk: 100 + i, name: `MAG-${String(i).padStart(2, '0')}`, description: i === 0 ? 'Główny' : i === 11 ? 'Gabinet' : `Ratownik ${i}`, parent: null, structural: false, external: false })));
      if (method === 'GET' && /^\/api\/stock\/location\/\d+\/$/.test(path)) {
        const id = Number(path.split('/')[4]);
        return id >= 100 && id <= 111 ? this.json(res, { pk: id, name: `MAG-${String(id - 100).padStart(2, '0')}`, parent: null, structural: false, external: false }) : this.json(res, {}, 404);
      }
      if (method === 'GET' && path === '/api/stock/') {
        if (this.malformedStock) return this.json(res, { results: [{ pk: 'bad' }] });
        const location = Number(url.searchParams.get('location'));
        let rows = Array.from(this.stock.values()).filter((item) => item.location === location);
        if (this.leakForeignStock) rows = Array.from(this.stock.values());
        if (this.leakForeignOnLastPage) {
          const foreign = Array.from(this.stock.values()).find((item) => item.location !== location);
          if (foreign) rows.push(foreign);
        }
        return this.page(res, url, rows);
      }
      if (method === 'GET' && /^\/api\/stock\/\d+\/$/.test(path)) {
        const item = this.stock.get(Number(path.split('/')[3]));
        return item ? this.json(res, item) : this.json(res, {}, 404);
      }
      if (method === 'GET' && path === '/api/audit/') {
        let rows = this.audit;
        const cid = url.searchParams.get('cid');
        const modelId = url.searchParams.get('model_id');
        const eventType = url.searchParams.get('event_type');
        if (cid) rows = rows.filter((x) => x.cid === cid);
        if (modelId) rows = rows.filter((x) => x.object_pk === modelId);
        if (eventType) rows = rows.filter((x) => x.event_type === Number(eventType));
        return this.page(res, url, rows);
      }
      if (method === 'GET' && /^\/api\/audit\/\d+\/$/.test(path)) {
        const event = this.audit.find((item) => item.pk === Number(path.split('/')[3]));
        return event ? this.json(res, event) : this.json(res, {}, 404);
      }
      if (method === 'POST' && ['/api/stock/remove/', '/api/stock/add/', '/api/stock/transfer/'].includes(path)) {
        this.mutationCount++;
        const payload = body as { items: Array<{ pk: number; quantity: string }>; notes: string; location?: number };
        for (const entry of payload.items) {
          const stock = this.stock.get(entry.pk);
          if (!stock) return this.json(res, { detail: 'Not found' }, 404);
          const requested = Number(entry.quantity);
          const actual = this.behaviour === 'partial' ? Math.min(1, requested) : Math.min(Number(stock.quantity), requested);
          if (path === '/api/stock/remove/') {
            stock.quantity = String(Number(stock.quantity) - actual);
            this.track(req, stock, 12, payload.notes, { removed: actual, quantity: Number(stock.quantity) });
          } else if (path === '/api/stock/add/') {
            stock.quantity = String(Number(stock.quantity) + requested);
            this.track(req, stock, 11, payload.notes, { added: requested, quantity: Number(stock.quantity) });
          } else {
            if (actual === Number(stock.quantity)) {
              stock.location = payload.location ?? null;
              this.track(req, stock, 20, payload.notes, { quantity: actual, location: stock.location });
            } else {
              const targetId = 5000 + this.stock.size;
              const moved = { ...stock, pk: targetId, quantity: String(actual), location: payload.location ?? null, parent: stock.pk };
              stock.quantity = String(Number(stock.quantity) - actual);
              this.stock.set(targetId, moved);
              // InvenTree 1.7 partial transfer: split-child(42) on source, split-from-parent(40) on child.
              this.track(req, stock, 42, payload.notes, { removed: actual, quantity: Number(stock.quantity), stockitem: { pk: targetId } });
              this.track(req, moved, 40, payload.notes, { quantity: actual, stockitem: { pk: stock.pk } });
            }
          }
        }
        if (this.behaviour === 'timeout-after-apply') {
          req.socket.destroy();
          return;
        }
        return this.json(res, payload, 201);
      }
      if (method === 'POST' && path === '/api/stock/') {
        this.mutationCount++;
        const payload = body as unknown as { part: number; location: number; quantity: string; batch: string; expiry_date: string };
        const baseline = this.stock.get(1000);
        if (!baseline) throw new Error('Missing fixture baseline');
        const stock = { ...baseline, pk: 6000 + this.stock.size, ...payload };
        this.stock.set(stock.pk, stock);
        this.track(req, stock, 1, '', { quantity: Number(stock.quantity) });
        return this.json(res, [stock], 201);
      }
      return this.json(res, { detail: `Unsupported test endpoint ${method} ${path}` }, 404);
    } catch {
      if (!res.headersSent) this.json(res, { detail: 'Fixture request invalid' }, 500);
      else res.end();
    }
  }
}
