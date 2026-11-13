import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Actor, Role } from '@medam/shared';
import type { Pool, PoolClient } from 'pg';
import type { Config } from '../../config.js';
import { ApiError } from '../../errors.js';
import { audit, withTransaction } from '../../db/index.js';
import { hashPassword } from './passwords.js';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const normalizeLogin = (login: string) => login.trim().toLowerCase();

export interface UserRow {
  id: string; login: string; role: Role; active: boolean; password_hash: string | null;
  version: number; password_version: number; location_id: number | null; code: string | null; name: string | null;
}
export function toActor(row: Pick<UserRow, 'id'|'login'|'role'|'location_id'|'code'|'name'>): Actor {
  return { id: row.id, login: row.login, role: row.role,
    warehouse: row.location_id && row.code && row.name ? { id: row.location_id, code: row.code, name: row.name } : null };
}
export const userWithWarehouseSql = `SELECT u.*, w.location_id,w.code,w.name FROM users u
 LEFT JOIN user_warehouse_assignments a ON a.user_id=u.id AND a.valid_to IS NULL
 LEFT JOIN warehouse_mappings w ON w.location_id=a.location_id AND w.enabled=true`;

export async function loadSession(pool: Pool, token: string, config: Config): Promise<Actor | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const result = await pool.query<UserRow>(`WITH valid_session AS (
    UPDATE sessions s SET last_seen_at=now() FROM users u
    WHERE s.token_hash=$1 AND s.user_id=u.id AND u.active=true
      AND s.password_version=u.password_version AND s.revoked_at IS NULL
      AND s.expires_at>now() AND s.last_seen_at>now()-($2::integer*interval '1 minute')
    RETURNING s.user_id
  ) SELECT u.*,w.location_id,w.code,w.name FROM valid_session s JOIN users u ON u.id=s.user_id
  LEFT JOIN user_warehouse_assignments a ON a.user_id=u.id AND a.valid_to IS NULL
  LEFT JOIN warehouse_mappings w ON w.location_id=a.location_id AND w.enabled=true`,
  [hashToken(token), config.sessionIdleMinutes]);
  return result.rows[0] ? toActor(result.rows[0]) : null;
}

/** Revalidate authorization after taking the inventory gate, before accepting a new write. */
export async function requireCurrentSession(client: PoolClient, config: Config, tokenHash: string | null,
  actorId: string, roles: readonly Role[], recent = false): Promise<Actor> {
  if (!tokenHash) throw new ApiError(401, 'SESSION_REQUIRED', 'Zaloguj się ponownie.');
  // Keep the same gate -> user -> session lock order as account changes and login/reset.
  const users = await client.query<UserRow>(`${userWithWarehouseSql} WHERE u.id=$1 AND u.active=true FOR UPDATE OF u`, [actorId]);
  const user = users.rows[0];
  if (!user) throw new ApiError(401, 'SESSION_REQUIRED', 'Zaloguj się ponownie.');
  const sessions = await client.query<{recent: boolean}>(`SELECT created_at>now()-interval '15 minutes' AS recent
    FROM sessions WHERE token_hash=$1 AND user_id=$2 AND password_version=$3
      AND revoked_at IS NULL AND expires_at>now()
      AND last_seen_at>now()-($4::integer*interval '1 minute') FOR UPDATE`,
  [tokenHash, actorId, user.password_version, config.sessionIdleMinutes]);
  const session = sessions.rows[0];
  if (!session) throw new ApiError(401, 'SESSION_REQUIRED', 'Zaloguj się ponownie.');
  if (!roles.includes(user.role)) throw new ApiError(403, 'FORBIDDEN', 'Brak uprawnień do tej operacji.');
  if (recent && !session.recent) throw new ApiError(403, 'ADMIN_REAUTH_REQUIRED', 'Ta operacja wymaga ponownego zalogowania.');
  const actor = toActor(user);
  if (actor.role === 'medic' && !actor.warehouse) throw new ApiError(403, 'WAREHOUSE_ASSIGNMENT_REQUIRED', 'Brak aktywnego przypisania magazynu.');
  return actor;
}

export async function limitAuth(pool: Pool, config: Config, kind: string, identity: string, limit: number, windowSeconds: number): Promise<void> {
  const key = createHmac('sha256', config.sessionSecret).update(`${kind}:${identity}`).digest('hex');
  const result = await pool.query<{attempts:number}>(`INSERT INTO login_rate_limits(key,window_start,attempts)
    VALUES($1,now(),1) ON CONFLICT(key) DO UPDATE SET
    attempts=CASE WHEN login_rate_limits.window_start<now()-($2::integer*interval '1 second') THEN 1 ELSE login_rate_limits.attempts+1 END,
    window_start=CASE WHEN login_rate_limits.window_start<now()-($2::integer*interval '1 second') THEN now() ELSE login_rate_limits.window_start END
    RETURNING attempts`,[key,windowSeconds]);
  if ((result.rows[0]?.attempts ?? limit+1)>limit) throw new ApiError(429,'AUTH_RATE_LIMIT','Zbyt wiele prób. Spróbuj ponownie później.');
}

export async function issuePasswordReset(pool: Pool, userId: string, createdBy: string | null): Promise<string> {
  const token=newToken();
  await withTransaction(pool,async client=>{
    const user=await client.query('SELECT id FROM users WHERE id=$1 AND active=true FOR UPDATE',[userId]);
    if(!user.rows.length) throw new ApiError(404,'NOT_FOUND','Nie znaleziono konta.');
    await client.query('UPDATE password_reset_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[userId]);
    await client.query(`INSERT INTO password_reset_tokens(token_hash,user_id,created_by,expires_at)
      VALUES($1,$2,$3,now()+interval '15 minutes')`,[hashToken(token),userId,createdBy]);
    await audit(client,{actorId:createdBy,action:'auth.password_reset_issued',outcome:'issued',resourceRefs:{userId}});
  });
  return token;
}

export async function completePasswordReset(pool: Pool, token: string, password: string): Promise<void> {
  const passwordHash=await hashPassword(password);
  await withTransaction(pool,async client=>{
    // Match the lock order of issuance and login: user first, token second.
    const candidate = await client.query<{user_id:string}>(`SELECT user_id FROM password_reset_tokens
      WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now()`, [hashToken(token)]);
    if (!candidate.rows[0]) throw new ApiError(400,'RESET_INVALID','Link resetowania jest nieprawidłowy lub wygasł.');
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [candidate.rows[0].user_id]);
    const result=await client.query<{user_id:string}>(`UPDATE password_reset_tokens t SET consumed_at=now()
      FROM users u WHERE t.token_hash=$1 AND t.user_id=u.id AND u.active=true
      AND t.consumed_at IS NULL AND t.expires_at>now() RETURNING t.user_id`,[hashToken(token)]);
    const userId=result.rows[0]?.user_id;
    if(!userId) throw new ApiError(400,'RESET_INVALID','Link resetowania jest nieprawidłowy lub wygasł.');
    await client.query(`UPDATE users SET password_hash=$2,password_version=password_version+1,version=version+1,updated_at=now() WHERE id=$1`,[userId,passwordHash]);
    await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[userId]);
    await client.query('UPDATE password_reset_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[userId]);
    await audit(client,{actorId:userId,action:'auth.password_reset_completed',outcome:'success',resourceRefs:{userId}});
  });
}
