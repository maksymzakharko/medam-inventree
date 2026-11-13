import { loadConfig } from './config.js';
import { createPool } from './db/index.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const app = await buildApp({ config, db });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await db.end();
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
try {
  await app.listen({ host: config.host, port: config.port });
} catch {
  app.log.error('Nie udało się uruchomić API. Sprawdź konfigurację i zależności.');
  await stop();
  process.exitCode = 1;
}
