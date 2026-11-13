-- Preserve a verified exceptional effect without calling it a complete success.
ALTER TABLE idempotency_records DROP CONSTRAINT idempotency_records_state_check;
ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_records_state_check CHECK (state IN (
  'PREPARED','DISPATCHING','SUCCEEDED','REJECTED','UNCERTAIN','DISCREPANCY',
  'RECONCILED_APPLIED','RECONCILED_NOT_APPLIED','RECONCILED_PARTIAL','RECONCILED_DISCREPANCY'
));
