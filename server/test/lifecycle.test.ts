import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { buildApp } from '../src/app.js'
import { hashPassword } from '../src/auth.js'
import { createPool, migrate, type Db } from '../src/db/client.js'
import { releaseExpiredReservations } from '../src/orders.js'
import { buildConfirmation } from '../src/payments.js'
import { flushOutbox } from '../src/services.js'

const BASE = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'
const TEST_DB = 'libreria_samantha_test4'
let db: Db
let app: ReturnType<typeof buildApp>
const tokens: Record<string, string> = {}

async function call(who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url: '/api' + url, payload: payload as any, headers: tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {} })
  return { status: res.statusCode, body: res.json() }
}
const ok = (r: { status: number; body: any }) => { if (r.status >= 300) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`); return r.body }

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: BASE })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${TEST_DB}`)
  await admin.end()
  db = createPool(BASE.replace(/\/[^/]*$/, '/' + TEST_DB))
  await migrate(db)
  for (const [u, role] of [['boss', 'owner'], ['cash', 'cashier'], ['stock', 'warehouse']]) {
    await db.query('INSERT INTO users (username, name, role, password_hash) VALUES ($1,$1,$2,$3)', [u, role, hashPassword('secret123')])
  }
  app = buildApp(db)
  for (const u of ['boss', 'cash', 'stock']) tokens[u] = (await call('', 'POST', '/login', { username: u, password: 'secret123' })).body.token
})
afterAll(async () => { await db.end() })

