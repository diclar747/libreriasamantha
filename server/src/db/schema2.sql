ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS balance bigint NOT NULL DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_number text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS slug text;

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

-- Contabilidad
CREATE TABLE IF NOT EXISTS accounts (
  id serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS journal_entries (
  id serial PRIMARY KEY,
  date date NOT NULL DEFAULT current_date,
  description text NOT NULL,
  ref_type text,
  ref_id int,
  reversal_of int REFERENCES journal_entries(id),
  user_id int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS journal_ref_idx ON journal_entries(ref_type, ref_id);
CREATE TABLE IF NOT EXISTS journal_lines (
  id serial PRIMARY KEY,
  entry_id int NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id int NOT NULL REFERENCES accounts(id),
  debit bigint NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit bigint NOT NULL DEFAULT 0 CHECK (credit >= 0)
);
CREATE INDEX IF NOT EXISTS journal_lines_account_idx ON journal_lines(account_id);

-- Facturación
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq;
CREATE SEQUENCE IF NOT EXISTS credit_note_number_seq;
CREATE TABLE IF NOT EXISTS invoices (
  id serial PRIMARY KEY,
  sale_id int REFERENCES sales(id),
  kind text NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice','credit_note')),
  number text NOT NULL,
  related_invoice_id int REFERENCES invoices(id),
  customer_name text NOT NULL,
  customer_ruc text,
  total bigint NOT NULL,
  tax10 bigint NOT NULL DEFAULT 0,
  tax5 bigint NOT NULL DEFAULT 0,
  exempt bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  cdc text,
  error text,
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id serial PRIMARY KEY,
  supplier_id int NOT NULL REFERENCES suppliers(id),
  amount bigint NOT NULL CHECK (amount > 0),
  method text NOT NULL,
  note text,
  user_id int REFERENCES users(id),
  at timestamptz NOT NULL DEFAULT now()
);

-- Servicios de impresión
CREATE SEQUENCE IF NOT EXISTS work_order_seq;
CREATE TABLE IF NOT EXISTS work_orders (
  id serial PRIMARY KEY,
  number text UNIQUE NOT NULL,
  customer_id int REFERENCES customers(id),
  customer_name text,
  phone text,
  description text NOT NULL,
  copies int NOT NULL DEFAULT 1 CHECK (copies > 0),
  pages int NOT NULL DEFAULT 1 CHECK (pages > 0),
  color boolean NOT NULL DEFAULT false,
  paper text NOT NULL DEFAULT 'A4',
  finishing text,
  file_name text,
  price bigint NOT NULL DEFAULT 0,
  deposit bigint NOT NULL DEFAULT 0,
  due_date date,
  status text NOT NULL DEFAULT 'quote' CHECK (status IN ('quote','approved','in_progress','ready','delivered','cancelled')),
  source text NOT NULL DEFAULT 'local',
  sale_id int REFERENCES sales(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Tienda en línea, pedidos y pagos
CREATE SEQUENCE IF NOT EXISTS order_number_seq;
CREATE TABLE IF NOT EXISTS delivery_zones (
  id serial PRIMARY KEY,
  name text NOT NULL,
  fee bigint NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS orders (
  id serial PRIMARY KEY,
  number text UNIQUE NOT NULL,
  channel text NOT NULL DEFAULT 'web',
  customer_name text NOT NULL,
  phone text,
  email text,
  ruc text,
  delivery_method text NOT NULL DEFAULT 'pickup' CHECK (delivery_method IN ('pickup','delivery')),
  address text,
  zone_id int REFERENCES delivery_zones(id),
  delivery_fee bigint NOT NULL DEFAULT 0,
  subtotal bigint NOT NULL,
  total bigint NOT NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('draft','confirmed','cancelled','completed')),
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','approved','rejected','refunded','partially_refunded')),
  delivery_status text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','preparing','ready','dispatched','delivered')),
  reserve_expires_at timestamptz,
  reservation_active boolean NOT NULL DEFAULT false,
  exception text,
  sale_id int REFERENCES sales(id),
  lookup_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items (
  id serial PRIMARY KEY,
  order_id int NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id int NOT NULL REFERENCES products(id),
  name text NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  unit_price bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_attempts (
  id serial PRIMARY KEY,
  order_id int NOT NULL REFERENCES orders(id),
  provider text NOT NULL,
  provider_ref text UNIQUE NOT NULL,
  amount bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);

-- Mensajería (Winsap), chatbot y reposición
CREATE TABLE IF NOT EXISTS outbox (
  id serial PRIMARY KEY,
  to_phone text,
  audience text NOT NULL DEFAULT 'customer',
  body text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  dedupe_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE TABLE IF NOT EXISTS chat_sessions (
  id serial PRIMARY KEY,
  channel text NOT NULL,
  external_id text NOT NULL,
  state jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id serial PRIMARY KEY,
  session_id int NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role text NOT NULL,
  body text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS replenishments (
  id serial PRIMARY KEY,
  product_id int NOT NULL REFERENCES products(id),
  suggested_qty int NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','requested','received','dismissed')),
  supplier_id int REFERENCES suppliers(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_replenishment ON replenishments(product_id) WHERE status IN ('open','requested');

-- Listas escolares
CREATE TABLE IF NOT EXISTS school_lists (
  id serial PRIMARY KEY,
  school text NOT NULL,
  grade text NOT NULL,
  year int NOT NULL DEFAULT 2026,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS school_list_items (
  id serial PRIMARY KEY,
  list_id int NOT NULL REFERENCES school_lists(id) ON DELETE CASCADE,
  product_id int NOT NULL REFERENCES products(id),
  qty int NOT NULL DEFAULT 1 CHECK (qty > 0)
);

-- Facturas y notas de crédito llevan numeración independiente
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_kind_number_idx ON invoices(kind, number);

-- Área de prompts del asistente (instrucciones y conocimiento editable)
CREATE TABLE IF NOT EXISTS ai_prompts (
  id serial PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  title text NOT NULL,
  kind text NOT NULL DEFAULT 'knowledge' CHECK (kind IN ('system','rules','knowledge')),
  content text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 100,
  updated_by int REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Perfil de usuario, secretos cifrados, notificaciones y push
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_prefs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_read_id int NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS secrets (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notifications (
  id serial PRIMARY KEY,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  perm text NOT NULL,
  dedupe_key text UNIQUE,
  pushed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_unpushed_idx ON notifications(id) WHERE pushed_at IS NULL;
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text UNIQUE NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
