import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { buildApp } from '../src/app.js'
import { hashPassword } from '../src/auth.js'
import { createPool, migrate, type Db } from '../src/db/client.js'

const BASE = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'
const TEST_DB = 'libreria_samantha_test7'
let db: Db
let app: ReturnType<typeof buildApp>
const tokens: Record<string, string> = {}

async function call(who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url: '/api' + url, payload: payload as any, headers: tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {} })
  const ct = String(res.headers['content-type'] ?? '')
  return { status: res.statusCode, body: ct.includes('json') ? res.json() : null, raw: res.rawPayload, headers: res.headers }
}
const ok = (r: { status: number; body: any }) => { if (r.status >= 300) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`); return r.body }
const today = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
const plus = (n: number) => new Date(Date.now() - 3 * 3600_000 + n * 86400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: BASE })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${TEST_DB}`)
  await admin.end()
  db = createPool(BASE.replace(/\/[^/]*$/, '/' + TEST_DB))
  await migrate(db)
  for (const [u, role] of [['boss', 'owner'], ['buy', 'buyer'], ['stock', 'warehouse'], ['acc', 'accountant']]) {
    await db.query('INSERT INTO users (username, name, role, password_hash) VALUES ($1,$1,$2,$3)', [u, role, hashPassword('secret123')])
  }
  app = buildApp(db)
  for (const u of ['boss', 'buy', 'stock', 'acc']) tokens[u] = (await call('', 'POST', '/login', { username: u, password: 'secret123' })).body.token
})
afterAll(async () => { await db.end() })

let sup: any, a: any, b: any, po1: any, po2: any
const accBal = async (code: string) => Number((await db.query(`SELECT COALESCE(SUM(l.debit - l.credit), 0) AS s FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = $1`, [code])).rows[0].s)

