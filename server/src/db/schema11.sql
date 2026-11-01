-- Campañas push de marketing: notificaciones a los visitantes de la tienda + pop-up de oferta al abrir la página.
-- Separado del push interno del equipo (push_subscriptions): aquí la audiencia es anónima (visitantes que aceptaron recibir ofertas).

CREATE TABLE IF NOT EXISTS push_audience (
  id serial PRIMARY KEY,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  account_id int,            -- si en ese momento estaba logueado como cliente; opcional, solo referencia
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_campaigns (
  id serial PRIMARY KEY,
  name text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  image_url text,                                        -- imagen de la oferta (URL de /api/shop/img/:id o externa)
  link text,                                             -- a dónde lleva el clic (producto, categoría o la tienda)
  product_id int REFERENCES products(id) ON DELETE SET NULL,  -- producto en oferta asociado (trae precio y foto)
  send_push boolean NOT NULL DEFAULT true,               -- envía notificación push al disparar la campaña
  show_popup boolean NOT NULL DEFAULT true,              -- aparece como pop-up al abrir la tienda
  starts_at timestamptz,                                 -- vigencia del pop-up (NULL = desde ya)
  ends_at timestamptz,                                   -- vigencia del pop-up (NULL = sin fin)
  priority int NOT NULL DEFAULT 0,                       -- orden del pop-up cuando hay varias campañas vigentes
  status text NOT NULL DEFAULT 'draft',                  -- draft | scheduled | active | sent | archived
  sent_at timestamptz,
  sent_count int NOT NULL DEFAULT 0,
  fail_count int NOT NULL DEFAULT 0,
  created_by int,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_campaigns_live ON push_campaigns (status, show_popup, priority DESC);

-- Imágenes de las campañas (se sirven por URL pública para que la notificación push pueda mostrarlas).
CREATE TABLE IF NOT EXISTS campaign_images (
  id serial PRIMARY KEY,
  data bytea NOT NULL,
  width int,
  height int,
  created_at timestamptz NOT NULL DEFAULT now()
);
