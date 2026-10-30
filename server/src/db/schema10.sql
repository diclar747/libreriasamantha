-- Facturación electrónica real (OñeTema/SIFEN) y enriquecimiento de clientes con datos de SET.

-- Número oficial que devuelve el proveedor (el `number` local queda como referencia interna; el CDC ya existe).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS provider_number text;

-- Clasificación del documento del cliente para armar la factura (PERSONA / CONTRIBUYENTE).
-- Se sigue usando customers.ruc (lo que la factura lee) y customers.document.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS doc_type text;      -- 'ruc' | 'ci'
ALTER TABLE customers ADD COLUMN IF NOT EXISTS taxpayer boolean;   -- contribuyente registrado en SET (SI/NO)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS persona text;       -- 'FISICA' | 'JURIDICA'
