import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
for (const key of ['APP_DATABASE_URL', 'SESSION_SECRET', 'INVENTREE_TOKEN']) {
  const file = process.env[`${key}_FILE`];
  if (file) process.env[key] = readFileSync(file, 'utf8').trim();
  delete process.env[`${key}_FILE`];
}
if (process.getuid?.() === 0) {
  process.setgroups([]);
  process.setgid(1000);
  process.setuid(1000);
}
if (process.getuid?.() === 0) throw new Error('API refuses to remain root.');
const target = process.argv[2] || 'dist/server.js';
process.argv = [process.argv[0], resolve(target), ...process.argv.slice(3)];
await import(pathToFileURL(resolve(target)).href);
