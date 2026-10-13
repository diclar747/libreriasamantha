-- Plan de cuentas base (a validar con el contador)
INSERT INTO accounts (code, name, type) VALUES
  ('1.1.01', 'Caja', 'asset'),
  ('1.1.02', 'Bancos', 'asset'),
  ('1.1.03', 'Tarjetas a cobrar', 'asset'),
  ('1.1.04', 'Clientes', 'asset'),
  ('1.1.05', 'Mercaderías', 'asset'),
  ('1.1.06', 'IVA crédito fiscal', 'asset'),
  ('1.1.07', 'Cheques a depositar', 'asset'),
  ('2.1.01', 'Proveedores', 'liability'),
  ('2.1.02', 'IVA débito fiscal', 'liability'),
  ('2.1.03', 'Anticipos de clientes', 'liability'),
  ('3.1.01', 'Capital', 'equity'),
  ('3.1.02', 'Resultados acumulados', 'equity'),
  ('4.1.01', 'Ventas', 'income'),
  ('4.2.01', 'Otros ingresos', 'income'),
  ('5.1.01', 'Costo de mercaderías vendidas', 'expense'),
  ('5.1.02', 'Ajustes de inventario', 'expense'),
  ('5.2.01', 'Gastos varios', 'expense'),
  ('5.2.02', 'Comisiones bancarias', 'expense')
ON CONFLICT (code) DO NOTHING;
INSERT INTO settings (key, value) VALUES
  ('invoice', '{"establishment":"001","point":"001","stamp":"00000000","enabled":true,"mode":"mock"}'),
  ('shop', '{"reserveMinutes":30,"managerPhone":"","name":"Librería Samantha","address":"","hours":"Lun a Sáb 08:00 a 18:00","whatsapp":""}')
ON CONFLICT (key) DO NOTHING;
INSERT INTO products (code, name, category, kind, price, tax_rate, online_visible) VALUES
  ('IMP-SERV', 'Servicio de impresión', 'Servicios de impresión', 'service', 0, 10, false),
  ('ENVIO', 'Envío a domicilio', 'Servicios', 'service', 0, 10, false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO settings (key, value) VALUES
  ('print', '{"bw":500,"color":1500,"finishing":{"anillado":8000,"plastificado":3000,"cortado":1000}}')
ON CONFLICT (key) DO NOTHING;
INSERT INTO users (username, name, role, password_hash, active) VALUES ('web', 'Tienda en línea', 'support', 'disabled:disabled', false)
ON CONFLICT (username) DO NOTHING;
INSERT INTO settings (key, value) VALUES
  ('ai', '{"enabled":false,"provider":"niro","model":"claude-opus-5-5","effort":"low","maxTokens":700}')
ON CONFLICT (key) DO NOTHING;
