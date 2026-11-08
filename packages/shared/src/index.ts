import { z } from 'zod';

export const RoleSchema = z.enum(['medic', 'warehouse_manager', 'admin']);
export type Role = z.infer<typeof RoleSchema>;
export interface Warehouse { id: number; code: string; name: string }
export interface Actor { id: string; login: string; role: Role; warehouse: Warehouse | null }
export type User = Actor;
export const IdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const UuidSchema = z.uuid().transform(value => value.toLowerCase());
export const QuantitySchema = z.string().regex(/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,5})?$/)
  .refine(value => /[1-9]/.test(value), 'Ilość musi być większa od zera.');
export const NonNegativeQuantitySchema = z.string().regex(/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,5})?$/);
export const PolicySchema = z.object({ minimum: NonNegativeQuantitySchema, quantum: QuantitySchema }).strict();
export const DateSchema = z.iso.date();
export const LoginInputSchema = z.object({ login: z.string().trim().min(1).max(254), password: z.string().min(1).max(128) }).strict();
export const PasswordResetRequestSchema = z.object({ login: z.string().trim().min(1).max(254) }).strict();
export const PasswordResetConfirmSchema = z.object({ token: z.string().min(32).max(256), newPassword: z.string().min(12).max(128) }).strict();
export const CreateUserSchema = z.object({ login: z.string().trim().min(3).max(254), role: RoleSchema, warehouseId: IdSchema.optional() }).strict();
export const UpdateUserSchema = z.object({ version: z.number().int().positive(), active: z.boolean().optional(), role: RoleSchema.optional(), warehouseId: IdSchema.nullable().optional() }).strict();
export const ConsumptionSchema = z.object({ stockItemId: IdSchema, quantity: QuantitySchema }).strict();
export const TransferSchema = z.object({ stockItemId: IdSchema, destinationWarehouseId: IdSchema, quantity: QuantitySchema }).strict();
export const ReceiptSchema = z.object({ partId: IdSchema, warehouseId: IdSchema, quantity: QuantitySchema, lot: z.string().trim().min(1).max(100), exp: DateSchema }).strict();
export const AdjustmentSchema = z.object({ stockItemId: IdSchema, quantity: QuantitySchema, direction: z.enum(['increase', 'decrease']), reason: z.string().trim().min(5).max(500) }).strict();
export const ReconcileSchema = z.object({ resolution: z.enum(['applied', 'partial', 'not_applied']), evidenceIds: z.array(IdSchema).max(100), reason: z.string().trim().min(10).max(1000), upstreamRequestStopped: z.boolean().optional() }).strict();
export const ProblemCategorySchema = z.enum(['damage', 'expired', 'discrepancy', 'other']);
export const ProblemReportSchema = z.object({ category: ProblemCategorySchema, stockItemId: IdSchema.optional(), description: z.string().trim().min(5).max(1000) }).strict();
export const OperationStateSchema = z.enum(['PREPARED', 'DISPATCHING', 'SUCCEEDED', 'REJECTED', 'UNCERTAIN', 'DISCREPANCY', 'RECONCILED_APPLIED', 'RECONCILED_NOT_APPLIED', 'RECONCILED_PARTIAL', 'RECONCILED_DISCREPANCY']);
export type OperationState = z.infer<typeof OperationStateSchema>;
export interface Operation { id: string; state: OperationState; requestedQuantity?: string; appliedQuantity?: string; createdAt: string; updatedAt: string }
export interface StockItem {
  id: number; partId: number; name: string; quantity: string; availableQuantity: string;
  unit: string; lot: string; exp: string | null; minimum: string; warnings: string[];
  eligibleForConsumption: boolean; status?: number;
}
export type ConsumptionInput = z.infer<typeof ConsumptionSchema>;
export type ProblemReportInput = z.infer<typeof ProblemReportSchema>;
