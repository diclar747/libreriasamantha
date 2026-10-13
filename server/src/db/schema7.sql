-- ===== Portal del cliente: cuentas, direcciones, favoritos y notificaciones propias
CREATE TABLE IF NOT EXISTS customer_accounts (
  id serial PRIMARY KEY,
  customer_id int REFERENCES customers(id),
  email text NOT NULL,
  password_hash text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  phone text,
  whatsapp text,
  document text,
  billing_name text,
  billing_doc text,
  email_verified boolean NOT NULL DEFAULT false,
  verify_hash text,
  verify_expires timestamptz,
  pending_email text,
  reset_hash text,
  reset_expires timestamptz,
  notif_prefs jsonb NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_accounts_email_uq ON customer_accounts (lower(email));
CREATE TABLE IF NOT EXISTS customer_sessions (
  id serial PRIMARY KEY,
  token_hash text UNIQUE NOT NULL,
  account_id int NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customer_addresses (
  id serial PRIMARY KEY,
  account_id int NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  label text,
  recipient_name text,
  recipient_phone text,
  department text,
  city_id int REFERENCES geo_cities(id),
  city_name text,
  neighborhood text,
  street text NOT NULL,
  house_number text,
  reference text,
  instructions text,
  lat numeric(9,6),
  lng numeric(9,6),
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customer_favorites (
  account_id int NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  product_id int NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, product_id)
);
CREATE TABLE IF NOT EXISTS customer_notifications (
  id serial PRIMARY KEY,
  account_id int NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  order_id int REFERENCES orders(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  dedupe_key text UNIQUE,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_notifications_idx ON customer_notifications(account_id, id DESC);

-- ===== Pedidos: cuenta, destinatario, envío, responsables e historial
ALTER TABLE orders ADD COLUMN IF NOT EXISTS account_id int REFERENCES customer_accounts(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id int REFERENCES customers(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_name text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_phone text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS neighborhood text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS preparing_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ready_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_url text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS eta_date date;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS received_by text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_note text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_request_reason text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_to int REFERENCES users(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_by int REFERENCES users(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_amount bigint NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_amount bigint NOT NULL DEFAULT 0;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
CREATE UNIQUE INDEX IF NOT EXISTS orders_idem_uq ON orders(account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_account_idx ON orders(account_id, id DESC);
UPDATE orders SET confirmed_at = created_at WHERE confirmed_at IS NULL AND payment_status IN ('approved','refunded','partially_refunded');
UPDATE orders SET paid_amount = total WHERE paid_amount = 0 AND payment_status IN ('approved','partially_refunded','refunded');

CREATE TABLE IF NOT EXISTS order_history (
  id serial PRIMARY KEY,
  order_id int NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('order','payment','delivery','note','return','shipment')),
  from_state text,
  to_state text,
  title text NOT NULL,
  note text,
  visible boolean NOT NULL DEFAULT true,
  user_id int REFERENCES users(id),
  account_id int REFERENCES customer_accounts(id),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_history_idx ON order_history(order_id, id);
CREATE TABLE IF NOT EXISTS order_notes (
  id serial PRIMARY KEY,
  order_id int NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  author_type text NOT NULL CHECK (author_type IN ('staff','customer')),
  user_id int REFERENCES users(id),
  account_id int REFERENCES customer_accounts(id),
  visible boolean NOT NULL DEFAULT false,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id serial PRIMARY KEY,
  order_id int NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  reason text NOT NULL,
  user_id int REFERENCES users(id),
  rescheduled_for date,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_returns (
  id serial PRIMARY KEY,
  number text UNIQUE,
  order_id int NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  account_id int REFERENCES customer_accounts(id),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','received','refunded','closed')),
  reason text NOT NULL,
  admin_response text,
  instructions text,
  restock boolean,
  refund_amount bigint NOT NULL DEFAULT 0,
  sale_return_id int,
  photo_attachment_ids int[] NOT NULL DEFAULT '{}',
  decided_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_return_items (
  id serial PRIMARY KEY,
  return_id int NOT NULL REFERENCES order_returns(id) ON DELETE CASCADE,
  order_item_id int NOT NULL REFERENCES order_items(id),
  qty int NOT NULL CHECK (qty > 0)
);
CREATE SEQUENCE IF NOT EXISTS order_return_seq;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp';
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS to_email text;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS subject text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS account_linked boolean NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS document text;
