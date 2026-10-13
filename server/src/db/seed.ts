import 'dotenv/config'
import { hashPassword } from '../auth.js'
import { createPool, migrate } from './client.js'
import { ensureDefaultPrompts } from '../ai.js'

// Datos de demostración. Las contraseñas de desarrollo se cambian al pasar a producción.
const db = createPool(process.env.DATABASE_URL!)
await migrate(db)
await ensureDefaultPrompts(db)

const users = [
  ['admin', 'Administrador', 'owner', 'admin1234'],
  ['caja', 'Cajero/a', 'cashier', 'caja1234'],
  ['compras', 'Compras', 'buyer', 'compras1234'],
  ['deposito', 'Depósito', 'warehouse', 'deposito1234'],
]
for (const [username, name, role, pw] of users) {
  await db.query('INSERT INTO users (username, name, role, password_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING',
    [username, name, role, hashPassword(pw)])
}

const products: [string, string, string, string | null, number, number, number, number, number][] = [
  // code, name, category, barcode, cost, price, tax, stock, min
  ['CUA-001', 'Cuaderno universitario 100 hojas', 'Útiles escolares', '7790001000011', 6000, 10000, 10, 60, 20],
  ['LAP-001', 'Lápiz grafito HB', 'Útiles escolares', '7790001000028', 700, 1500, 10, 200, 50],
  ['BOL-001', 'Bolígrafo azul', 'Oficina', '7790001000035', 800, 2000, 10, 150, 40],
  ['RES-001', 'Resma papel A4 75g', 'Oficina', '7790001000042', 32000, 45000, 10, 25, 10],
  ['LIB-001', 'Don Quijote de la Mancha', 'Libros', '9788420412146', 90000, 135000, 5, 8, 3],
  ['IMP-BN', 'Impresión B/N A4', 'Servicios de impresión', null, 0, 500, 10, 0, 0],
]
for (const [code, name, category, barcode, cost, price, tax, stock, min] of products) {
  const service = category === 'Servicios de impresión'
  const { rows } = await db.query(
    `INSERT INTO products (code, name, category, barcode, kind, cost, price, tax_rate, stock, min_stock)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (code) DO NOTHING RETURNING id`,
    [code, name, category, barcode, service ? 'service' : 'product', cost, price, tax, stock, min])
  if (rows[0] && stock > 0) {
    await db.query(`INSERT INTO stock_movements (product_id, type, qty, unit_cost, reason) VALUES ($1,'initial',$2,$3,'Carga inicial')`, [rows[0].id, stock, cost])
  }
}
await db.query(`INSERT INTO suppliers (name, ruc, whatsapp) SELECT 'Distribuidora Escolar', '80000000-1', '+595981000000'
                WHERE NOT EXISTS (SELECT 1 FROM suppliers)`)
// Asiento de apertura del inventario (contra capital) para que el balance parta cuadrado
const { rows: opened } = await db.query("SELECT 1 FROM journal_entries WHERE ref_type = 'opening_stock'")
if (!opened[0]) {
  const { rows: v } = await db.query("SELECT COALESCE(SUM(stock * cost),0) AS total FROM products WHERE kind = 'product'")
  const total = Number(v[0].total)
  if (total > 0) {
    const { rows: e } = await db.query("INSERT INTO journal_entries (description, ref_type) VALUES ('Inventario inicial', 'opening_stock') RETURNING id")
    await db.query("INSERT INTO journal_lines (entry_id, account_id, debit) SELECT $1, id, $2 FROM accounts WHERE code = '1.1.05'", [e[0].id, total])
    await db.query("INSERT INTO journal_lines (entry_id, account_id, credit) SELECT $1, id, $2 FROM accounts WHERE code = '3.1.01'", [e[0].id, total])
  }
}
await db.query("INSERT INTO delivery_zones (name, fee) SELECT * FROM (VALUES ('Centro', 15000), ('Barrios cercanos', 25000)) v(n, f) WHERE NOT EXISTS (SELECT 1 FROM delivery_zones)")
const { rows: hasList } = await db.query('SELECT 1 FROM school_lists LIMIT 1')
if (!hasList[0]) {
  const { rows: l } = await db.query("INSERT INTO school_lists (school, grade) VALUES ('Colegio San José', '3er grado') RETURNING id")
  await db.query("INSERT INTO school_list_items (list_id, product_id, qty) SELECT $1, id, q FROM (VALUES ('CUA-001', 4), ('LAP-001', 6), ('BOL-001', 2)) v(code, q) JOIN products p ON p.code = v.code", [l[0].id])
}
await db.query("UPDATE settings SET value = value || '{\"address\":\"Asunción, Paraguay\",\"whatsapp\":\"+595981000000\"}'::jsonb WHERE key = 'shop' AND NOT (value ? 'address' AND value->>'address' <> '')")
console.log('Seed listo. Usuarios: admin/admin1234, caja/caja1234, compras/compras1234, deposito/deposito1234')
await db.end()
