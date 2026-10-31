CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text UNIQUE NOT NULL, name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh', cutover_at timestamptz,
  opening_job_id uuid, opening_state text NOT NULL DEFAULT 'NORMAL' CHECK(opening_state IN ('NORMAL','IMPORTING'))
);
CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), warehouse_id uuid NOT NULL REFERENCES warehouses,
  code text NOT NULL, name text NOT NULL, UNIQUE(warehouse_id,code), UNIQUE(id,warehouse_id)
);
CREATE TABLE vendors (code text PRIMARY KEY, name text NOT NULL, version bigint NOT NULL DEFAULT 0);
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), part_no text UNIQUE NOT NULL CHECK(length(part_no)>0),
  specification text NOT NULL, po_type text, vendor_part_no text, default_vendor_code text REFERENCES vendors(code),
  base_uom text NOT NULL DEFAULT 'PCS', version bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text UNIQUE NOT NULL, display_name text NOT NULL,
  password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('ADMIN','OPERATOR','VIEWER')), active boolean NOT NULL DEFAULT true
);
CREATE TABLE user_warehouses (user_id uuid REFERENCES users, warehouse_id uuid REFERENCES warehouses, PRIMARY KEY(user_id,warehouse_id));
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inbound_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), warehouse_id uuid NOT NULL REFERENCES warehouses,
  location_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users,
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CONFIRMED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(location_id,warehouse_id) REFERENCES locations(id,warehouse_id)
);
CREATE TABLE scanner_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), draft_id uuid NOT NULL REFERENCES inbound_drafts,
  actor_id uuid NOT NULL REFERENCES users, session_hash text NOT NULL REFERENCES sessions(token_hash),
  token_hash text UNIQUE NOT NULL, status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOKED')),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inbound_draft_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), draft_id uuid NOT NULL REFERENCES inbound_drafts,
  product_id uuid NOT NULL REFERENCES products, lot_no text NOT NULL CHECK(length(lot_no)>0),
  quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 10000000), vendor_code text NOT NULL REFERENCES vendors(code), po_type text,
  mes_pack_no text CHECK(mes_pack_no IS NULL OR length(mes_pack_no)>0), expired_date date,
  status text NOT NULL CHECK(status IN ('AWAITING_PACK_SCAN','WAITING_EXP_DATE','COMPLETE')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_draft_line_mes_pack UNIQUE(draft_id,mes_pack_no),
  CHECK((status='COMPLETE') = (mes_pack_no IS NOT NULL AND expired_date IS NOT NULL))
);
CREATE TABLE inbound_scan_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), draft_id uuid NOT NULL REFERENCES inbound_drafts,
  scan_event_id uuid NOT NULL, pairing_id uuid REFERENCES scanner_pairings, actor_id uuid NOT NULL REFERENCES users,
  request_hash text NOT NULL, raw_payload text NOT NULL, draft_line_id uuid NOT NULL REFERENCES inbound_draft_lines,
  response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT uq_scan_event UNIQUE(draft_id,scan_event_id)
);
CREATE TABLE inbound_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), warehouse_id uuid NOT NULL REFERENCES warehouses,
  draft_id uuid UNIQUE REFERENCES inbound_drafts, source_reference text NOT NULL, actor_id uuid NOT NULL REFERENCES users,
  kind text NOT NULL CHECK(kind IN ('INBOUND','OPENING_BALANCE')), import_job_id uuid,
  effective_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(warehouse_id,source_reference)
);
CREATE TABLE stock_pack_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES products,
  location_id uuid NOT NULL REFERENCES locations, lot_no text NOT NULL CHECK(length(lot_no)>0),
  mes_pack_no text UNIQUE NOT NULL CHECK(length(mes_pack_no)>0), vendor_code text NOT NULL REFERENCES vendors(code),
  mfg_date date, expired_date date NOT NULL,
  on_hand bigint NOT NULL DEFAULT 0, reserved bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE','QUARANTINE','EXPIRED','LOCKED')),
  version bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(on_hand>=0 AND reserved>=0 AND reserved<=on_hand), CHECK(mfg_date IS NULL OR mfg_date<=expired_date)
);
CREATE TABLE inbound_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), receipt_id uuid NOT NULL REFERENCES inbound_receipts,
  pack_balance_id uuid NOT NULL REFERENCES stock_pack_balances, quantity bigint NOT NULL CHECK(quantity>0),
  source_row integer, UNIQUE(receipt_id,pack_balance_id)
);
CREATE TABLE outbound_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), warehouse_id uuid NOT NULL REFERENCES warehouses,
  reference text NOT NULL, status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','RESERVED','SHIPPED','CANCELLED')),
  actor_id uuid NOT NULL REFERENCES users, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(warehouse_id,reference)
);
CREATE TABLE outbound_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES outbound_orders,
  product_id uuid NOT NULL REFERENCES products, quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 10000000),
  UNIQUE(order_id,product_id)
);
CREATE TABLE stock_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), outbound_line_id uuid NOT NULL REFERENCES outbound_lines,
  pack_balance_id uuid NOT NULL REFERENCES stock_pack_balances, quantity bigint NOT NULL CHECK(quantity>0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SHIPPED','RELEASED')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_active_reservation ON stock_reservations(outbound_line_id,pack_balance_id) WHERE status='ACTIVE';
CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pack_balance_id uuid NOT NULL REFERENCES stock_pack_balances,
  product_id uuid NOT NULL REFERENCES products, location_id uuid NOT NULL REFERENCES locations,
  quantity_delta bigint NOT NULL CHECK(quantity_delta<>0), balance_after bigint NOT NULL CHECK(balance_after>=0),
  movement_type text NOT NULL CHECK(movement_type IN ('INBOUND','OPENING_BALANCE','OUTBOUND','ADJUSTMENT','TRANSFER')),
  reference_type text NOT NULL, reference_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users,
  effective_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(pack_balance_id,reference_type,reference_id,movement_type)
);
CREATE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Ledger is append-only; use a compensating movement'; END $$;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TABLE idempotency_records (
  actor_id uuid NOT NULL REFERENCES users, operation text NOT NULL, key text NOT NULL CHECK(length(key) BETWEEN 1 AND 200),
  request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_id,operation,key)
);
CREATE TABLE import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES users, warehouse_id uuid NOT NULL REFERENCES warehouses,
  kind text NOT NULL CHECK(kind IN ('PRODUCTS','VENDORS','LOCATIONS','OPENING_BALANCE','INBOUND')),
  file_name text NOT NULL, file_hash text NOT NULL, sheet_data jsonb NOT NULL,
  mapping jsonb, options jsonb NOT NULL DEFAULT '{}', preview_version integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'UPLOADED' CHECK(status IN ('UPLOADED','MAPPED','VALIDATED','CONFIRMING','COMPLETED','PARTIAL_FAILED','FAILED')),
  summary jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES import_jobs,
  sheet text NOT NULL, source_row integer NOT NULL, original jsonb NOT NULL, normalized jsonb,
  errors jsonb NOT NULL DEFAULT '[]', warnings jsonb NOT NULL DEFAULT '[]', expected_version bigint,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','VALID','ERROR','SKIPPED','COMMITTED')),
  document_id uuid, UNIQUE(job_id,source_row)
);
CREATE TABLE import_mapping_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES users, name text NOT NULL,
  kind text NOT NULL, mapping jsonb NOT NULL, options jsonb NOT NULL DEFAULT '{}', UNIQUE(actor_id,name,kind)
);
CREATE INDEX idx_products_search ON products USING gin(part_no gin_trgm_ops,specification gin_trgm_ops);
CREATE INDEX idx_part_prefix ON products(part_no text_pattern_ops);
CREATE INDEX idx_lot_search ON stock_pack_balances USING gin(lot_no gin_trgm_ops,mes_pack_no gin_trgm_ops);
CREATE INDEX idx_fefo ON stock_pack_balances(product_id,expired_date,created_at,id) WHERE status='AVAILABLE' AND on_hand>reserved;
CREATE INDEX idx_pack_location ON stock_pack_balances(location_id);
CREATE INDEX idx_ledger_effective ON stock_movements(effective_at,product_id,location_id);
CREATE INDEX idx_ledger_pack ON stock_movements(pack_balance_id,effective_at);
CREATE INDEX idx_reservation_pack ON stock_reservations(pack_balance_id) WHERE status='ACTIVE';
CREATE INDEX idx_import_job ON import_rows(job_id);
DO $$ BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='wms_app') THEN
   GRANT USAGE ON SCHEMA public TO wms_app;
   GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO wms_app;
   REVOKE UPDATE,DELETE,TRUNCATE ON stock_movements FROM wms_app;
   REVOKE ALL ON schema_migrations FROM wms_app;
 END IF;
END $$;
