CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  username text UNIQUE NOT NULL,
  name text NOT NULL,
  role text NOT NULL,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token text PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS products (
  id serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  barcode text,
  isbn text,
  name text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'Varios',
  brand text,
  author text,
  publisher text,
  kind text NOT NULL DEFAULT 'product' CHECK (kind IN ('product','service')),
  sale_unit text NOT NULL DEFAULT 'unidad',
  purchase_unit text NOT NULL DEFAULT 'unidad',
  units_per_purchase int NOT NULL DEFAULT 1 CHECK (units_per_purchase > 0),
  cost bigint NOT NULL DEFAULT 0,
  price bigint NOT NULL DEFAULT 0,
  wholesale_price bigint,
  tax_rate int NOT NULL DEFAULT 10 CHECK (tax_rate IN (0,5,10)),
  stock int NOT NULL DEFAULT 0,
  reserved int NOT NULL DEFAULT 0,
  min_stock int NOT NULL DEFAULT 0,
  location text,
  online_visible boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_barcode_idx ON products(barcode);
CREATE INDEX IF NOT EXISTS products_isbn_idx ON products(isbn);
CREATE TABLE IF NOT EXISTS price_history (
  id serial PRIMARY KEY,
  product_id int NOT NULL REFERENCES products(id),
  field text NOT NULL,
  old_value bigint,
  new_value bigint,
  user_id int REFERENCES users(id),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS stock_movements (
  id serial PRIMARY KEY,
  product_id int NOT NULL REFERENCES products(id),
  type text NOT NULL,
  qty int NOT NULL,
  unit_cost bigint,
  ref_type text,
  ref_id int,
  reason text,
  user_id int REFERENCES users(id),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_movements_product_idx ON stock_movements(product_id, at DESC);
CREATE TABLE IF NOT EXISTS suppliers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  ruc text,
  contact text,
  phone text,
  whatsapp text,
  email text,
  terms text,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id serial PRIMARY KEY,
  supplier_id int NOT NULL REFERENCES suppliers(id),
  status text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','partial','received','cancelled')),
  notes text,
  user_id int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchase_items (
  id serial PRIMARY KEY,
  order_id int NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id int NOT NULL REFERENCES products(id),
  qty_ordered int NOT NULL CHECK (qty_ordered > 0),
  qty_received int NOT NULL DEFAULT 0,
  unit_cost bigint NOT NULL CHECK (unit_cost >= 0)
);
CREATE TABLE IF NOT EXISTS customers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  ruc text,
  phone text,
  email text,
  address text,
  credit_limit bigint NOT NULL DEFAULT 0,
  balance bigint NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cash_sessions (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  opening_float bigint NOT NULL DEFAULT 0,
  closed_at timestamptz,
  expected_cash bigint,
  counted_cash bigint,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_session_per_user ON cash_sessions(user_id) WHERE status = 'open';
CREATE TABLE IF NOT EXISTS cash_movements (
  id serial PRIMARY KEY,
  session_id int NOT NULL REFERENCES cash_sessions(id),
  type text NOT NULL CHECK (type IN ('in','out')),
  amount bigint NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS sale_number_seq;
CREATE TABLE IF NOT EXISTS sales (
  id serial PRIMARY KEY,
  number text UNIQUE NOT NULL,
  customer_id int REFERENCES customers(id),
  user_id int NOT NULL REFERENCES users(id),
  session_id int REFERENCES cash_sessions(id),
  channel text NOT NULL DEFAULT 'pos',
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','void')),
  subtotal bigint NOT NULL,
  discount bigint NOT NULL DEFAULT 0,
  total bigint NOT NULL,
  paid bigint NOT NULL DEFAULT 0,
  credit_amount bigint NOT NULL DEFAULT 0,
  change_given bigint NOT NULL DEFAULT 0,
  void_reason text,
  voided_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sale_items (
  id serial PRIMARY KEY,
  sale_id int NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id int NOT NULL REFERENCES products(id),
  name text NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  unit_price bigint NOT NULL,
  unit_cost bigint NOT NULL,
  discount bigint NOT NULL DEFAULT 0,
  tax_rate int NOT NULL,
  total bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id serial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('sale','customer_payment','refund')),
  sale_id int REFERENCES sales(id),
  customer_id int REFERENCES customers(id),
  session_id int REFERENCES cash_sessions(id),
  method text NOT NULL,
  amount bigint NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customer_ledger (
  id serial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES customers(id),
  type text NOT NULL,
  amount bigint NOT NULL,
  sale_id int REFERENCES sales(id),
  note text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS held_sales (
  id serial PRIMARY KEY,
  kind text NOT NULL DEFAULT 'hold' CHECK (kind IN ('hold','quote')),
  label text,
  user_id int REFERENCES users(id),
  cart jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_log (
  id serial PRIMARY KEY,
  user_id int REFERENCES users(id),
  action text NOT NULL,
  entity text,
  entity_id int,
  detail jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
