import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { buildApp } from '../src/app.js'
import { hashPassword } from '../src/auth.js'
import { createPool, migrate, type Db } from '../src/db/client.js'
import { chatReply } from '../src/chatbot.js'
import { releaseExpiredReservations } from '../src/orders.js'
import { buildConfirmation } from '../src/payments.js'
import { flushOutbox } from '../src/services.js'

const BASE = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'
const TEST_DB = 'libreria_samantha_test2'
let db: Db
let app: ReturnType<typeof buildApp>
const tokens: Record<string, string> = {}

async function call(who: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await app.inject({ method, url: '/api' + url, payload: payload as any, headers: tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {} })
  return { status: res.statusCode, body: res.json() }
}
const stockOf = async (code: string) => (await db.query('SELECT stock, reserved FROM products WHERE code = $1', [code])).rows[0]

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: BASE })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${TEST_DB}`)
  await admin.end()
  db = createPool(BASE.replace(/\/[^/]*$/, '/' + TEST_DB))
  await migrate(db)
  for (const [u, role] of [['boss', 'owner'], ['cash', 'cashier'], ['acc', 'accountant']]) {
    await db.query('INSERT INTO users (username, name, role, password_hash) VALUES ($1,$1,$2,$3)', [u, role, hashPassword('secret123')])
  }
  app = buildApp(db)
  for (const u of ['boss', 'cash', 'acc']) tokens[u] = (await call('', 'POST', '/login', { username: u, password: 'secret123' })).body.token
  await db.query(`UPDATE settings SET value = jsonb_set(value, '{managerPhone}', '"+595981111111"') WHERE key = 'shop'`)
})
afterAll(async () => { await db.end() })

describe('Contabilidad y facturación', () => {
  let pid: number
  it('una venta genera asientos balanceados, IVA y factura aprobada', async () => {
    pid = (await call('boss', 'POST', '/products', { code: 'CUA', name: 'Cuaderno', price: 11000, cost: 6000, tax_rate: 10, min_stock: 2 })).body.id
    await call('boss', 'POST', '/stock/adjust', { productId: pid, delta: 10, reason: 'Inventario inicial', initial: true })
    await call('cash', 'POST', '/cash/open', { openingFloat: 0 })
    const s = await call('cash', 'POST', '/sales', { items: [{ productId: pid, qty: 2 }], payments: [{ method: 'cash', amount: 12000 }, { method: 'card', amount: 10000 }] })
    expect(s.status).toBe(201)
    const tb = (await call('acc', 'GET', '/accounting/trial-balance')).body
    expect(tb.totalDebit).toBe(tb.totalCredit)
    const bal = (code: string) => tb.rows.find((r: any) => r.code === code)
    expect(bal('4.1.01').balance).toBe(20000) // 22000 con IVA incluido => 20000 neto
    expect(bal('2.1.02').balance).toBe(2000)
    expect(bal('5.1.01').balance).toBe(12000)
    const invs = (await call('acc', 'GET', '/invoices')).body
    expect(invs[0]).toMatchObject({ kind: 'invoice', status: 'approved', total: 22000, tax10: 22000 })
    expect(invs[0].number).toMatch(/^001-001-\d{7}$/)
  })

  it('el balance general cuadra y la anulación genera nota de crédito y asiento inverso', async () => {
    const sale = (await call('boss', 'GET', '/sales')).body[0]
    await call('boss', 'POST', '/cash/open', { openingFloat: 0 })
    expect((await call('boss', 'POST', `/sales/${sale.id}/void`, { reason: 'Error de carga' })).status).toBe(200)
    const invs = (await call('acc', 'GET', '/invoices')).body
    expect(invs.find((i: any) => i.kind === 'credit_note')).toMatchObject({ status: 'approved', total: 22000 })
    const is = (await call('acc', 'GET', '/accounting/income-statement')).body
    expect(is.netIncome).toBe(0)
    const bs = (await call('acc', 'GET', '/accounting/balance-sheet')).body
    expect(bs.balanced).toBe(true)
  })

  it('registra un cheque como medio de pago y en cheques a depositar', async () => {
    const sale = await call('cash', 'POST', '/sales', { items: [{ productId: pid, qty: 1 }], payments: [{ method: 'check', amount: 11000, details: { number: '000123', bank: 'Banco Itaú', holder: 'Ana Gómez' } }] })
    expect(sale.status).toBe(201)
    const detail = (await call('cash', 'GET', `/sales/${sale.body.id}`)).body
    expect(detail.payments).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'check', amount: 11000 })]))
    const tb = (await call('acc', 'GET', '/accounting/trial-balance')).body
    expect(tb.rows.find((row: any) => row.code === '1.1.07')?.balance).toBe(11000)
    expect(tb.totalDebit).toBe(tb.totalCredit)
  })

  it('el contador no puede vender ni ajustar stock; los asientos manuales exigen partida doble', async () => {
    expect((await call('acc', 'POST', '/sales', { items: [{ productId: pid, qty: 1 }], payments: [] })).status).toBe(403)
    expect((await call('acc', 'POST', '/accounting/entries', { description: 'Saldo inicial', lines: [{ code: '1.1.01', debit: 5000 }, { code: '3.1.01', credit: 4000 }] })).status).toBe(500)
    expect((await call('acc', 'POST', '/accounting/entries', { description: 'Saldo inicial', lines: [{ code: '1.1.01', debit: 5000 }, { code: '3.1.01', credit: 5000 }] })).status).toBe(201)
    expect((await call('acc', 'POST', '/accounting/entries', { description: 'Cuenta rara', lines: [{ code: '9.9.9', debit: 1 }, { code: '3.1.01', credit: 1 }] })).status).toBe(400)
  })
})

describe('Tienda en línea, reservas y pagos', () => {
  let pid: number
  const order = (qty: number) => call('', 'POST', '/shop/orders', {
    customer: { name: 'Ana Gómez', phone: '+595981222333' }, items: [{ productId: pid, qty }], delivery: { method: 'pickup' },
  })
  const confirm = (ref: string, amount: number, ok = true) => app.inject({ method: 'POST', url: '/api/webhooks/bancard', payload: buildConfirmation(ref, amount, ok) })

  it('crea el pedido, reserva stock y la confirmación firmada lo cobra una sola vez', async () => {
    pid = (await call('boss', 'POST', '/products', { code: 'ULT2', name: 'Libro agotable', price: 50000, cost: 30000 })).body.id
    await call('boss', 'POST', '/stock/adjust', { productId: pid, delta: 3, reason: 'Inventario inicial' })
    const o = await order(2)
    expect(o.status).toBe(201)
    expect(await stockOf('ULT2')).toEqual({ stock: 3, reserved: 2 })
    expect((await order(2)).status).toBe(409) // la reserva evita sobreventa entre canales
    const ref = (await db.query('SELECT provider_ref FROM payment_attempts ORDER BY id DESC LIMIT 1')).rows[0].provider_ref

    const forged = await app.inject({ method: 'POST', url: '/api/webhooks/bancard', payload: { operation: { token: 'x', shop_process_id: ref, response: 'S', amount: '100000.00', currency: 'PYG' } } })
    expect(forged.statusCode).toBe(403) // “ya pagué” sin firma no cobra
    expect((await db.query('SELECT payment_status FROM orders WHERE number = $1', [o.body.order.number])).rows[0].payment_status).toBe('pending')

    expect((await confirm(ref, 100000)).statusCode).toBe(200)
    expect((await confirm(ref, 100000)).statusCode).toBe(200) // notificación repetida
    expect(await stockOf('ULT2')).toEqual({ stock: 1, reserved: 0 })
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM sales WHERE channel = 'web'`)).rows[0].n).toBe(1)
    const st = await call('', 'GET', `/shop/orders/${o.body.order.number}?token=${o.body.order.lookup_token}`)
    expect(st.body).toMatchObject({ payment_status: 'approved', status: 'confirmed', delivery_status: 'pending' })
    expect((await call('', 'GET', `/shop/orders/${o.body.order.number}?token=mal`)).status).toBe(404)
  })

  it('el pedido avanza por estados de entrega y notifica al cliente', async () => {
    const id = (await db.query(`SELECT id FROM orders ORDER BY id DESC LIMIT 1`)).rows[0].id
    expect((await call('cash', 'POST', `/orders/${id}/delivery`, { status: 'dispatched' })).status).toBe(409) // retiro no se despacha
    expect((await call('cash', 'POST', `/orders/${id}/delivery`, { status: 'preparing' })).status).toBe(200)
    expect((await call('cash', 'POST', `/orders/${id}/delivery`, { status: 'ready' })).status).toBe(200)
    expect((await call('cash', 'POST', `/orders/${id}/delivery`, { status: 'delivered', receivedBy: 'Cliente' })).status).toBe(200)
    const flushed = await flushOutbox(db)
    expect(flushed.sent).toBeGreaterThan(0)
  })

  it('una reserva vencida libera el stock; un pago tardío sin stock abre una excepción', async () => {
    // quedan 1 unidad física
    const o = await order(1)
    expect(await stockOf('ULT2')).toEqual({ stock: 1, reserved: 1 })
    await db.query(`UPDATE orders SET reserve_expires_at = now() - interval '1 minute' WHERE number = $1`, [o.body.order.number])
    expect(await releaseExpiredReservations(db)).toBe(1)
    expect(await stockOf('ULT2')).toEqual({ stock: 1, reserved: 0 })
    // otro cliente se lleva la última unidad
    await call('boss', 'POST', '/stock/adjust', { productId: pid, delta: -1, reason: 'Vendida en local' })
    const ref = (await db.query('SELECT provider_ref FROM payment_attempts WHERE order_id = $1', [o.body.order.id])).rows[0].provider_ref
    await confirm(ref, 50000)
    const row = (await db.query('SELECT payment_status, status, exception FROM orders WHERE id = $1', [o.body.order.id])).rows[0]
    expect(row.payment_status).toBe('approved')
    expect(row.status).toBe('cancelled')
    expect(row.exception).toMatch(/sin stock/)
    expect((await call('boss', 'POST', `/orders/${o.body.order.id}/refund`, { reason: 'Sin stock' })).body.payment_status).toBe('refunded')
    const tb = (await call('acc', 'GET', '/accounting/trial-balance')).body
    expect(tb.totalDebit).toBe(tb.totalCredit)
  })

  it('el delivery exige zona y suma el costo de envío', async () => {
    await call('boss', 'POST', '/stock/adjust', { productId: pid, delta: 5, reason: 'Reposición' })
    const zone = (await call('boss', 'POST', '/delivery-zones', { name: 'Centro', fee: 15000 })).body
    const bad = await call('', 'POST', '/shop/orders', { customer: { name: 'Luis Paz', phone: '+595981000111' }, items: [{ productId: pid, qty: 1 }], delivery: { method: 'delivery' } })
    expect(bad.status).toBe(400)
    const ok = await call('', 'POST', '/shop/orders', { customer: { name: 'Luis Paz', phone: '+595981000111' }, items: [{ productId: pid, qty: 1 }], delivery: { method: 'delivery', zoneId: zone.id, address: 'Av. Mcal. López 123' } })
    expect(Number(ok.body.order.total)).toBe(65000)
  })
})

