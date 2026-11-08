import type { Actor } from '@medam/shared';
import { CreateUserSchema, UpdateUserSchema } from '@medam/shared';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../errors.js';
import { audit, withTransaction } from '../../db/index.js';
import { normalizeLogin, toActor, userWithWarehouseSql, type UserRow } from '../auth/service.js';

export interface AdminUser extends Actor { active: boolean; version: number; bootstrapRequired: boolean }
export const userDto = (row: UserRow): AdminUser => ({ ...toActor(row), active: row.active,
  version: row.version, bootstrapRequired: row.password_hash === null });

async function warehouseExists(client: PoolClient, locationId: number): Promise<void> {
  const result = await client.query("SELECT location_id FROM warehouse_mappings WHERE location_id=$1 AND enabled=true AND code ~ '^MAG-(0[1-9]|10)$'", [locationId]);
  if (!result.rowCount) throw new ApiError(400, 'WAREHOUSE_INVALID', 'Wybierz osobisty magazyn ratownika MAG-01–MAG-10.');
}

async function currentAdministrator(client: PoolClient, actorId: string): Promise<void> {
  const actor = await client.query('SELECT id FROM users WHERE id=$1 AND active=true AND role=$2 FOR UPDATE', [actorId, 'admin']);
  if (!actor.rowCount) throw new ApiError(403, 'FORBIDDEN', 'Brak uprawnień administratora.');
}

export async function createUser(pool: Pool, actorId: string, input: z.infer<typeof CreateUserSchema>): Promise<AdminUser> {
  const login = normalizeLogin(input.login);
  if (login.length < 3) throw new ApiError(400, 'LOGIN_INVALID', 'Login musi mieć co najmniej 3 znaki.');
  if (input.role === 'medic' && !input.warehouseId) throw new ApiError(400, 'WAREHOUSE_REQUIRED', 'Ratownik musi mieć przypisany magazyn.');
  if (input.role !== 'medic' && input.warehouseId !== undefined) throw new ApiError(400, 'WAREHOUSE_NOT_ALLOWED', 'Magazyn osobisty przypisujemy wyłącznie ratownikowi.');
  try {
    return await withTransaction(pool, async client => {
      await currentAdministrator(client, actorId);
      if (input.warehouseId !== undefined) await warehouseExists(client, input.warehouseId);
      const id = randomUUID();
      await client.query('INSERT INTO users(id,login,role) VALUES($1,$2,$3)', [id, login, input.role]);
      if (input.warehouseId !== undefined) await client.query('INSERT INTO user_warehouse_assignments(user_id,location_id) VALUES($1,$2)', [id, input.warehouseId]);
      await audit(client, { actorId, action: 'users.created', outcome: 'success', resourceRefs: { userId: id },
        details: { role: input.role, warehouseId: input.warehouseId ?? null } });
      const result = await client.query<UserRow>(`${userWithWarehouseSql} WHERE u.id=$1`, [id]);
      return userDto(result.rows[0]!);
    });
  } catch (error) {
    if ((error as {code?: string}).code === '23505') {
      const assignmentConflict = (error as {constraint?: string}).constraint === 'assignment_one_current_per_location';
      throw new ApiError(409, assignmentConflict ? 'WAREHOUSE_ASSIGNED' : 'LOGIN_CONFLICT', assignmentConflict
        ? 'Ten magazyn ma już aktywnego ratownika.' : 'Konto z takim loginem już istnieje.');
    }
    throw error;
  }
}

export async function updateUser(pool: Pool, actorId: string, userId: string, input: z.infer<typeof UpdateUserSchema>): Promise<AdminUser> {
  if (input.active === undefined && input.role === undefined && input.warehouseId === undefined) throw new ApiError(400, 'NO_CHANGES', 'Podaj co najmniej jedną zmianę.');
  try { return await withTransaction(pool, async client => {
    // The gate is locked first, in the same order as stock mutation preparation.
    const gate = await client.query<{operation_id: string | null}>('SELECT operation_id FROM inventory_mutation_gate WHERE id=$1 FOR UPDATE', ['inventory']);
    if (gate.rows[0]?.operation_id) throw new ApiError(423, 'INVENTORY_RECONCILIATION_REQUIRED', 'Najpierw zakończ lub uzgodnij trwającą operację magazynową.');
    // Lock every active administrator consistently before changing a last-admin candidate.
    await client.query(`SELECT id FROM users WHERE id=$1 OR id=$2 OR (active=true AND role='admin') ORDER BY id FOR UPDATE`, [actorId, userId]);
    await currentAdministrator(client, actorId);
    const result = await client.query<UserRow>(`${userWithWarehouseSql} WHERE u.id=$1`, [userId]);
    const before = result.rows[0];
    if (!before) throw new ApiError(404, 'NOT_FOUND', 'Nie znaleziono konta.');
    if (before.version !== input.version) throw new ApiError(409, 'VERSION_CONFLICT', 'Dane konta zostały zmienione. Odśwież listę.');
    const role = input.role ?? before.role;
    const active = input.active ?? before.active;
    let locationId = input.warehouseId === undefined ? before.location_id : input.warehouseId;
    if (role !== 'medic') {
      if (input.warehouseId !== undefined && input.warehouseId !== null) throw new ApiError(400, 'WAREHOUSE_NOT_ALLOWED', 'Magazyn osobisty przypisujemy wyłącznie ratownikowi.');
      locationId = null;
    } else if (active && locationId === null) throw new ApiError(400, 'WAREHOUSE_REQUIRED', 'Aktywny ratownik musi mieć przypisany magazyn.');
    // A retired account must not reserve a personal warehouse forever. Reactivation
    // requires an explicit free warehouse instead of silently taking it from a successor.
    if (!active) locationId = null;
    if (locationId !== null) await warehouseExists(client, locationId);
    if (before.active && before.role === 'admin' && before.password_hash !== null && (!active || role !== 'admin')) {
      const remaining = await client.query<{count: string}>(`SELECT count(*) FROM users WHERE active=true AND role='admin' AND password_hash IS NOT NULL AND id<>$1`, [userId]);
      if (Number(remaining.rows[0]?.count ?? 0) === 0) throw new ApiError(409, 'LAST_ADMIN_REQUIRED', 'Nie można odebrać dostępu ostatniemu aktywnemu administratorowi.');
    }
    await client.query('UPDATE users SET role=$2,active=$3,version=version+1,updated_at=now() WHERE id=$1', [userId, role, active]);
    if (locationId !== before.location_id) {
      await client.query('UPDATE user_warehouse_assignments SET valid_to=now() WHERE user_id=$1 AND valid_to IS NULL', [userId]);
      if (locationId !== null) await client.query('INSERT INTO user_warehouse_assignments(user_id,location_id) VALUES($1,$2)', [userId, locationId]);
    }
    await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
    await client.query('UPDATE password_reset_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL', [userId]);
    await audit(client, { actorId, action: 'users.updated', outcome: 'success', resourceRefs: { userId },
      details: { before: {role: before.role, active: before.active, warehouseId: before.location_id}, after: {role, active, warehouseId: locationId} } });
    const updated = await client.query<UserRow>(`${userWithWarehouseSql} WHERE u.id=$1`, [userId]);
    return userDto(updated.rows[0]!);
  }); } catch (error) {
    if ((error as {code?:string;constraint?:string}).code === '23505' && (error as {constraint?:string}).constraint === 'assignment_one_current_per_location') {
      throw new ApiError(409, 'WAREHOUSE_ASSIGNED', 'Ten magazyn ma już aktywnego ratownika.');
    }
    throw error;
  }
}
