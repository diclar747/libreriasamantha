-- Productos, compras, delivery, transferencias y escaneo ---------------------------------------------

-- ===== Productos
ALTER TABLE products ADD COLUMN IF NOT EXISTS short_description text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS edition text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS qr_code text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS markup_pct numeric(8,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_includes_vat boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_includes_vat boolean NOT NULL DEFAULT true;
ALTER TABLE products ADD COLUMN IF NOT EXISTS offer_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS offer_price bigint;
ALTER TABLE products ADD COLUMN IF NOT EXISTS offer_pct numeric(5,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS offer_start date;
ALTER TABLE products ADD COLUMN IF NOT EXISTS offer_end date;
ALTER TABLE products ADD COLUMN IF NOT EXISTS offer_channel text NOT NULL DEFAULT 'both';
ALTER TABLE products ADD COLUMN IF NOT EXISTS offer_label text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS low_alert_active boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_offer_channel_check;
ALTER TABLE products ADD CONSTRAINT products_offer_channel_check CHECK (offer_channel IN ('local','online','both'));
CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_uq ON products (barcode) WHERE barcode IS NOT NULL AND barcode <> '';
CREATE UNIQUE INDEX IF NOT EXISTS products_isbn_uq ON products (isbn) WHERE isbn IS NOT NULL AND isbn <> '';
CREATE UNIQUE INDEX IF NOT EXISTS products_qr_uq ON products (qr_code) WHERE qr_code IS NOT NULL AND qr_code <> '';
CREATE INDEX IF NOT EXISTS products_name_idx ON products (lower(name));

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data jsonb;

CREATE TABLE IF NOT EXISTS product_images (
  id serial PRIMARY KEY,
  product_id int NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  position int NOT NULL DEFAULT 0,
  mime text NOT NULL,
  data bytea NOT NULL,
  width int,
  height int,
  size int NOT NULL,
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_images_product_idx ON product_images(product_id, position);
CREATE TABLE IF NOT EXISTS product_suppliers (
  product_id int NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier_id int NOT NULL REFERENCES suppliers(id),
  supplier_code text,
  last_cost bigint,
  preferred boolean NOT NULL DEFAULT false,
  PRIMARY KEY (product_id, supplier_id)
);
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS stock_before int;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS stock_after int;
CREATE TABLE IF NOT EXISTS price_suggestions (
  id serial PRIMARY KEY,
  product_id int NOT NULL REFERENCES products(id),
  cost_before bigint NOT NULL,
  cost_after bigint NOT NULL,
  price_before bigint NOT NULL,
  price_suggested bigint NOT NULL,
  source text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','dismissed')),
  decided_by int REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===== Descuentos: se conserva el precio de lista, la promoción y quién autorizó
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS list_price bigint;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS promo_label text;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS discount_kind text;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS discount_pct numeric(6,2);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_kind text;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_pct numeric(6,2);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_reason text;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_approved_by int REFERENCES users(id);

-- ===== Proveedores: ficha completa
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS legal_name text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS supplier_type text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS department text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS website text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_name text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_role text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_phone text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS extra_contacts jsonb NOT NULL DEFAULT '[]';
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_condition text NOT NULL DEFAULT 'credit';
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_days int NOT NULL DEFAULT 30;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_name text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_account text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_holder text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_alias text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_ruc_uq ON suppliers (lower(ruc)) WHERE ruc IS NOT NULL AND ruc <> '';

-- ===== Órdenes de compra: estados, numeración y líneas con presentación
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check;
UPDATE purchase_orders SET status = 'issued' WHERE status = 'ordered';
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN ('draft','pending_approval','approved','issued','partial','received','closed_short','cancelled'));
ALTER TABLE purchase_orders ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS number text;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS order_date date NOT NULL DEFAULT current_date;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS expected_date date;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS receiving_place text;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'PYG';
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS reference text;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approved_by int REFERENCES users(id);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS issued_at timestamptz;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS close_note text;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS extra_costs bigint NOT NULL DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS extra_costs_note text;
UPDATE purchase_orders SET number = 'OC-' || lpad(id::text, 6, '0') WHERE number IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_number_uq ON purchase_orders(number);
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS presentation text;
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS units_per_presentation int NOT NULL DEFAULT 1;
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS discount bigint NOT NULL DEFAULT 0;
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS tax_rate int NOT NULL DEFAULT 10;
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS cost_includes_vat boolean NOT NULL DEFAULT false;
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS qty_rejected int NOT NULL DEFAULT 0;
UPDATE purchase_items pi SET units_per_presentation = p.units_per_purchase, presentation = p.purchase_unit
  FROM products p WHERE p.id = pi.product_id AND pi.presentation IS NULL;

-- ===== Recepciones de mercadería (solo lo aceptado entra al stock)
CREATE TABLE IF NOT EXISTS receptions (
  id serial PRIMARY KEY,
  number text UNIQUE,
  order_id int REFERENCES purchase_orders(id),
  supplier_id int NOT NULL REFERENCES suppliers(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  user_id int REFERENCES users(id),
  place text,
  delivery_note text,
  notes text,
  authorized_by int REFERENCES users(id),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reception_items (
  id serial PRIMARY KEY,
  reception_id int NOT NULL REFERENCES receptions(id) ON DELETE CASCADE,
  order_item_id int REFERENCES purchase_items(id),
  product_id int NOT NULL REFERENCES products(id),
  kind text NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','surplus','different')),
  qty_received int NOT NULL CHECK (qty_received >= 0),
  qty_accepted int NOT NULL CHECK (qty_accepted >= 0),
  qty_rejected int NOT NULL DEFAULT 0 CHECK (qty_rejected >= 0),
  reject_reason text,
  units_per_presentation int NOT NULL DEFAULT 1,
  unit_cost bigint NOT NULL,
  tax_rate int NOT NULL DEFAULT 10,
  invoiced_qty int NOT NULL DEFAULT 0,
  returned_qty int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS reception_items_order_idx ON reception_items(order_item_id);

-- ===== Facturas de compra y obligaciones con proveedores
CREATE TABLE IF NOT EXISTS purchase_invoices (
  id serial PRIMARY KEY,
  number text UNIQUE,
  supplier_id int NOT NULL REFERENCES suppliers(id),
  doc_type text NOT NULL DEFAULT 'invoice' CHECK (doc_type IN ('invoice','receipt')),
  doc_number text NOT NULL,
  timbrado text,
  doc_date date NOT NULL DEFAULT current_date,
  payment_condition text NOT NULL DEFAULT 'credit' CHECK (payment_condition IN ('cash','credit')),
  currency text NOT NULL DEFAULT 'PYG',
  subtotal bigint NOT NULL DEFAULT 0,
  discount bigint NOT NULL DEFAULT 0,
  extra_costs bigint NOT NULL DEFAULT 0,
  tax_total bigint NOT NULL DEFAULT 0,
  total bigint NOT NULL,
  paid bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  notes text,
  void_reason text,
  user_id int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, doc_type, doc_number)
);
CREATE TABLE IF NOT EXISTS purchase_invoice_items (
  id serial PRIMARY KEY,
  invoice_id int NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  product_id int REFERENCES products(id),
  description text NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  units_per_presentation int NOT NULL DEFAULT 1,
  unit_cost bigint NOT NULL,
  discount bigint NOT NULL DEFAULT 0,
  tax_rate int NOT NULL DEFAULT 10,
  net bigint NOT NULL,
  tax bigint NOT NULL,
  total bigint NOT NULL,
  order_item_id int REFERENCES purchase_items(id),
  reception_item_id int REFERENCES reception_items(id)
);
CREATE TABLE IF NOT EXISTS purchase_invoice_orders (
  invoice_id int NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  order_id int NOT NULL REFERENCES purchase_orders(id),
  PRIMARY KEY (invoice_id, order_id)
);
CREATE TABLE IF NOT EXISTS payables (
  id serial PRIMARY KEY,
  invoice_id int NOT NULL REFERENCES purchase_invoices(id),
  supplier_id int NOT NULL REFERENCES suppliers(id),
  number int NOT NULL DEFAULT 1,
  due_date date NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  paid bigint NOT NULL DEFAULT 0,
  credited bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','void'))
);
CREATE INDEX IF NOT EXISTS payables_supplier_idx ON payables(supplier_id, due_date);
CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
  id serial PRIMARY KEY,
  payment_id int NOT NULL REFERENCES supplier_payments(id),
  payable_id int NOT NULL REFERENCES payables(id),
  amount bigint NOT NULL CHECK (amount > 0)
);
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'payment';
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS voided boolean NOT NULL DEFAULT false;
-- Devoluciones a proveedor: la salida física y la nota de crédito son registros separados y vinculados
ALTER TABLE supplier_returns ADD COLUMN IF NOT EXISTS number text;
ALTER TABLE supplier_returns ADD COLUMN IF NOT EXISTS reception_id int REFERENCES receptions(id);
ALTER TABLE supplier_returns ADD COLUMN IF NOT EXISTS credit_status text NOT NULL DEFAULT 'none';
ALTER TABLE supplier_return_items ADD COLUMN IF NOT EXISTS reception_item_id int REFERENCES reception_items(id);
CREATE TABLE IF NOT EXISTS supplier_credit_notes (
  id serial PRIMARY KEY,
  number text UNIQUE,
  supplier_id int NOT NULL REFERENCES suppliers(id),
  return_id int REFERENCES supplier_returns(id),
  invoice_id int REFERENCES purchase_invoices(id),
  doc_number text,
  doc_date date NOT NULL DEFAULT current_date,
  amount bigint NOT NULL CHECK (amount > 0),
  vat bigint NOT NULL DEFAULT 0,
  resolution text NOT NULL CHECK (resolution IN ('applied','credit_balance','refund')),
  refund_method text,
  refund_account_id int REFERENCES money_accounts(id),
  notes text,
  user_id int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===== Delivery por ciudad (catálogo de departamentos y distritos)
CREATE TABLE IF NOT EXISTS geo_cities (
  id serial PRIMARY KEY,
  department text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (department, name)
);
CREATE TABLE IF NOT EXISTS delivery_rates (
  city_id int PRIMARY KEY REFERENCES geo_cities(id) ON DELETE CASCADE,
  covered boolean NOT NULL DEFAULT false,
  price bigint,
  eta text,
  notes text,
  special_zones jsonb NOT NULL DEFAULT '[]',
  updated_by int REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS city_id int REFERENCES geo_cities(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS city_name text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS department text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS address_reference text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tariff_source text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS carrier text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS billing_name text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS billing_ruc text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'bancard';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_note text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check CHECK (payment_status IN ('pending','in_review','approved','rejected','refunded','partially_refunded'));
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_delivery_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_delivery_status_check CHECK (delivery_status IN ('pending','preparing','ready','dispatched','delivered','incident'));

-- ===== Cuentas bancarias para cobros por transferencia y comprobantes
ALTER TABLE money_accounts ADD COLUMN IF NOT EXISTS holder text;
ALTER TABLE money_accounts ADD COLUMN IF NOT EXISTS holder_document text;
ALTER TABLE money_accounts ADD COLUMN IF NOT EXISTS account_type text;
ALTER TABLE money_accounts ADD COLUMN IF NOT EXISTS alias text;
ALTER TABLE money_accounts ADD COLUMN IF NOT EXISTS instructions text;
ALTER TABLE money_accounts ADD COLUMN IF NOT EXISTS online_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE money_accounts ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS payment_proofs (
  id serial PRIMARY KEY,
  order_id int NOT NULL REFERENCES orders(id),
  attachment_id int REFERENCES attachments(id),
  account_id int REFERENCES money_accounts(id),
  amount_declared bigint,
  reference text,
  payer_note text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by int REFERENCES users(id),
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_proofs_order_idx ON payment_proofs(order_id);

-- ===== Escaneo: teléfono vinculado como lector e inventario físico
CREATE TABLE IF NOT EXISTS scan_links (
  id serial PRIMARY KEY,
  token text UNIQUE NOT NULL,
  user_id int NOT NULL REFERENCES users(id),
  session_id int REFERENCES cash_sessions(id),
  cart_id text NOT NULL,
  purpose text NOT NULL DEFAULT 'sale',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','linked','closed')),
  phone_user_id int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  linked_at timestamptz,
  last_seen timestamptz,
  closed_at timestamptz
);
CREATE TABLE IF NOT EXISTS scan_events (
  id serial PRIMARY KEY,
  link_id int NOT NULL REFERENCES scan_links(id) ON DELETE CASCADE,
  code text NOT NULL,
  format text,
  client_event_id text,
  delivered boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (link_id, client_event_id)
);
CREATE TABLE IF NOT EXISTS inventory_counts (
  id serial PRIMARY KEY,
  number text UNIQUE,
  user_id int NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','applied','cancelled')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  applied_by int REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS inventory_count_items (
  id serial PRIMARY KEY,
  count_id int NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  product_id int NOT NULL REFERENCES products(id),
  counted int NOT NULL CHECK (counted >= 0),
  expected int NOT NULL,
  counted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (count_id, product_id)
);
