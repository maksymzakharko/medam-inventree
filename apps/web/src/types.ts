export type Role = 'medic' | 'warehouse_manager' | 'admin';
export interface Warehouse { id: number; code: string; name: string }
export interface User {
  id: string;
  login: string;
  role: Role;
  warehouse: Warehouse | null;
  active?: boolean;
  version?: number;
}
export interface AuthResponse { user: User; csrfToken: string }
export interface StockItem {
  id: number;
  partId: number;
  name: string;
  quantity: string;
  availableQuantity: string;
  unit: string;
  lot: string | null;
  exp: string | null;
  minimum: string;
  warnings: string[];
  eligibleForConsumption: boolean;
  status?: number;
}
export type OperationState = 'PREPARED' | 'DISPATCHING' | 'SUCCEEDED' | 'REJECTED' | 'UNCERTAIN' | 'DISCREPANCY' | 'RECONCILED_APPLIED' | 'RECONCILED_PARTIAL' | 'RECONCILED_NOT_APPLIED' | 'RECONCILED_DISCREPANCY';
export interface Operation {
  id: string;
  state: OperationState;
  requestedQuantity?: string;
  appliedQuantity?: string;
  kind?: string;
  createdAt: string;
  updatedAt: string;
  stockItemId?: number;
  error?: { code?: string; message?: string };
}
export interface Page<T> { items: T[]; nextCursor?: string | null }
export interface HistoryItem {
  id: string;
  operationId: string | null;
  action: string;
  outcome: string;
  createdAt: string;
  details: Record<string, unknown>;
}
export type ProblemCategory = 'damage' | 'expired' | 'discrepancy' | 'other';
export interface ProblemReport {
  id: string;
  category: ProblemCategory;
  description: string;
  status: string;
  stockItemId: number | null;
  createdAt: string;
}
export interface Part { id: number; name: string; unit: string }
export type View = 'stock' | 'history' | 'reports' | 'movements' | 'review' | 'users' | 'account';
