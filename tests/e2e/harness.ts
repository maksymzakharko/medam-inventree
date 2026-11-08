/** Local test harness only: real API and PostgreSQL, controllable InvenTree HTTP double. */
import { createServer, request as proxyRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createTestEnvironment } from '../fixtures/app-fixture.js';

const env = await createTestEnvironment();
const apiAddress = new URL(await env.app.listen({ port: 0, host: '127.0.0.1' }));
const publicRoot = resolve('apps/web/dist');
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const allowedBehaviours = new Set(['normal', 'timeout-after-apply', 'partial', 'missing-audit', 'duplicate-audit']);

const server = createServer((req, res) => {
  void (async () => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1:5179').pathname;
    if (pathname.startsWith('/__test/')) {
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      if (req.method === 'POST' && pathname === '/__test/reset') {
        await env.reset(); res.end('{"ok":true}'); return;
      }
      if (req.method === 'POST' && pathname === '/__test/behaviour') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk);
          if (size > 1024) throw new Error('Test control payload too large');
          chunks.push(Buffer.from(chunk));
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString()) as { behaviour: typeof env.upstream.behaviour };
        if (!allowedBehaviours.has(payload.behaviour)) throw new Error('Unknown test behaviour');
        env.upstream.behaviour = payload.behaviour;
        res.end('{"ok":true}'); return;
      }
      if (req.method === 'GET' && pathname === '/__test/stats') {
        res.end(JSON.stringify({ mutationCount: env.upstream.mutationCount })); return;
      }
      res.statusCode = 404; res.end('{}'); return;
    }
    if (pathname.startsWith('/api/') || pathname.startsWith('/health/')) {
      const upstream = proxyRequest({ hostname: '127.0.0.1', port: apiAddress.port, method: req.method, path: req.url, headers: req.headers }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream); return;
    }
    const file = resolve(publicRoot, `.${decodeURIComponent(pathname)}`);
    if (file !== publicRoot && !file.startsWith(`${publicRoot}${sep}`)) { res.writeHead(404); res.end(); return; }
    let data: Buffer;
    let extension = extname(file);
    try { data = await readFile(file); }
    catch { data = await readFile(resolve(publicRoot, 'index.html')); extension = '.html'; }
    res.writeHead(200, { 'content-type': mime[extension] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Test harness error');
    if (!res.headersSent) res.writeHead(500);
    res.end('Test harness failure');
  });
});

await new Promise<void>((resolve) => server.listen(5179, '127.0.0.1', resolve));
console.log('E2E harness ready on http://127.0.0.1:5179 (dedicated test database + HTTP transport double).');
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await env.close();
}
process.on('SIGTERM', () => { void stop().then(() => process.exit(0)); });
process.on('SIGINT', () => { void stop().then(() => process.exit(0)); });
