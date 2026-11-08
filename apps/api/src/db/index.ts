import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000, statement_timeout: 15000, application_name: 'medam-api' });
}

export type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface AuditEvent {
  actorId?: string | null;
  operationId?: string | null;
  action: string;
  outcome: string;
  resourceRefs?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

export async function audit(db: Queryable, event: AuditEvent): Promise<void> {
  await db.query(`INSERT INTO application_audit_events
    (id,actor_id,operation_id,action,outcome,resource_refs,details)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
  [randomUUID(), event.actorId ?? null, event.operationId ?? null, event.action,
    event.outcome, JSON.stringify(event.resourceRefs ?? {}), JSON.stringify(event.details ?? {})]);
}

export async function first<T extends QueryResultRow>(db: Queryable, sql: string, values: unknown[] = []): Promise<T | undefined> {
  const result = await db.query<T>(sql, values);
  return result.rows[0];
}

export type { Pool, PoolClient, QueryResult };
