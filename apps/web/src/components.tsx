import { useEffect, useRef, type DependencyList, type ReactNode } from 'react';
import { AlertCircle, Check, ChevronRight, Clipboard, LoaderCircle, PackageOpen, X } from 'lucide-react';
import type { Operation, OperationState } from './types';

export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><span className="brand-symbol" aria-hidden="true"><i /><b /></span><span>medam<span className="brand-dot">.</span>{!compact && <small>MAGAZYN MEDYCZNY</small>}</span></div>;
}

export function Alert({ children, kind = 'error', action }: { children: ReactNode; kind?: 'error' | 'warning' | 'info' | 'success'; action?: ReactNode }) {
  return <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}><AlertCircle size={19} aria-hidden="true" /><div>{children}</div>{action && <div className="alert-action">{action}</div>}</div>;
}

export function Spinner({ label = 'Ładowanie…' }: { label?: string }) { return <div className="loading" role="status"><LoaderCircle className="spin" size={23} /><span>{label}</span></div>; }
export function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><PackageOpen size={30} strokeWidth={1.5} /></div><h3>{title}</h3><p>{children}</p>{action}</div>;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'teal' }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) { return <div className="field"><span className="field-label">{label}</span>{children}{hint && <small className="field-hint">{hint}</small>}{error && <small className="field-error">{error}</small>}</div>; }

export function Dialog({ title, children, onClose, large = false, subtitle }: { title: string; children: ReactNode; onClose: () => void; large?: boolean; subtitle?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = oldOverflow; dialog?.close(); };
  }, []);
  return <dialog ref={ref} className={`dialog ${large ? 'dialog-large' : ''}`} aria-labelledby="dialog-heading" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className="dialog-content"><div className="dialog-heading"><div><span className="eyebrow">MEDAM / MAGAZYN</span><h2 id="dialog-heading">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Zamknij okno"><X size={20} /></button></div>{children}</div></dialog>;
}

const dateFormatter = new Intl.DateTimeFormat('pl-PL', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Europe/Warsaw' });
const timestampFormatter = new Intl.DateTimeFormat('pl-PL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });
export function dateLabel(date: string | null | undefined) { if (!date) return 'Brak daty'; const parsed = new Date(`${date.slice(0, 10)}T12:00:00Z`); return Number.isNaN(parsed.getTime()) ? 'Nieprawidłowa data' : dateFormatter.format(parsed); }
export function timestampLabel(value: string | null | undefined) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : timestampFormatter.format(date); }
export function quantityLabel(value: string) { return value.replace('.', ','); }

const operationLabels: Record<OperationState, string> = {
  PREPARED: 'Przygotowana', DISPATCHING: 'Trwa weryfikacja', SUCCEEDED: 'Potwierdzono', REJECTED: 'Odrzucona',
  UNCERTAIN: 'Wymaga sprawdzenia', DISCREPANCY: 'Rozbieżność', RECONCILED_APPLIED: 'Uzgodniona',
  RECONCILED_PARTIAL: 'Częściowo zrealizowana', RECONCILED_DISCREPANCY: 'Rozbieżność rozliczona', RECONCILED_NOT_APPLIED: 'Bez zmiany stanu',
};
export const terminalStates = new Set<OperationState>(['SUCCEEDED', 'REJECTED', 'RECONCILED_APPLIED', 'RECONCILED_PARTIAL', 'RECONCILED_NOT_APPLIED', 'RECONCILED_DISCREPANCY']);
export function operationLabel(state: string) { return operationLabels[state as OperationState] ?? state; }
export function OperationBadge({ state }: { state: string }) { return <Badge tone={['SUCCEEDED', 'RECONCILED_APPLIED'].includes(state) ? 'success' : ['UNCERTAIN', 'DISCREPANCY', 'RECONCILED_PARTIAL', 'RECONCILED_DISCREPANCY'].includes(state) ? 'warning' : state === 'REJECTED' ? 'danger' : 'neutral'}>{operationLabel(state)}</Badge>; }

export function OperationResult({ operation, onCheck, checking }: { operation: Operation; onCheck: () => void; checking: boolean }) {
  const success = ['SUCCEEDED', 'RECONCILED_APPLIED'].includes(operation.state);
  const terminal = terminalStates.has(operation.state);
  return <div className="operation-result"><div className={`result-icon ${success ? 'result-success' : 'result-warning'}`}>{success ? <Check size={30} /> : <AlertCircle size={30} />}</div><OperationBadge state={operation.state} /><h3>{success ? 'Operacja została potwierdzona' : operation.state === 'RECONCILED_PARTIAL' ? 'Potwierdzono częściową realizację' : operation.state === 'RECONCILED_DISCREPANCY' ? 'Rozbieżność została rozliczona' : operation.state === 'REJECTED' || operation.state === 'RECONCILED_NOT_APPLIED' ? 'Operacja nie została wykonana' : 'Wynik wymaga sprawdzenia'}</h3><p>{success ? 'Zmiana została zweryfikowana w systemie magazynowym i zapisana w historii.' : terminal ? 'Szczegóły zostały zapisane w historii. Nie wykonano automatycznej korekty.' : 'Nie powtarzaj tej operacji. Sprawdź jej status lub skontaktuj się z osobą zarządzającą magazynem.'}</p>{operation.appliedQuantity !== undefined && <div className="result-quantity">Potwierdzona ilość <strong>{quantityLabel(operation.appliedQuantity)}</strong></div>}<div className="operation-id"><span>Identyfikator operacji</span><code>{operation.id}</code><button className="text-button" onClick={() => { void navigator.clipboard?.writeText(operation.id).catch(() => {}); }}><Clipboard size={14} /> Kopiuj</button></div>{!terminal && <button className="button button-primary" disabled={checking} onClick={onCheck}>{checking ? <LoaderCircle className="spin" size={17} /> : <ChevronRight size={17} />} Sprawdź status</button>}</div>;
}

export function useResetPage(dependencies: DependencyList, fn: () => void) { useEffect(fn, dependencies); }