describe('Jornada completa de la librería: los números tienen que cuadrar', () => {
  it('compra, venta mostrador, crédito, cobranza, anulación, pedido web, vencimiento, impresión y pago a proveedor', async () => {
    // Catálogo y compra
    const cuad = ok(await call('boss', 'POST', '/products', { code: 'CUA', name: 'Cuaderno', price: 11000, cost: 6000, min_stock: 5, purchase_unit: 'caja', units_per_purchase: 12 }))
    const lib = ok(await call('boss', 'POST', '/products', { code: 'LIB', name: 'Libro', price: 55000, cost: 30000, tax_rate: 5, min_stock: 2 }))
    const sup = ok(await call('boss', 'POST', '/suppliers', { name: 'Distribuidora', whatsapp: '+595981000000' }))
    const po = ok(await call('boss', 'POST', '/purchases', { supplierId: sup.id, issue: true, items: [{ productId: cuad.id, qty: 3, unitCost: 72000 }, { productId: lib.id, qty: 10, unitCost: 30000 }] }))
    const det = ok(await call('boss', 'GET', `/purchases/${po.id}`))
    ok(await call('stock', 'POST', `/purchases/${po.id}/receive`, { items: det.items.map((i: any) => ({ itemId: i.id, qty: i.qty_ordered })) }))
    // La recepción sola no genera deuda: la deuda nace con la factura del proveedor.
    expect((await db.query(`SELECT balance FROM suppliers WHERE id = $1`, [sup.id])).rows[0].balance).toBe(0)
    const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
    const rec = (await call('boss', 'GET', `/receptions?orderId=${po.id}`)).body
    ok(await call('boss', 'POST', '/purchase-invoices', { supplierId: sup.id, docNumber: '001-001-0000001', docDate: today, paymentCondition: 'credit', receptionIds: rec.map((r: any) => r.id) }))
    expect((await db.query(`SELECT balance FROM suppliers WHERE id = $1`, [sup.id])).rows[0].balance).toBe(3 * 72000 * 1.1 + 10 * 30000 * 1.05)

    // Mostrador: efectivo + tarjeta, y crédito con cobranza parcial
    ok(await call('cash', 'POST', '/cash/open', { openingFloat: 50000 }))
    ok(await call('cash', 'POST', '/sales', { items: [{ productId: cuad.id, qty: 4 }, { productId: lib.id, qty: 1 }], payments: [{ method: 'cash', amount: 60000 }, { method: 'card', amount: 39000 }] }))
    const cust = ok(await call('cash', 'POST', '/customers', { name: 'Colegio San José', ruc: '80012345-6' }))
    ok(await call('boss', 'PUT', `/customers/${cust.id}`, { credit_limit: 500000 }))
    const credit = ok(await call('cash', 'POST', '/sales', { customerId: cust.id, items: [{ productId: lib.id, qty: 3 }], payments: [{ method: 'transfer', amount: 15000 }], onCredit: true }))
    ok(await call('cash', 'POST', `/customers/${cust.id}/payments`, { amount: 50000, method: 'cash' }))

    // Anulación de la venta a crédito
    ok(await call('boss', 'POST', '/cash/open', { openingFloat: 0 }))
    ok(await call('boss', 'POST', `/sales/${credit.id}/void`, { reason: 'Colegio canceló el pedido' }))

    // Pedido web pagado, otro vencido
    const order = (qty: number) => app.inject({ method: 'POST', url: '/api/shop/orders', payload: { customer: { name: 'Ana Gómez', phone: '+595981222333' }, items: [{ productId: cuad.id, qty }], delivery: { method: 'pickup' } } })
    const o1 = (await order(2)).json()
    const ref1 = (await db.query('SELECT provider_ref FROM payment_attempts WHERE order_id = $1', [o1.order.id])).rows[0].provider_ref
    expect((await app.inject({ method: 'POST', url: '/api/webhooks/bancard', payload: buildConfirmation(ref1, 22000, true) })).statusCode).toBe(200)
    const o2 = (await order(3)).json()
    await db.query(`UPDATE orders SET reserve_expires_at = now() - interval '1 minute' WHERE id = $1`, [o2.order.id])
    await releaseExpiredReservations(db)
    const o3 = (await order(1)).json() // queda reservado al cierre del test

    // Impresión con anticipo y entrega
    const wo = ok(await call('cash', 'POST', '/workorders', { customerName: 'Escuela', description: 'Exámenes', copies: 10, pages: 2 }))
    for (const status of ['approved', 'in_progress', 'ready']) ok(await call('cash', 'POST', `/workorders/${wo.id}/status`, { status }))
    ok(await call('cash', 'POST', `/workorders/${wo.id}/deposit`, { amount: 4000, method: 'cash' }))
    const svc = (await db.query(`SELECT id FROM products WHERE code = 'IMP-SERV'`)).rows[0].id
    ok(await call('cash', 'POST', '/sales', { workOrderId: wo.id, items: [{ productId: svc, qty: 1, unitPrice: wo.price }], payments: [{ method: 'cash', amount: wo.price - 4000 }] }))

    // Ajuste, retiro de caja y pago parcial al proveedor
    ok(await call('stock', 'POST', '/stock/adjust', { productId: lib.id, delta: -1, reason: 'Libro dañado' }))
    ok(await call('cash', 'POST', '/cash/movements', { type: 'out', amount: 5000, reason: 'Compra de cinta adhesiva' }))
    ok(await call('boss', 'POST', `/suppliers/${sup.id}/payments`, { amount: 100000, method: 'transfer' }))
    await flushOutbox(db)

    // ---- Invariantes
    const tb = ok(await call('boss', 'GET', '/accounting/trial-balance'))
    expect(tb.totalDebit).toBe(tb.totalCredit)
    expect(ok(await call('boss', 'GET', '/accounting/balance-sheet')).balanced).toBe(true)
    const bal = (code: string) => tb.rows.find((r: any) => r.code === code)?.balance ?? 0

    const receivables = Number((await db.query('SELECT COALESCE(SUM(balance),0) AS s FROM customers')).rows[0].s)
    expect(bal('1.1.04')).toBe(receivables)
    const payables = Number((await db.query('SELECT COALESCE(SUM(balance),0) AS s FROM suppliers')).rows[0].s)
    expect(bal('2.1.01')).toBe(payables)

    // El stock físico siempre es la suma de sus movimientos
    const drift = (await db.query(`SELECT p.code, p.stock, COALESCE(SUM(m.qty),0)::int AS moved FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id WHERE p.kind = 'product' GROUP BY p.id HAVING p.stock <> COALESCE(SUM(m.qty),0)`)).rows
    expect(drift).toEqual([])

    // Lo reservado coincide con los pedidos que tienen reserva viva
    const reserved = (await db.query(`SELECT p.code, p.reserved, COALESCE((SELECT SUM(oi.qty) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.reservation_active), 0)::int AS should FROM products p WHERE p.kind = 'product' AND p.reserved <> COALESCE((SELECT SUM(oi.qty) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.reservation_active), 0)`)).rows
    expect(reserved).toEqual([])
    expect((await db.query(`SELECT reserved FROM products WHERE id = $1`, [cuad.id])).rows[0].reserved).toBe(1)

    // Caja del cajero: fondo + efectivo cobrado - retiro. (50000 + 60000 + 50000 cobranza + 4000 anticipo + saldo impresión - 5000)
    const cur = ok(await call('cash', 'GET', '/cash/current'))
    expect(cur.expectedCash).toBe(50000 + 60000 + 50000 + 4000 + (wo.price - 4000) - 5000)
    const close = ok(await call('cash', 'POST', '/cash/close', { counted: cur.expectedCash }))
    expect(close.difference).toBe(0)

    // Cada venta completada tiene su factura aprobada y cada anulación su nota de crédito
    const unmatched = (await db.query(`SELECT s.number FROM sales s WHERE s.status = 'completed' AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.sale_id = s.id AND i.kind = 'invoice' AND i.status = 'approved')`)).rows
    expect(unmatched).toEqual([])
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM invoices WHERE kind = 'credit_note' AND status = 'approved'`)).rows[0].n).toBe(1)

    // Estado final de los pedidos web
    const states = (await db.query('SELECT number, status, payment_status, reservation_active FROM orders ORDER BY id')).rows
    expect(states[0]).toMatchObject({ payment_status: 'approved', status: 'confirmed', reservation_active: false })
    expect(states[1]).toMatchObject({ payment_status: 'pending', status: 'cancelled', reservation_active: false })
    expect(states[2]).toMatchObject({ payment_status: 'pending', status: 'confirmed', reservation_active: true })
    expect(o3.order.number).toBe(states[2].number)

    // Nada quedó sin enviar sin motivo y los avisos llegaron al equipo
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM outbox WHERE status = 'queued'`)).rows[0].n).toBe(0)
    const notif = ok(await call('boss', 'GET', '/notifications'))
    expect(notif.items.map((n: any) => n.type)).toEqual(expect.arrayContaining(['order_new', 'order_paid']))
  })
})
