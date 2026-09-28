CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (name IN ('operator', 'inventory', 'manager', 'administrator')),
  permissions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique ON users (lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  csrf_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY,
  legacy_id bigint UNIQUE,
  club text NOT NULL,
  model text NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS products_business_key_unique ON products (lower(club), lower(model));

CREATE TABLE IF NOT EXISTS product_variants (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  legacy_id bigint UNIQUE,
  type text NOT NULL CHECK (type IN ('Masculina', 'Feminina', 'Infantil')),
  size text NOT NULL,
  sku text NOT NULL UNIQUE,
  sale_price numeric(14,2) NOT NULL CHECK (sale_price >= 0),
  current_cost numeric(14,2) NOT NULL CHECK (current_cost >= 0),
  stock_quantity integer NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  low_stock_threshold integer NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  last_stock_entry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, type, size)
);

CREATE INDEX IF NOT EXISTS product_variants_product_idx ON product_variants (product_id);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY,
  legacy_id bigint UNIQUE,
  name text NOT NULL,
  contact text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales (
  id uuid PRIMARY KEY,
  legacy_id bigint UNIQUE,
  customer_id uuid REFERENCES customers(id) ON DELETE RESTRICT,
  operator_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('paid', 'pending', 'partially_paid', 'reversed')),
  subtotal_amount numeric(14,2) NOT NULL CHECK (subtotal_amount >= 0),
  discount_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  final_amount numeric(14,2) NOT NULL CHECK (final_amount >= 0),
  payment_due_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (discount_amount <= subtotal_amount),
  CHECK (final_amount = subtotal_amount - discount_amount),
  CHECK (status NOT IN ('pending', 'partially_paid') OR (customer_id IS NOT NULL AND payment_due_date IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS sales_created_at_idx ON sales (created_at DESC);
CREATE INDEX IF NOT EXISTS sales_customer_idx ON sales (customer_id);

CREATE TABLE IF NOT EXISTS sale_items (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  unit_cost numeric(14,2) NOT NULL CHECK (unit_cost >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sale_items_sale_idx ON sale_items (sale_id);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  received_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL CHECK (method IN ('cash', 'pix', 'debit_card', 'credit_card', 'bank_transfer', 'other')),
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'reversed')),
  idempotency_key text NOT NULL UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_sale_idx ON payments (sale_id, received_at);

CREATE TABLE IF NOT EXISTS exchanges (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  operator_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exchange_items (
  id uuid PRIMARY KEY,
  exchange_id uuid NOT NULL REFERENCES exchanges(id) ON DELETE RESTRICT,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK (direction IN ('returned', 'delivered')),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  unit_cost numeric(14,2) NOT NULL CHECK (unit_cost >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suppliers (
  id uuid PRIMARY KEY,
  legacy_name text,
  name text NOT NULL,
  contact text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS suppliers_name_lower_unique ON suppliers (lower(name));

CREATE TABLE IF NOT EXISTS purchase_orders (
  id uuid PRIMARY KEY,
  legacy_id bigint UNIQUE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'placed', 'partially_received', 'fully_received', 'cancelled')),
  ordered_on date NOT NULL,
  estimated_items_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (estimated_items_amount >= 0),
  import_fee_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (import_fee_amount >= 0),
  final_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (final_amount >= 0),
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'cancelled' OR length(trim(cancellation_reason)) > 0)
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id uuid PRIMARY KEY,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  ordered_quantity integer NOT NULL CHECK (ordered_quantity > 0),
  received_quantity integer NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  supplier_unit_cost numeric(14,2) NOT NULL CHECK (supplier_unit_cost >= 0),
  final_unit_cost numeric(14,2) CHECK (final_unit_cost >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (received_quantity <= ordered_quantity),
  UNIQUE (purchase_order_id, variant_id)
);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id uuid PRIMARY KEY,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  received_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  notes text,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS goods_receipt_items (
  id uuid PRIMARY KEY,
  goods_receipt_id uuid NOT NULL REFERENCES goods_receipts(id) ON DELETE RESTRICT,
  purchase_order_item_id uuid NOT NULL REFERENCES purchase_order_items(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  final_unit_cost numeric(14,2) NOT NULL CHECK (final_unit_cost >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (goods_receipt_id, purchase_order_item_id)
);

CREATE TABLE IF NOT EXISTS customer_orders (
  id uuid PRIMARY KEY,
  legacy_id bigint UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  variant_id uuid REFERENCES product_variants(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  club text NOT NULL,
  model text NOT NULL,
  type text NOT NULL CHECK (type IN ('Masculina', 'Feminina', 'Infantil')),
  size text NOT NULL,
  notes text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'supplier_ordered', 'product_arrived', 'delivered', 'cancelled')),
  cancellation_reason text,
  linked_purchase_order_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'cancelled' OR length(trim(cancellation_reason)) > 0)
);

CREATE TABLE IF NOT EXISTS customer_order_events (
  id uuid PRIMARY KEY,
  customer_order_id uuid NOT NULL REFERENCES customer_orders(id) ON DELETE RESTRICT,
  from_status text,
  to_status text NOT NULL,
  reason text,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id uuid PRIMARY KEY,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  type text NOT NULL CHECK (type IN ('opening_balance', 'purchase_receipt', 'sale', 'exchange_in', 'exchange_out', 'manual_adjustment', 'reversal')),
  quantity_delta integer NOT NULL CHECK (quantity_delta <> 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  unit_cost numeric(14,2) CHECK (unit_cost >= 0),
  reason text,
  source_entity_type text,
  source_entity_id uuid,
  idempotency_key text UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (type <> 'manual_adjustment' OR length(trim(reason)) > 0)
);

CREATE INDEX IF NOT EXISTS inventory_movements_variant_idx ON inventory_movements (variant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS media (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  storage_key text NOT NULL UNIQUE,
  original_name text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  checksum_sha256 char(64) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_sync_runs (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed')),
  started_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  details jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id uuid PRIMARY KEY,
  scope text NOT NULL,
  key text NOT NULL,
  request_hash char(64) NOT NULL,
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (scope, key)
);

CREATE TABLE IF NOT EXISTS migration_runs (
  id uuid PRIMARY KEY,
  source_name text NOT NULL,
  source_checksum char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  counts jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (source_name, source_checksum)
);

CREATE TABLE IF NOT EXISTS migration_rejections (
  id uuid PRIMARY KEY,
  migration_run_id uuid NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
  source_table text NOT NULL,
  legacy_id text,
  reason_code text NOT NULL,
  reason text NOT NULL,
  source_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO roles (id, name, permissions) VALUES
  ('00000000-0000-4000-8000-000000000001', 'operator', ARRAY['sales:create', 'sales:read', 'inventory:read', 'customers:read', 'customers:create']),
  ('00000000-0000-4000-8000-000000000002', 'inventory', ARRAY['inventory:read', 'inventory:write', 'inventory:adjust', 'products:write', 'purchases:read', 'purchases:receive']),
  ('00000000-0000-4000-8000-000000000003', 'manager', ARRAY['sales:create', 'sales:read', 'sales:discount', 'sales:payment', 'sales:exchange', 'inventory:read', 'inventory:adjust', 'products:write', 'purchases:write', 'purchases:receive', 'customer_orders:write', 'reports:read', 'catalog:write']),
  ('00000000-0000-4000-8000-000000000004', 'administrator', ARRAY['*'])
ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions;
