-- Delivery completo: todas las ciudades con tarifa general, delivery gratis, historial de cambios y copia de la tarifa en el pedido.
ALTER TABLE delivery_rates ALTER COLUMN covered SET DEFAULT true;
ALTER TABLE delivery_rates ADD COLUMN IF NOT EXISTS free_mode text NOT NULL DEFAULT 'global';
ALTER TABLE delivery_rates ADD COLUMN IF NOT EXISTS free_from bigint;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'delivery_rates_free_mode_chk') THEN
    ALTER TABLE delivery_rates ADD CONSTRAINT delivery_rates_free_mode_chk CHECK (free_mode IN ('global', 'never', 'amount', 'always'));
  END IF;
END $$;

-- Lo que se cobró al cliente queda guardado en el pedido: cambiar la tarifa después no altera pedidos anteriores.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_base_fee bigint;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_free_reason text;
UPDATE orders SET delivery_base_fee = delivery_fee WHERE delivery_base_fee IS NULL AND delivery_method = 'delivery';

CREATE TABLE IF NOT EXISTS delivery_rate_history (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id int REFERENCES users(id),
  scope text NOT NULL,
  department text,
  city_id int REFERENCES geo_cities(id) ON DELETE SET NULL,
  city_name text,
  field text NOT NULL,
  old_value text,
  new_value text,
  note text
);
CREATE INDEX IF NOT EXISTS delivery_rate_history_at_idx ON delivery_rate_history (at DESC);
CREATE INDEX IF NOT EXISTS delivery_rate_history_city_idx ON delivery_rate_history (city_id);
CREATE INDEX IF NOT EXISTS orders_city_idx ON orders (city_id);

-- Un mismo envío (doble clic, reintento) nunca genera dos pedidos: la clave es única por cliente (o por invitado).
CREATE UNIQUE INDEX IF NOT EXISTS orders_idem_guest_uq ON orders (COALESCE(account_id, 0), idempotency_key) WHERE idempotency_key IS NOT NULL;
