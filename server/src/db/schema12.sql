-- Módulo de Facturación electrónica: cancelación (evento SIFEN), notas de crédito/débito con motivo,
-- re-facturación y trazabilidad. Migración aditiva: no borra datos.

-- Tipos y estados nuevos: nota de débito y documento cancelado.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_kind_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_kind_check CHECK (kind IN ('invoice','credit_note','debit_note'));
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check CHECK (status IN ('pending','approved','rejected','cancelled'));
CREATE SEQUENCE IF NOT EXISTS debit_note_number_seq;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS approved_at timestamptz;      -- desde acá corre el plazo de 48 h para cancelar
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancelled_by int REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancel_reason text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancel_protocol text;         -- protocolo SIFEN del evento de cancelación
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS motive int;                   -- motivo NC/ND (1-8, tabla E401 de SIFEN)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reason text;                  -- explicación libre de la NC/ND
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS lines jsonb;                  -- ítems propios de la NC/ND (si no, se usan los de la venta)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS return_id int REFERENCES sale_returns(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_id int REFERENCES customers(id); -- receptor elegido (re-facturación); si no, el de la venta
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_by int REFERENCES users(id);

-- Las aprobadas antes de esta versión: se toma la fecha de creación como aprobación (se aprueban al instante).
UPDATE invoices SET approved_at = created_at WHERE status = 'approved' AND approved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_sale ON invoices (sale_id);

-- Cobro de una nota de débito (interés, flete, ajuste) como movimiento de dinero propio.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_kind_check;
ALTER TABLE payments ADD CONSTRAINT payments_kind_check CHECK (kind IN ('sale','customer_payment','refund','return','debit_note'));

-- Nota de crédito por importe (descuento, bonificación, incobrable): se registra como devolución sin mercadería.
ALTER TABLE sale_returns ADD COLUMN IF NOT EXISTS motive int;
ALTER TABLE sale_returns ADD COLUMN IF NOT EXISTS concept text;
