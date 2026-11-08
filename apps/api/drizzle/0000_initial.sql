CREATE TABLE roles (
  id text PRIMARY KEY CHECK (id IN ('medic', 'warehouse_manager', 'admin'))
);
INSERT INTO roles(id) VALUES ('medic'), ('warehouse_manager'), ('admin');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login varchar(254) NOT NULL UNIQUE CHECK (login = lower(btrim(login)) AND char_length(login) >= 3),
  password_hash text,
  role text NOT NULL REFERENCES roles(id),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  password_version integer NOT NULL DEFAULT 1 CHECK (password_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouse_mappings (
  location_id integer PRIMARY KEY CHECK (location_id > 0),
  code varchar(16) NOT NULL UNIQUE CHECK (code ~ '^MAG-(0[0-9]|1[01])$'),
  name varchar(128) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  instance_key text NOT NULL DEFAULT 'primary'
);

CREATE TABLE user_warehouse_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  location_id integer NOT NULL REFERENCES warehouse_mappings(location_id),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX assignment_one_current_per_user ON user_warehouse_assignments(user_id) WHERE valid_to IS NULL;
CREATE INDEX assignment_location_idx ON user_warehouse_assignments(location_id) WHERE valid_to IS NULL;

CREATE TABLE sessions (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  password_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX session_user_idx ON sessions(user_id);
CREATE INDEX session_expiry_idx ON sessions(expires_at);

CREATE TABLE password_reset_tokens (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX reset_user_idx ON password_reset_tokens(user_id);

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL,
  key uuid NOT NULL,
  request_hash char(64) NOT NULL,
  state text NOT NULL CHECK (state IN (
    'PREPARED','DISPATCHING','SUCCEEDED','REJECTED','UNCERTAIN','DISCREPANCY',
    'RECONCILED_APPLIED','RECONCILED_NOT_APPLIED','RECONCILED_PARTIAL'
  )),
  request jsonb NOT NULL,
  response jsonb,
  upstream_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id,kind,key),
  CHECK(id = key)
);
CREATE INDEX operation_state_idx ON idempotency_records(state,updated_at);
CREATE INDEX operation_actor_idx ON idempotency_records(actor_id,created_at DESC,id);

CREATE TABLE inventory_mutation_gate (
  id text PRIMARY KEY CHECK (id = 'inventory'),
  operation_id uuid REFERENCES idempotency_records(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO inventory_mutation_gate(id) VALUES ('inventory');

CREATE TABLE application_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid REFERENCES idempotency_records(id),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  resource_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_actor_idx ON application_audit_events(actor_id,created_at DESC,id);
CREATE INDEX audit_operation_idx ON application_audit_events(operation_id);

CREATE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'application audit is append only';
END;
$$;
CREATE TRIGGER application_audit_immutable BEFORE UPDATE OR DELETE ON application_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

CREATE TABLE problem_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id),
  location_id integer NOT NULL REFERENCES warehouse_mappings(location_id),
  stock_item_id integer CHECK (stock_item_id > 0),
  category text NOT NULL CHECK (category IN ('damage','expired','discrepancy','other')),
  description varchar(1000) NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  idempotency_key uuid NOT NULL,
  request_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(reporter_id,idempotency_key)
);
CREATE INDEX problem_reporter_idx ON problem_reports(reporter_id,created_at DESC,id);

CREATE TABLE warehouse_product_policies (
  location_id integer NOT NULL REFERENCES warehouse_mappings(location_id),
  part_id integer NOT NULL CHECK (part_id > 0),
  minimum numeric(15,5) NOT NULL DEFAULT 0 CHECK (minimum >= 0),
  quantum numeric(15,5) NOT NULL DEFAULT 1 CHECK (quantum > 0),
  PRIMARY KEY(location_id,part_id)
);

CREATE TABLE login_rate_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0)
);
