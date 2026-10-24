// Limpia los datos de DEMOSTRACIÓN de Librería Samantha dejando solo lo que cargó el dueño.
// Uso (dentro de la imagen de la app):  DATABASE_URL=... node cleanup-demo.cjs [--apply]
// Sin --apply hace todo dentro de una transacción y la deshace (ensayo): muestra qué se borraría y valida la contabilidad.
// Borra en cascada por las claves foráneas (usando ctid) para no dejar filas huérfanas.
const { Client } = require('pg')

const KEEP = { products: [1, 2, 138], customers: [4], suppliers: [2], orders: [6], expenses: [1], purchases: [1], cash_sessions: [1] }
const APPLY = process.argv.includes('--apply')

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  await db.query('BEGIN')
  const q = (t, p) => db.query(t, p).then((r) => r.rows)
  const one = async (t, p) => (await q(t, p))[0]

  // --- raíces a borrar -------------------------------------------------------------------------------------------------
  const roots = {}
  roots.products = (await q('SELECT id FROM products WHERE id <> ALL($1::int[])', [KEEP.products])).map((r) => r.id)
  roots.sales = (await q('SELECT id FROM sales')).map((r) => r.id) // todas son de prueba (V-000001 a V-000005)
  roots.orders = (await q('SELECT id FROM orders WHERE id <> ALL($1::int[])', [KEEP.orders])).map((r) => r.id)
  roots.customers = (await q('SELECT id FROM customers WHERE id <> ALL($1::int[])', [KEEP.customers])).map((r) => r.id)
  roots.customer_accounts = (await q('SELECT id FROM customer_accounts WHERE customer_id = ANY($1::int[]) OR email LIKE $2', [roots.customers, '%@cliente.test'])).map((r) => r.id)
  roots.suppliers = (await q('SELECT id FROM suppliers WHERE id <> ALL($1::int[])', [KEEP.suppliers])).map((r) => r.id)
  roots.journal_entries = (await q(`SELECT id FROM journal_entries WHERE ref_type = 'opening_stock' OR (ref_type = 'sale' AND ref_id = ANY($1::int[]))`, [roots.sales])).map((r) => r.id)
  roots.school_lists = (await q('SELECT id FROM school_lists')).map((r) => r.id) // lista escolar de ejemplo
  roots.notifications = (await q(`SELECT id FROM notifications WHERE (title ~ 'P-00000[1-5]$') OR (type = 'chat_inquiry' AND created_at < '2026-10-16')`)).map((r) => r.id)
  // las cuentas de la tienda de los clientes de prueba que no tienen ficha propia
  console.log('RAÍCES:', Object.fromEntries(Object.entries(roots).map(([k, v]) => [k, v.length])))

  // --- grafo de claves foráneas ---------------------------------------------------------------------------------------
  const fks = await q(`SELECT c.conrelid::regclass::text AS child, a.attname AS child_col, c.confrelid::regclass::text AS parent, af.attname AS parent_col, array_length(c.conkey,1) AS n
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1] JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = c.confkey[1]
    WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`)
  if (fks.some((f) => f.n > 1)) throw new Error('Hay claves foráneas compuestas: revisar el script')

  const seen = new Map() // tabla -> Set(ctid)
  const mark = (t, ids) => { const s = seen.get(t) ?? new Set(); const fresh = ids.filter((i) => !s.has(i)); fresh.forEach((i) => s.add(i)); seen.set(t, s); return fresh }
  const queue = []
  for (const [t, ids] of Object.entries(roots)) {
    if (!ids.length) continue
    const col = 'id'
    const rows = await q(`SELECT ctid::text AS c FROM ${t} WHERE ${col} = ANY($1::int[])`, [ids])
    const fresh = mark(t, rows.map((r) => r.c)); if (fresh.length) queue.push([t, fresh])
  }
  while (queue.length) {
    const [t, ctids] = queue.shift()
    for (const fk of fks.filter((f) => f.parent === t)) {
      const vals = (await q(`SELECT DISTINCT ${fk.parent_col} AS v FROM ${t} WHERE ctid = ANY($1::tid[]) AND ${fk.parent_col} IS NOT NULL`, [ctids])).map((r) => r.v)
      if (!vals.length) continue
      const rows = await q(`SELECT ctid::text AS c FROM ${fk.child} WHERE ${fk.child_col} = ANY($1)`, [vals])
      const fresh = mark(fk.child, rows.map((r) => r.c)); if (fresh.length) queue.push([fk.child, fresh])
    }
  }
  const plan = [...seen.entries()].map(([t, s]) => [t, s.size]).sort((a, b) => b[1] - a[1])
  console.log('SE BORRARÁ (tabla: filas):', plan.map(([t, n]) => `${t}:${n}`).join('  '))

  // --- protección: nada de lo que debe quedar puede estar en el conjunto a borrar --------------------------------------
  for (const [t, ids] of Object.entries(KEEP)) {
    const s = seen.get(t); if (!s) continue
    const keep = await q(`SELECT ctid::text AS c, id FROM ${t} WHERE id = ANY($1::int[])`, [ids])
    const hit = keep.filter((k) => s.has(k.c)); if (hit.length) throw new Error(`ABORTADO: se iba a borrar algo que debe quedar en ${t}: ${hit.map((h) => h.id)}`)
  }

  // --- borrar: primero hijos, y repetir hasta que no queden dependencias pendientes ----------------------------------------
  await db.query('SET CONSTRAINTS ALL DEFERRED').catch(() => {})
  let pending = [...seen.entries()].map(([t, s]) => [t, [...s]])
  for (let round = 0; round < 40 && pending.length; round++) {
    const next = []
    for (const [t, ctids] of pending) {
      await db.query('SAVEPOINT s')
      try { await db.query(`DELETE FROM ${t} WHERE ctid = ANY($1::tid[])`, [ctids]); await db.query('RELEASE SAVEPOINT s') }
      catch (e) { await db.query('ROLLBACK TO SAVEPOINT s'); if (e.code !== '23503') throw e; next.push([t, ctids]) }
    }
    if (next.length === pending.length && round > 0 && JSON.stringify(next.map((x) => [x[0], x[1].length])) === JSON.stringify(pending.map((x) => [x[0], x[1].length]))) throw new Error('No se pudo ordenar el borrado: ' + next.map((x) => x[0]).join(','))
    pending = next
  }

  // --- cuenta bancaria de ejemplo que ven los clientes ------------------------------------------------------------------
  await db.query('SAVEPOINT b')
  let bankNote
  try { const r = await db.query(`DELETE FROM money_accounts WHERE name LIKE '%(demo)%' RETURNING id`); await db.query('RELEASE SAVEPOINT b'); bankNote = `cuenta demo eliminada (${r.rowCount})` }
  catch { await db.query('ROLLBACK TO SAVEPOINT b'); await db.query(`UPDATE money_accounts SET online_enabled = false, active = false WHERE name LIKE '%(demo)%'`); bankNote = 'cuenta demo desactivada (tenía movimientos)' }
  console.log('Banco de ejemplo:', bankNote)

  // --- validaciones contables y de stock ----------------------------------------------------------------------------------
  const tb = await one('SELECT COALESCE(SUM(debit),0)::bigint AS d, COALESCE(SUM(credit),0)::bigint AS c FROM journal_lines')
  console.log('Balance de comprobación: debe', tb.d, 'haber', tb.c, tb.d === tb.c ? 'OK' : 'DESCUADRADO')
  if (tb.d !== tb.c) throw new Error('La contabilidad quedó descuadrada')
  const inv = await one(`SELECT COALESCE(SUM(l.debit - l.credit),0)::bigint AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = '1.1.05'`)
  const phys = await one(`SELECT COALESCE(SUM(stock * cost),0)::bigint AS v FROM products WHERE kind = 'product'`)
  console.log('Mercaderías en libros', inv.v, '· stock físico valorizado (costo)', phys.v)
  const left = await one(`SELECT (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM customers) AS customers, (SELECT COUNT(*) FROM suppliers) AS suppliers, (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM sales) AS sales, (SELECT COUNT(*) FROM stock_movements) AS stock_movements, (SELECT COUNT(*) FROM journal_entries) AS journal_entries, (SELECT COUNT(*) FROM customer_accounts) AS accounts`)
  console.log('QUEDA:', JSON.stringify(left))
  console.log('Productos que quedan:', (await q('SELECT id, code, name, stock FROM products ORDER BY id')).map((p) => `${p.id}:${p.code}(${p.stock})`).join(' | '))

  if (APPLY) { await db.query('COMMIT'); console.log('>>> APLICADO') } else { await db.query('ROLLBACK'); console.log('>>> ENSAYO (no se cambió nada). Para aplicar: --apply') }
  await db.end()
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
