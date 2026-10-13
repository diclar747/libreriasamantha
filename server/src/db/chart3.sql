-- Cuentas contables de compras con recepción y factura separadas
INSERT INTO accounts (code, name, type) VALUES
  ('1.1.09', 'Devoluciones a proveedores por acreditar', 'asset'),
  ('2.1.05', 'Mercadería recibida pendiente de facturar', 'liability'),
  ('5.1.04', 'Diferencias de compras (facturado vs recibido)', 'expense')
ON CONFLICT (code) DO NOTHING;

-- Parámetros de descuentos, delivery y tienda
INSERT INTO settings (key, value) VALUES
  ('discounts', '{"maxLinePct":10,"maxSalePct":10,"allowStack":false,"belowCost":"authorize"}'),
  ('delivery', '{"baseFee":30000,"carriers":["Reparto propio"]}'),
  ('store', '{"pickupAddress":"","pickupHours":"Lun a Sáb 08:00 a 18:00","stockMode":"availability"}')
ON CONFLICT (key) DO NOTHING;

-- Cuenta bancaria de EJEMPLO (ficticia): reemplazar por los datos reales antes de cobrar de verdad.
INSERT INTO money_accounts (kind, name, bank_name, account_number, holder, holder_document, account_type, alias, instructions, online_enabled, is_demo)
SELECT 'bank', 'Banco de Ejemplo Paraguay (demo)', 'Banco de Ejemplo Paraguay', '0000000000', 'Librería Demo', '80000000-0', 'Cuenta corriente', 'pagos@libreria.example',
  'Datos ficticios de demostración. Reemplazalos por los de tu cuenta antes de habilitar cobros reales.', true, true
WHERE NOT EXISTS (SELECT 1 FROM money_accounts WHERE is_demo);
