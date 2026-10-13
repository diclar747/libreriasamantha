-- Módulo de finanzas, caja y reportes ------------------------------------------------------------

-- Fecha local de Paraguay (UTC-3) para agrupar y filtrar por día.
CREATE OR REPLACE FUNCTION local_date(ts timestamptz) RETURNS date
LANGUAGE sql IMMUTABLE AS $$ SELECT ((ts AT TIME ZONE 'UTC') - interval '3 hours')::date $$;

-- Cajas y cuentas bancarias
CREATE TABLE IF NOT EXISTS money_accounts (
  id serial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('cash','bank')),
  name text NOT NULL,
  bank_name text,
  account_number text,
  currency text NOT NULL DEFAULT 'PYG',
  opening_balance bigint NOT NULL DEFAULT 0,
  opening_date date NOT NULL DEFAULT current_date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, name)
);

-- Cobros: detalle por medio de pago, comisión y liquidación
ALTER TABLE payments ADD COLUMN IF NOT EXISTS account_id int REFERENCES money_accounts(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reference text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS user_id int REFERENCES users(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS fee bigint NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS settlement_status text NOT NULL DEFAULT 'none' CHECK (settlement_status IN ('none','pending','settled','rejected'));
ALTER TABLE payments ADD COLUMN IF NOT EXISTS settled_at timestamptz;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS settled_account_id int REFERENCES money_accounts(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS settled_fee bigint;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_kind_check;
ALTER TABLE payments ADD CONSTRAINT payments_kind_check CHECK (kind IN ('sale','customer_payment','refund','return'));
CREATE INDEX IF NOT EXISTS payments_at_idx ON payments(at);

-- Cuotas de ventas a crédito y su aplicación a cobros
CREATE TABLE IF NOT EXISTS installments (
  id serial PRIMARY KEY,
  sale_id int REFERENCES sales(id),
  customer_id int NOT NULL REFERENCES customers(id),
  number int NOT NULL DEFAULT 1,
  due_date date NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  paid bigint NOT NULL DEFAULT 0,
  credited bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS installments_customer_idx ON installments(customer_id, due_date);
CREATE TABLE IF NOT EXISTS payment_applications (
  id serial PRIMARY KEY,
  payment_id int NOT NULL REFERENCES payments(id),
  installment_id int NOT NULL REFERENCES installments(id),
  amount bigint NOT NULL
);

-- Devoluciones de clientes (totales o parciales)
CREATE TABLE IF NOT EXISTS sale_returns (
  id serial PRIMARY KEY,
  number text UNIQUE NOT NULL,
  sale_id int NOT NULL REFERENCES sales(id),
  user_id int NOT NULL REFERENCES users(id),
  session_id int REFERENCES cash_sessions(id),
  reason text NOT NULL,
  restock boolean NOT NULL DEFAULT true,
  total bigint NOT NULL,
  applied_to_debt bigint NOT NULL DEFAULT 0,
  refunded bigint NOT NULL DEFAULT 0,
  refund_method text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS sale_return_seq;
CREATE TABLE IF NOT EXISTS sale_return_items (
  id serial PRIMARY KEY,
  return_id int NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
  sale_item_id int NOT NULL REFERENCES sale_items(id),
  product_id int NOT NULL REFERENCES products(id),
  qty int NOT NULL CHECK (qty > 0),
  amount bigint NOT NULL
);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS returned_total bigint NOT NULL DEFAULT 0;

-- Gastos, categorías y gastos recurrentes
CREATE TABLE IF NOT EXISTS expense_categories (
  id serial PRIMARY KEY,
  parent_id int REFERENCES expense_categories(id),
  name text NOT NULL,
  account_code text,
  active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 100
);
CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_name_idx ON expense_categories (COALESCE(parent_id, 0), lower(name));
CREATE TABLE IF NOT EXISTS recurring_expenses (
  id serial PRIMARY KEY,
  concept text NOT NULL,
  category_id int NOT NULL REFERENCES expense_categories(id),
  beneficiary text,
  amount bigint NOT NULL CHECK (amount > 0),
  frequency text NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly','monthly','yearly')),
  next_date date NOT NULL,
  active boolean NOT NULL DEFAULT true,
  user_id int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS expenses (
  id serial PRIMARY KEY,
  number text UNIQUE NOT NULL,
  category_id int NOT NULL REFERENCES expense_categories(id),
  concept text NOT NULL,
  beneficiary text,
  supplier_id int REFERENCES suppliers(id),
  amount bigint NOT NULL CHECK (amount > 0),
  expense_date date NOT NULL DEFAULT current_date,
  due_date date,
  paid_amount bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','partial','paid','void')),
  document_number text,
  recurring_id int REFERENCES recurring_expenses(id),
  notes text,
  user_id int REFERENCES users(id),
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS expense_seq;
CREATE INDEX IF NOT EXISTS expenses_date_idx ON expenses(expense_date);
CREATE TABLE IF NOT EXISTS expense_payments (
  id serial PRIMARY KEY,
  expense_id int NOT NULL REFERENCES expenses(id),
  amount bigint NOT NULL CHECK (amount > 0),
  method text NOT NULL,
  account_id int REFERENCES money_accounts(id),
  session_id int REFERENCES cash_sessions(id),
  reference text,
  kind text NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','fee_deducted')),
  notes text,
  user_id int REFERENCES users(id),
  voided boolean NOT NULL DEFAULT false,
  paid_at timestamptz NOT NULL DEFAULT now()
);

-- Otros movimientos de dinero: transferencias, aportes y retiros del propietario, ajustes
CREATE TABLE IF NOT EXISTS money_movements (
  id serial PRIMARY KEY,
  number text UNIQUE NOT NULL,
  kind text NOT NULL CHECK (kind IN ('transfer','owner_contribution','owner_withdrawal','adjustment_in','adjustment_out')),
  amount bigint NOT NULL CHECK (amount > 0),
  account_id int NOT NULL REFERENCES money_accounts(id),
  to_account_id int REFERENCES money_accounts(id),
  concept text NOT NULL,
  reference text,
  notes text,
  session_id int REFERENCES cash_sessions(id),
  user_id int REFERENCES users(id),
  approved_by int REFERENCES users(id),
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS money_movement_seq;

-- Comprobantes de respaldo (facturas, recibos, transferencias)
CREATE TABLE IF NOT EXISTS attachments (
  id serial PRIMARY KEY,
  owner_type text NOT NULL,
  owner_id int NOT NULL,
  filename text NOT NULL,
  mime text NOT NULL,
  size int NOT NULL,
  data bytea NOT NULL,
  note text,
  uploaded_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_owner_idx ON attachments(owner_type, owner_id);

-- Caja: turnos, denominaciones, arqueos parciales, depósito y reserva
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS shift text;
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS account_id int REFERENCES money_accounts(id);
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS opening_denominations jsonb;
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS opening_note text;
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS closing_denominations jsonb;
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS close_note text;
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS deposit_amount bigint NOT NULL DEFAULT 0;
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS deposit_account_id int REFERENCES money_accounts(id);
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS reserve_amount bigint NOT NULL DEFAULT 0;
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS closed_by int REFERENCES users(id);
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS diff_status text NOT NULL DEFAULT 'none' CHECK (diff_status IN ('none','pending_approval','approved'));
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS diff_approved_by int REFERENCES users(id);
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS diff_note text;
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS reopen_count int NOT NULL DEFAULT 0;
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'manual';
CREATE TABLE IF NOT EXISTS cash_counts (
  id serial PRIMARY KEY,
  session_id int NOT NULL REFERENCES cash_sessions(id),
  kind text NOT NULL DEFAULT 'partial' CHECK (kind IN ('partial','final')),
  expected bigint NOT NULL,
  counted bigint NOT NULL,
  denominations jsonb,
  note text,
  user_id int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Compras: condición de pago, vencimiento, pagos asociados y devoluciones a proveedores
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS payment_condition text NOT NULL DEFAULT 'credit' CHECK (payment_condition IN ('cash','credit'));
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_date date;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS order_id int REFERENCES purchase_orders(id);
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS account_id int REFERENCES money_accounts(id);
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS session_id int REFERENCES cash_sessions(id);
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS reference text;
CREATE TABLE IF NOT EXISTS supplier_returns (
  id serial PRIMARY KEY,
  supplier_id int NOT NULL REFERENCES suppliers(id),
  order_id int REFERENCES purchase_orders(id),
  reason text NOT NULL,
  total bigint NOT NULL,
  user_id int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS supplier_return_items (
  id serial PRIMARY KEY,
  return_id int NOT NULL REFERENCES supplier_returns(id) ON DELETE CASCADE,
  product_id int NOT NULL REFERENCES products(id),
  qty int NOT NULL CHECK (qty > 0),
  unit_cost bigint NOT NULL
);

-- Tienda online: cupones, costo real de entrega y comisión de la pasarela
CREATE TABLE IF NOT EXISTS coupons (
  id serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  kind text NOT NULL CHECK (kind IN ('percent','amount')),
  value bigint NOT NULL CHECK (value > 0),
  min_total bigint NOT NULL DEFAULT 0,
  max_uses int,
  used_count int NOT NULL DEFAULT 0,
  valid_to date,
  active boolean NOT NULL DEFAULT true
);
ALTER TABLE delivery_zones ADD COLUMN IF NOT EXISTS cost bigint NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount bigint NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_cost bigint NOT NULL DEFAULT 0;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS fee bigint NOT NULL DEFAULT 0;
