-- Sesiones que deben cambiar la contraseña antes de usar el sistema (ingresaron con una clave por defecto).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS must_change boolean NOT NULL DEFAULT false;

-- Ventas del POS: clave de idempotencia para que un reintento (corte de red, doble toque) no duplique la venta ni descuente el stock dos veces.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS sales_idem_uq ON sales (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