describe('Compras: proveedor → orden → recepción → factura → pago', () => {
  it('valida y guarda la ficha completa del proveedor; no duplica el RUC', async () => {
    expect((await call('boss', 'POST', '/suppliers', { name: 'X' })).status).toBe(400)
    expect((await call('boss', 'POST', '/suppliers', { name: 'Papelera', email: 'no-es-mail' })).status).toBe(400)
    sup = ok(await call('boss', 'POST', '/suppliers', { name: 'Papelera del Este', legal_name: 'Papelera del Este S.A.', ruc: '80012345-6', supplier_type: 'Mayorista', city: 'Ciudad del Este', department: 'Alto Paraná',
      contact_name: 'Marta', contact_phone: '+595981123456', payment_condition: 'credit', payment_days: 30, bank_name: 'Itaú', bank_account: '123456' }))
    expect(sup.payment_days).toBe(30)
    const dup = await call('boss', 'POST', '/suppliers', { name: 'Otra', ruc: '80012345-6' })
    expect(dup.status).toBe(409)
    expect((await call('buy', 'POST', '/suppliers', { name: 'Compras SRL' })).status).toBe(201)
    expect((await call('boss', 'GET', '/suppliers?q=papelera&page=1')).body.total).toBe(1)
  })

  it('crea productos y la orden pasa por borrador → aprobación → emisión (solo un responsable aprueba)', async () => {
    a = ok(await call('boss', 'POST', '/products', { name: 'Resma A4', code: 'RES', price: 40000, cost: 0, purchase_unit: 'caja', units_per_purchase: 10, min_stock: 2, markup_pct: 50 }))
    b = ok(await call('boss', 'POST', '/products', { name: 'Marcador', code: 'MAR', price: 5000, cost: 0 }))
    expect((await call('buy', 'POST', '/purchases', { supplierId: sup.id, items: [{ productId: a.id, qty: 0, unitCost: 100 }] })).status).toBe(400)
    expect((await call('buy', 'POST', '/purchases', { supplierId: sup.id, items: [{ productId: a.id, qty: 1, unitCost: -5 }] })).status).toBe(400)
    expect((await call('buy', 'POST', '/purchases', { supplierId: sup.id, expectedDate: '2000-01-01', items: [{ productId: a.id, qty: 1, unitCost: 100 }] })).status).toBe(400)
    expect((await call('buy', 'POST', '/purchases', { supplierId: sup.id, issue: true, items: [{ productId: a.id, qty: 1, unitCost: 100 }] })).status).toBe(403)
    po1 = ok(await call('buy', 'POST', '/purchases', { supplierId: sup.id, receivingPlace: 'Depósito', items: [{ productId: a.id, qty: 10, unitCost: 100000 }, { productId: b.id, qty: 20, unitCost: 2000 }] }))
    expect(po1.status).toBe('draft')
    expect(po1.number).toMatch(/^OC-\d{6}$/)
    expect(Number(po1.net)).toBe(1_040_000)
    expect(Number(po1.tax)).toBe(104_000)
    expect(Number(po1.total)).toBe(1_144_000)
    expect((await call('boss', 'POST', `/purchases/${po1.id}/issue`)).status).toBe(409) // hay que aprobar primero
    ok(await call('buy', 'POST', `/purchases/${po1.id}/submit`))
    expect((await call('buy', 'POST', `/purchases/${po1.id}/approve`)).status).toBe(403)
    ok(await call('boss', 'POST', `/purchases/${po1.id}/approve`))
    expect((await call('buy', 'PUT', `/purchases/${po1.id}`, { supplierId: sup.id, items: [{ productId: a.id, qty: 1, unitCost: 1 }] })).status).toBe(409) // ya no es editable
    expect(ok(await call('boss', 'POST', `/purchases/${po1.id}/issue`)).status).toBe('issued')
    const pdf = await call('buy', 'GET', `/purchases/${po1.id}/pdf`)
    expect(pdf.status).toBe(200)
    expect(String(pdf.headers['content-type'])).toBe('application/pdf')
  })

  it('la recepción parcial separa aceptado y rechazado; solo lo aceptado entra al stock', async () => {
    const det = ok(await call('stock', 'GET', `/purchases/${po1.id}`))
    expect(det.items[0].unit_cost).toBeUndefined() // el depósito no ve costos
    const full = ok(await call('boss', 'GET', `/purchases/${po1.id}`))
    const [ia, ib] = full.items
    expect((await call('stock', 'POST', `/purchases/${po1.id}/receptions`, { items: [{ orderItemId: ia.id, qtyReceived: 4, qtyRejected: 1 }] })).status).toBe(400) // falta motivo
    const r1 = ok(await call('stock', 'POST', `/purchases/${po1.id}/receptions`, { deliveryNote: 'R-001', items: [
      { orderItemId: ia.id, qtyReceived: 4, qtyRejected: 1, rejectReason: 'Cajas mojadas', rejectResolution: 'return' }, { orderItemId: ib.id, qtyReceived: 20 }] }))
    expect(r1.status).toBe('partial')
    const prodA = (await call('boss', 'GET', `/products/${a.id}`)).body
    expect(prodA.stock).toBe(30) // 3 cajas aceptadas x 10
    expect(prodA.cost).toBe(10000) // 100000 por caja / 10
    expect((await call('boss', 'GET', `/products/${b.id}`)).body.stock).toBe(20)
    // la recepción generó una sugerencia de precio manteniendo el margen del 50%
    const sug = (await call('boss', 'GET', '/price-suggestions')).body.find((s: any) => s.product_id === a.id)
    expect(sug.price_suggested).toBe(16500) // 10000 * 1.5 * 1.1
    // sobrante: requiere autorización
    expect((await call('stock', 'POST', `/purchases/${po1.id}/receptions`, { items: [{ orderItemId: ia.id, qtyReceived: 9 }] })).status).toBe(409)
    const det2 = ok(await call('boss', 'GET', `/purchases/${po1.id}`))
    expect(det2.items[0]).toMatchObject({ qty_received: 3, qty_rejected: 1, qty_pending: 7 })
    expect((await call('stock', 'POST', `/purchases/${po1.id}/receptions`, { authorizeExtra: true, items: [{ orderItemId: ia.id, qtyReceived: 9 }] })).status).toBe(403) // el depósito no autoriza
    const r2 = ok(await call('boss', 'POST', `/purchases/${po1.id}/receptions`, { authorizeExtra: true, items: [{ orderItemId: ia.id, qtyReceived: 9 }] }))
    expect(r2.status).toBe('received') // 3 + 7 = 10; 2 sobrantes aceptados aparte
    expect(r2.items.some((i: any) => i.kind === 'surplus' && i.qty_accepted === 2)).toBe(true)
    expect((await call('boss', 'GET', `/products/${a.id}`)).body.stock).toBe(30 + 90)
    expect((await call('stock', 'POST', `/purchases/${po1.id}/receptions`, { items: [{ orderItemId: ia.id, qtyReceived: 1 }] })).status).toBe(409) // ya recibida
    // recibido y todavía sin factura: queda en "mercadería recibida pendiente de facturar"
    expect(await accBal('2.1.05')).toBeLessThan(0)
  })

  it('una factura puede cubrir varias órdenes; valida duplicados, cantidades y cuotas', async () => {
    po2 = ok(await call('boss', 'POST', '/purchases', { supplierId: sup.id, issue: true, items: [{ productId: b.id, qty: 10, unitCost: 2000 }] }))
    ok(await call('stock', 'POST', `/purchases/${po2.id}/receptions`, { items: [{ orderItemId: ok(await call('boss', 'GET', `/purchases/${po2.id}`)).items[0].id, qtyReceived: 10 }] }))
    const pend = ok(await call('acc', 'GET', `/suppliers/${sup.id}/uninvoiced`))
    expect(pend.map((p: any) => p.order_number)).toEqual(expect.arrayContaining([po1.number, po2.number]))
    const itemB2 = pend.find((p: any) => p.order_id === po2.id)
    const body = { supplierId: sup.id, docNumber: '001-001-0000100', docDate: today(), paymentCondition: 'credit', timbrado: '12345678',
      lines: pend.filter((p: any) => p.order_id === po1.id || p.order_id === po2.id).map((p: any) => ({ receptionItemId: p.reception_item_id })) }
    expect((await call('acc', 'POST', '/purchase-invoices', { ...body, docNumber: '1234' })).status).toBe(400) // formato inválido
    expect((await call('acc', 'POST', '/purchase-invoices', { ...body, docDate: plus(3) })).status).toBe(400) // fecha futura
    expect((await call('acc', 'POST', '/purchase-invoices', { ...body, installments: [{ dueDate: plus(30), amount: 5 }] })).status).toBe(400) // cuotas no suman
    expect((await call('acc', 'POST', '/purchase-invoices', { ...body, lines: [{ receptionItemId: itemB2.reception_item_id, qty: 11 }] })).status).toBe(409) // más de lo recibido
    const total = 100000 * 12 + 2000 * 30 // 1.200.000 + 60.000 (incluye 2 cajas sobrantes) = neto
    const inv = ok(await call('acc', 'POST', '/purchase-invoices', { ...body, installments: [{ dueDate: plus(15), amount: Math.round(total * 1.1 / 2) }, { dueDate: plus(45), amount: Math.round(total * 1.1) - Math.round(total * 1.1 / 2) }] }))
    expect(Number(inv.subtotal)).toBe(total)
    expect(Number(inv.tax_total)).toBe(total / 10)
    expect(Number(inv.total)).toBe(Number(inv.subtotal) + Number(inv.tax_total))
    const dup = await call('acc', 'POST', '/purchase-invoices', { ...body, lines: [{ receptionItemId: itemB2.reception_item_id, qty: 1 }] })
    expect(dup.status).toBe(409) // mismo número de factura del mismo proveedor
    expect(dup.body.error).toMatch(/ya fue cargada/)
    const detail = ok(await call('acc', 'GET', `/purchase-invoices/${inv.id}`))
    expect(detail.orders.map((o: any) => o.number).sort()).toEqual([po1.number, po2.number].sort())
    expect(detail.payables).toHaveLength(2)
    expect(await accBal('2.1.05')).toBe(0) // todo lo recibido quedó facturado
    expect(Number((await db.query('SELECT balance FROM suppliers WHERE id = $1', [sup.id])).rows[0].balance)).toBe(Number(inv.total))
    // ya no queda nada por facturar
    expect(ok(await call('acc', 'GET', `/suppliers/${sup.id}/uninvoiced`))).toEqual([])
    ;(globalThis as any).inv = inv
  })

  it('pagos parciales se aplican de la cuota más vieja a la más nueva; el exceso es anticipo; se pueden anular', async () => {
    const inv = (globalThis as any).inv
    const half = Math.round(Number(inv.total) / 2)
    ok(await call('boss', 'POST', '/cash/open', { openingFloat: 0 }))
    expect((await call('acc', 'POST', `/suppliers/${sup.id}/payments`, { amount: Number(inv.total) + 1, method: 'transfer' })).status).toBe(400) // supera la deuda
    const p1 = ok(await call('acc', 'POST', `/suppliers/${sup.id}/payments`, { amount: half - 1000, method: 'transfer', reference: 'TR-1' }))
    expect(p1.applied).toBe(half - 1000)
    let d = ok(await call('acc', 'GET', `/purchase-invoices/${inv.id}`))
    expect(d.status).toBe('open')
    expect(d.payables[0].paid).toBe(half - 1000)
    expect(d.payables[1].paid).toBe(0)
    // pago en efectivo desde la caja del usuario
    expect((await call('acc', 'POST', `/suppliers/${sup.id}/payments`, { amount: 1000, method: 'cash' })).status).toBe(409) // contabilidad no tiene caja abierta
    ok(await call('boss', 'POST', '/cash/movements', { type: 'in', amount: 10000, reason: 'Aporte para pagos' }))
    // anticipo: paga más de lo adeudado cuando se indica expresamente
    const p2 = ok(await call('boss', 'POST', `/suppliers/${sup.id}/payments`, { amount: Number(inv.total) - (half - 1000) + 5000, method: 'transfer', advance: true }))
    expect(p2.advance).toBe(5000)
    d = ok(await call('acc', 'GET', `/purchase-invoices/${inv.id}`))
    expect(d.status).toBe('paid')
    const s = (await call('boss', 'GET', `/suppliers/${sup.id}`)).body
    expect(s.credit_balance).toBe(5000)
    expect(Number(s.balance)).toBe(-5000)
    // anular el segundo pago reabre la deuda y quita el anticipo
    ok(await call('boss', 'POST', `/supplier-payments/${p2.id}/void`, { reason: 'Error de monto' }))
    d = ok(await call('acc', 'GET', `/purchase-invoices/${inv.id}`))
    expect(d.status).toBe('open')
    expect((await call('boss', 'GET', `/suppliers/${sup.id}`)).body.credit_balance).toBe(0)
    // el estado de cuenta suma lo facturado menos lo pagado
    const st = ok(await call('boss', 'GET', `/suppliers/${sup.id}/statement`))
    expect(st.balance).toBe(Number(inv.total) - (half - 1000))
    // el asiento de pagos cuadra con el saldo de proveedores
    expect(await accBal('2.1.01')).toBe(-Number((await db.query('SELECT SUM(balance) AS s FROM suppliers')).rows[0].s))
  })

  it('devolución a proveedor de mercadería facturada + nota de crédito (aplicada, a favor o reembolso)', async () => {
    const rec = ok(await call('boss', 'GET', `/receptions?orderId=${po2.id}`))[0]
    const det = ok(await call('boss', 'GET', `/receptions/${rec.id}`))
    const item = det.items[0]
    expect((await call('buy', 'POST', '/supplier-returns', { supplierId: sup.id, reason: 'Defecto', lines: [{ receptionItemId: item.id, qty: 99 }] })).status).toBe(409)
    const ret = ok(await call('buy', 'POST', '/supplier-returns', { supplierId: sup.id, reason: 'Marcadores secos', lines: [{ receptionItemId: item.id, qty: 4 }] }))
    expect(Number(ret.total)).toBe(8000)
    expect(ret.credit_status).toBe('pending')
    expect((await call('boss', 'GET', `/products/${b.id}`)).body.stock).toBe(20 + 10 - 4)
    expect(await accBal('1.1.09')).toBe(8000) // crédito a favor pendiente de la nota del proveedor
    expect((await call('boss', 'POST', '/supplier-credit-notes', { supplierId: sup.id, returnId: ret.id, docNumber: 'NC-1', docDate: today(), net: 9000, vat: 900, resolution: 'applied' })).status).toBe(409) // supera lo devuelto
    const before = Number((await db.query('SELECT balance FROM suppliers WHERE id = $1', [sup.id])).rows[0].balance)
    const nc = ok(await call('acc', 'POST', '/supplier-credit-notes', { supplierId: sup.id, returnId: ret.id, docNumber: '001-001-0000555', docDate: today(), net: 8000, vat: 800, resolution: 'applied' }))
    expect(Number(nc.amount)).toBe(8800)
    expect(Number((await db.query('SELECT balance FROM suppliers WHERE id = $1', [sup.id])).rows[0].balance)).toBe(before - 8800)
    expect(await accBal('1.1.09')).toBe(0)
    expect((await call('acc', 'POST', '/supplier-credit-notes', { supplierId: sup.id, docNumber: '001-001-0000555', docDate: today(), net: 100, vat: 0, resolution: 'credit_balance' })).status).toBe(409) // duplicada
    expect((await call('boss', 'GET', `/supplier-returns`)).body[0].credit_status).toBe('credited')
  })

  it('compra directa sin orden: entra al stock y se factura en el mismo acto, con pago al contado', async () => {
    const c = ok(await call('boss', 'POST', '/products', { name: 'Cinta', code: 'CIN', price: 3000, cost: 0 }))
    ok(await call('boss', 'POST', '/cash/movements', { type: 'in', amount: 100000, reason: 'Fondo para compras' }))
    const inv = ok(await call('boss', 'POST', '/purchase-invoices', { supplierId: sup.id, docNumber: '002-001-0000007', docDate: today(), paymentCondition: 'cash',
      directLines: [{ productId: c.id, qty: 10, unitCost: 1100, includesVat: true }], payNow: { method: 'cash' } }))
    expect(inv.status).toBe('paid')
    expect(Number(inv.total)).toBe(11000)
    const prod = (await call('boss', 'GET', `/products/${c.id}`)).body
    expect(prod.stock).toBe(10)
    expect(prod.cost).toBe(1000) // sin IVA
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM supplier_payments WHERE method = 'cash'`)).rows[0].n).toBe(1)
    // la factura se puede anular mientras no tenga pagos: este ya está pagada
    expect((await call('boss', 'POST', `/purchase-invoices/${inv.id}/void`, { reason: 'Prueba' })).status).toBe(409)
  })

  it('anular una factura sin pagos libera lo recibido; anular una recepción repone el stock; el balance cuadra', async () => {
    const o = ok(await call('boss', 'POST', '/purchases', { supplierId: sup.id, issue: true, items: [{ productId: b.id, qty: 5, unitCost: 2000 }] }))
    const itemId = ok(await call('boss', 'GET', `/purchases/${o.id}`)).items[0].id
    const rc = ok(await call('stock', 'POST', `/purchases/${o.id}/receptions`, { items: [{ orderItemId: itemId, qtyReceived: 5 }] }))
    const stockBefore = (await call('boss', 'GET', `/products/${b.id}`)).body.stock
    const inv = ok(await call('acc', 'POST', '/purchase-invoices', { supplierId: sup.id, docNumber: '001-001-0000200', docDate: today(), receptionIds: [rc.id] }))
    expect((await call('boss', 'POST', `/receptions/${rc.id}/void`, { reason: 'Error' })).status).toBe(409) // ya está facturada
    ok(await call('boss', 'POST', `/purchase-invoices/${inv.id}/void`, { reason: 'Factura mal cargada' }))
    expect(ok(await call('acc', 'GET', `/suppliers/${sup.id}/uninvoiced`)).length).toBe(1)
    ok(await call('boss', 'POST', `/receptions/${rc.id}/void`, { reason: 'No llegó' }))
    expect((await call('boss', 'GET', `/products/${b.id}`)).body.stock).toBe(stockBefore - 5)
    expect(ok(await call('boss', 'GET', `/purchases/${o.id}`)).status).toBe('issued')
    expect(ok(await call('boss', 'POST', `/purchases/${o.id}/cancel`, { reason: 'Proveedor sin stock' })).status).toBe('cancelled')
    // el libro mayor no quedó desbalanceado y la deuda contable coincide con la de los proveedores
    const tb = ok(await call('boss', 'GET', '/accounting/trial-balance'))
    expect(tb.totalDebit).toBe(tb.totalCredit)
    expect(await accBal('2.1.01')).toBe(-Number((await db.query('SELECT SUM(balance) AS s FROM suppliers')).rows[0].s))
    // lo único recibido y no facturado es la recepción de 2 unidades de la orden cerrada abajo
    expect(await accBal('2.1.05')).toBe(0)
    // cierre de orden parcial
    const o2 = ok(await call('boss', 'POST', '/purchases', { supplierId: sup.id, issue: true, items: [{ productId: b.id, qty: 5, unitCost: 2000 }] }))
    const i2 = ok(await call('boss', 'GET', `/purchases/${o2.id}`)).items[0].id
    ok(await call('stock', 'POST', `/purchases/${o2.id}/receptions`, { items: [{ orderItemId: i2, qtyReceived: 2 }] }))
    expect((await call('boss', 'POST', `/purchases/${o2.id}/cancel`, { reason: 'x y z' })).status).toBe(409)
    expect(ok(await call('boss', 'POST', `/purchases/${o2.id}/close`, { reason: 'El proveedor no entrega el resto' })).status).toBe('closed_short')
  })

  it('los reportes de compras y deuda coinciden con los registros y se exportan', async () => {
    const inv = ok(await call('boss', 'GET', '/reports/purchase-invoices?range=month'))
    const sumInv = Number((await db.query(`SELECT COALESCE(SUM(total), 0) AS s FROM purchase_invoices WHERE status <> 'void' AND doc_date >= date_trunc('month', current_date)`)).rows[0].s)
    expect(inv.totals.total).toBe(sumInv)
    const ap = ok(await call('boss', 'GET', '/reports/payables'))
    const owed = Number((await db.query(`SELECT COALESCE(SUM(amount - paid - credited), 0) AS s FROM payables WHERE status = 'open'`)).rows[0].s)
    expect(ap.totals.total).toBe(owed)
    expect(ok(await call('boss', 'GET', '/reports/payables?view=detail')).totals.pending).toBe(owed)
    expect(ok(await call('boss', 'GET', '/reports/purchase-orders?range=month&groupBy=status')).rows.length).toBeGreaterThan(0)
    const inventory = ok(await call('boss', 'GET', '/reports/inventory'))
    expect(inventory.totals.cost_value).toBeGreaterThan(0)
    expect(ok(await call('stock', 'GET', '/reports/inventory')).columns.some((c: any) => c.key === 'cost_value')).toBe(false) // el depósito no ve costos
    expect(ok(await call('boss', 'GET', '/reports/stock-movements?range=month')).rows.length).toBeGreaterThan(5)
    const x = await call('boss', 'GET', '/reports/purchase-invoices/export?range=month&format=xlsx')
    expect(x.status).toBe(200)
    expect(String(x.headers['content-type'])).toContain('spreadsheetml')
  })
})