describe('Reposición, chatbot y órdenes de trabajo', () => {
  it('la reposición se sugiere una sola vez y la compra requiere aprobación', async () => {
    const pid = (await call('boss', 'POST', '/products', { code: 'REP', name: 'Resma', price: 40000, cost: 30000, min_stock: 5, purchase_unit: 'caja', units_per_purchase: 10 })).body.id
    const sup = (await call('boss', 'POST', '/suppliers', { name: 'Distribuidora', whatsapp: '+595981999888' })).body.id
    await call('boss', 'POST', '/stock/adjust', { productId: pid, delta: 4, reason: 'Inventario' }) // 4 <= mínimo 5
    await call('boss', 'POST', '/stock/adjust', { productId: pid, delta: -1, reason: 'Dañado' })
    const reps = (await call('boss', 'GET', '/replenishments')).body.filter((r: any) => r.product_id === pid)
    expect(reps).toHaveLength(1)
    expect(reps[0].suggested_qty).toBe(6) // al llegar al mínimo: 2*5 - 4
    const alerts = async () => (await db.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'low_stock' AND (data->>'productId')::int = $1`, [pid])).rows[0].n
    expect(await alerts()).toBe(1) // una sola alerta aunque el stock siga bajando
    await call('boss', 'POST', '/stock/adjust', { productId: pid, delta: 20, reason: 'Reposición' })
    expect(await alerts()).toBe(1) // al reponer no avisa
    await call('boss', 'POST', '/stock/adjust', { productId: pid, delta: -20, reason: 'Conteo' })
    expect(await alerts()).toBe(2) // vuelve a bajar: nueva alerta
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM purchase_orders`)).rows[0].n).toBe(0) // todavía no se compró nada
    const ap = await call('boss', 'POST', `/replenishments/${reps[0].id}/approve`, { supplierId: sup })
    expect(ap.status).toBe(200)
    expect((await db.query(`SELECT body FROM outbox WHERE audience = 'supplier'`)).rows[0].body).toMatch(/Resma/)
    expect((await call('boss', 'POST', `/replenishments/${reps[0].id}/approve`, { supplierId: sup })).status).toBe(409)
  })

  it('el chatbot busca, arma el carrito, crea el pedido con enlace de pago y no inventa pagos', async () => {
    const pid = (await call('boss', 'POST', '/products', { code: 'CAR', name: 'Carpeta oficio', price: 9000, cost: 5000 })).body.id
    await call('boss', 'POST', '/stock/adjust', { productId: pid, delta: 20, reason: 'Inventario' })
    const me = '+595981555444'
    expect(await chatReply(db, 'whatsapp', me, 'hola')).toMatch(/asistente/)
    expect(await chatReply(db, 'whatsapp', me, 'carpeta')).toMatch(/1\. Carpeta oficio — Gs\. 9\.000/)
    expect(await chatReply(db, 'whatsapp', me, 'agregar 1 x 3')).toMatch(/3 x Carpeta oficio/)
    expect(await chatReply(db, 'whatsapp', me, 'confirmar')).toMatch(/nombre/)
    await chatReply(db, 'whatsapp', me, 'María Benítez')
    expect(await chatReply(db, 'whatsapp', me, 'retiro')).toMatch(/Resumen/)
    const done = await chatReply(db, 'whatsapp', me, 'sí')
    expect(done).toMatch(/Pedido P-\d{6} creado por Gs\. 27\.000/)
    expect(done).toMatch(/\/pay\/BC/)
    const num = done.match(/P-\d{6}/)![0]
    expect(await chatReply(db, 'whatsapp', me, `ya pagué, estado ${num}`)).toMatch(/pendiente de pago/)
    expect(await chatReply(db, 'whatsapp', '+595000000000', `estado ${num}`)).toMatch(/No encontré/) // otro número no ve el pedido
  })

  it('orden de trabajo de impresión: presupuesto, anticipo y entrega cobrando el saldo en el POS', async () => {
    const wo = (await call('cash', 'POST', '/workorders', { customerName: 'Colegio', description: 'Examen 3er grado', copies: 40, pages: 2, finishing: 'anillado' })).body
    expect(wo.price).toBe(40 * 2 * 500 + 40 * 8000)
    expect((await call('cash', 'POST', `/workorders/${wo.id}/status`, { status: 'in_progress' })).status).toBe(409) // primero se aprueba
    await call('cash', 'POST', `/workorders/${wo.id}/status`, { status: 'approved' })
    expect((await call('cash', 'POST', `/workorders/${wo.id}/deposit`, { amount: 100000, method: 'cash' })).body.deposit).toBe(100000)
    await call('cash', 'POST', `/workorders/${wo.id}/status`, { status: 'in_progress' })
    await call('cash', 'POST', `/workorders/${wo.id}/status`, { status: 'ready' })
    const svc = (await db.query(`SELECT id FROM products WHERE code = 'IMP-SERV'`)).rows[0].id
    const balance = wo.price - 100000
    const sale = await call('cash', 'POST', '/sales', { workOrderId: wo.id, items: [{ productId: svc, qty: 1, unitPrice: wo.price }], payments: [{ method: 'cash', amount: balance }] })
    expect(sale.status).toBe(201)
    expect(sale.body.total).toBe(wo.price)
    expect((await db.query('SELECT status FROM work_orders WHERE id = $1', [wo.id])).rows[0].status).toBe('delivered')
    const tb = (await call('acc', 'GET', '/accounting/trial-balance')).body
    expect(tb.totalDebit).toBe(tb.totalCredit)
    expect(tb.rows.find((r: any) => r.code === '2.1.03')?.balance ?? 0).toBeGreaterThanOrEqual(0)
  })
})
