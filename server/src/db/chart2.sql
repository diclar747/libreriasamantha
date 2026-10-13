-- Cuentas contables del módulo de finanzas
INSERT INTO accounts (code, name, type) VALUES
  ('1.1.08', 'QR y billeteras a cobrar', 'asset'),
  ('2.1.04', 'Acreedores varios (gastos a pagar)', 'liability'),
  ('3.1.04', 'Retiros del propietario', 'equity'),
  ('4.1.02', 'Devoluciones sobre ventas', 'income'),
  ('4.2.02', 'Sobrantes de caja', 'income'),
  ('5.2.03', 'Diferencias de caja (faltantes)', 'expense'),
  ('5.3.01', 'Servicios (luz, agua, teléfono, internet)', 'expense'),
  ('5.3.02', 'Alquiler', 'expense'),
  ('5.3.03', 'Sueldos y remuneraciones', 'expense'),
  ('5.3.04', 'Transporte, combustible y entregas', 'expense'),
  ('5.3.05', 'Publicidad y marketing', 'expense'),
  ('5.3.06', 'Limpieza y mantenimiento', 'expense'),
  ('5.3.07', 'Materiales de oficina', 'expense'),
  ('5.3.08', 'Equipos y reparaciones', 'expense'),
  ('5.3.09', 'Sistemas, licencias y servidor', 'expense'),
  ('5.3.11', 'Honorarios profesionales', 'expense'),
  ('5.3.12', 'Impuestos y tasas', 'expense'),
  ('5.3.13', 'Otros gastos', 'expense')
ON CONFLICT (code) DO NOTHING;

-- Cajas y cuentas bancarias iniciales
INSERT INTO money_accounts (kind, name)
SELECT v.kind, v.name FROM (VALUES ('cash', 'Caja general'), ('bank', 'Banco principal')) v(kind, name)
WHERE NOT EXISTS (SELECT 1 FROM money_accounts m WHERE m.kind = v.kind AND m.name = v.name);

-- Categorías de gasto base (configurables desde la aplicación)
INSERT INTO expense_categories (name, account_code, sort)
SELECT v.name, v.code, v.sort FROM (VALUES
  ('Servicios', '5.3.01', 10),
  ('Alquiler', '5.3.02', 20),
  ('Sueldos y remuneraciones', '5.3.03', 30),
  ('Transporte, combustible y entregas', '5.3.04', 40),
  ('Publicidad y marketing', '5.3.05', 50),
  ('Limpieza y mantenimiento', '5.3.06', 60),
  ('Materiales de oficina', '5.3.07', 70),
  ('Equipos y reparaciones', '5.3.08', 80),
  ('Sistemas, licencias y servidor', '5.3.09', 90),
  ('Comisiones bancarias y de tarjetas', '5.2.02', 100),
  ('Honorarios profesionales', '5.3.11', 110),
  ('Impuestos y tasas', '5.3.12', 120),
  ('Otros gastos', '5.3.13', 130)
) v(name, code, sort)
WHERE NOT EXISTS (SELECT 1 FROM expense_categories c WHERE c.parent_id IS NULL AND lower(c.name) = lower(v.name));

INSERT INTO expense_categories (parent_id, name, sort)
SELECT p.id, v.name, v.sort FROM (VALUES
  ('Servicios', 'Luz', 1), ('Servicios', 'Agua', 2), ('Servicios', 'Teléfono e internet', 3),
  ('Transporte, combustible y entregas', 'Combustible', 1), ('Transporte, combustible y entregas', 'Entregas a domicilio', 2)
) v(parent, name, sort)
JOIN expense_categories p ON p.parent_id IS NULL AND p.name = v.parent
WHERE NOT EXISTS (SELECT 1 FROM expense_categories c WHERE c.parent_id = p.id AND lower(c.name) = lower(v.name));

-- Comisiones estimadas por medio de cobro y límites operativos
INSERT INTO settings (key, value) VALUES
  ('payments', '{"fees":{"card_debit":1.8,"card_credit":3.2,"qr":1.2,"online":3.0},"withdrawLimit":200000,"cashDiffThreshold":0,"processors":["Bancard","Cabal","Panal","Visa","Mastercard"],"qrProviders":["Bancard QR","Zimple","Tigo Money","Billetera Personal"]}')
ON CONFLICT (key) DO NOTHING;
