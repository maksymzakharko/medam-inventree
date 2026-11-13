import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/** The migration URL must use the separate migration role in production. */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('medam-schema-migrations'))");
    await drizzleMigrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL('../../drizzle/', import.meta.url)),
    });
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('medam-schema-migrations'))").catch(() => undefined);
    client.release();
  }
}
