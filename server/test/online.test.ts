import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { buildApp } from '../src/app.js'
import { hashPassword } from '../src/auth.js'
import { createPool, migrate, type Db } from '../src/db/client.js'
import { buildConfirmation } from '../src/payments.js'

const BASE = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'
const TEST_DB = 'libreria_samantha_test8'
let db: Db
let app: ReturnType<typeof buildApp>
const tokens: Record<string, string> = {}

async function call(who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url: '/api' + url, payload: payload as any, headers: tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {} })
  const ct = String(res.headers['content-type'] ?? '')
  return { status: res.statusCode, body: ct.includes('json') ? res.json() : null, raw: res.rawPayload, headers: res.headers }
}
const ok = (r: { status: number; body: any }) => { if (r.status >= 300) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`); return r.body }
const png = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), Buffer.alloc(400, 1)]).toString('base64')

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: BASE })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${TEST_DB}`)
  await admin.end()
  db = createPool(BASE.replace(/\/[^/]*$/, '/' + TEST_DB))
  await migrate(db)
  for (const [u, role] of [['boss', 'owner'], ['cash', 'cashier']]) {
    await db.query('INSERT INTO users (username, name, role, password_hash) VALUES ($1,$1,$2,$3)', [u, role, hashPassword('secret123')])
  }
  await db.query(`INSERT INTO users (username, name, role, password_hash) VALUES ('web','Tienda web','support',$1)`, [hashPassword('x'.repeat(20))]).catch(() => {})
  app = buildApp(db)
  for (const u of ['boss', 'cash']) tokens[u] = (await call('', 'POST', '/login', { username: u, password: 'secret123' })).body.token
})
afterAll(async () => { await db.end() })

let prod: any, asuncion: number, concepcion: number, bank: any

describe('Tienda online: ciudades, tarifas, transferencias y entrega', () => {
  it('el catálogo de ciudades trae Paraguay y la tarifa base es de Gs. 30.000', async () => {
    const cities = ok(await call('', 'GET', '/shop/cities'))
    expect(cities.length).toBeGreaterThan(100)
    asuncion = cities.find((c: any) => c.name === 'Asunción').id
    concepcion = cities.find((c: any) => c.name === 'Concepción').id
    const q = ok(await call('', 'GET', `/shop/delivery/quote?cityId=${asuncion}`))
    expect(q).toMatchObject({ covered: true, fee: 30000 })
    expect(ok(await call('', 'GET', `/shop/delivery/quote?cityId=${concepcion}`)).covered).toBe(false)
    // el local fija la tarifa propia y las zonas especiales de una ciudad
    ok(await call('boss', 'PUT', `/delivery/cities/${concepcion}`, { covered: true, price: 55000, eta: '2 a 3 días', specialZones: [{ name: 'Barrio Lejano', fee: 70000 }] }))
    expect(ok(await call('', 'GET', `/shop/delivery/quote?cityId=${concepcion}`)).fee).toBe(55000)
    expect(ok(await call('', 'GET', `/shop/delivery/quote?cityId=${concepcion}&zone=Barrio%20Lejano`)).fee).toBe(70000)
    expect((await call('cash', 'PUT', `/delivery/cities/${concepcion}`, { price: 1 })).status).toBe(403)
  })

  it('el cliente ve solo disponibilidad (nunca cantidades) y el servidor recalcula la tarifa', async () => {
    prod = ok(await call('boss', 'POST', '/products', { name: 'Mochila escolar', price: 100000, cost: 60000, initial_stock: 5, min_stock: 2 }))
    bank = ok(await call('boss', 'POST', '/money-accounts', { kind: 'bank', name: 'Cuenta Itaú Gs.', bankName: 'Itaú', accountNumber: '700123456', holder: 'Librería Samantha SRL', holderDocument: '80012345-6', alias: 'samantha.pagos', onlineEnabled: true }))
    const shop = ok(await call('', 'GET', `/shop/products/${prod.id}`))
    expect(shop.availability).toBe('available')
    expect(JSON.stringify(shop)).not.toMatch(/"stock"|"reserved"|"cost"/)
    const opts = ok(await call('', 'GET', '/shop/payment-options'))
    expect(opts.transfer.enabled).toBe(true)
    expect(opts.transfer.accounts.find((a: any) => a.id === bank.id)).toMatchObject({ holder: 'Librería Samantha SRL', alias: 'samantha.pagos' })
    expect(opts.transfer.accounts.some((a: any) => a.is_demo)).toBe(true) // la cuenta de ejemplo viene marcada como demo
    expect(opts.transfer.accounts[0].opening_balance).toBeUndefined()
    const mk = (extra: any) => call('', 'POST', '/shop/orders', { customer: { name: 'Ana Gómez', phone: '+595981222333' }, items: [{ productId: prod.id, qty: 1 }], paymentMethod: 'transfer', ...extra })
    expect((await mk({ delivery: { method: 'delivery', address: 'Calle 1' } })).status).toBe(400) // falta ciudad
    const noCover = await mk({ delivery: { method: 'delivery', cityId: (await db.query(`SELECT id FROM geo_cities WHERE name = 'Filadelfia'`)).rows[0].id, address: 'Calle 1' } })
    expect(noCover.status).toBe(409)
    const o = ok(await mk({ delivery: { method: 'delivery', cityId: asuncion, address: 'Av. Mcal. López 123', reference: 'Portón negro' } }))
    expect(o.payment).toBeNull()
    expect(Number(o.order.delivery_fee)).toBe(30000)
    expect(Number(o.order.total)).toBe(130000)
    const row = (await db.query('SELECT city_name, department, tariff_source, payment_method, address_reference FROM orders WHERE id = $1', [o.order.id])).rows[0]
    expect(row).toMatchObject({ city_name: 'Asunción', department: 'Capital', tariff_source: 'base', payment_method: 'transfer', address_reference: 'Portón negro' })
    // cambiar la tarifa después no altera el pedido ya hecho
    ok(await call('boss', 'PUT', `/delivery/cities/${asuncion}`, { price: 45000 }))
    expect(Number((await db.query('SELECT delivery_fee FROM orders WHERE id = $1', [o.order.id])).rows[0].delivery_fee)).toBe(30000)
    ;(globalThis as any).o = o
  })

  it('la transferencia: comprobante → en revisión → rechazo con motivo → nuevo comprobante → aprobación cumple el pedido', async () => {
    const o = (globalThis as any).o
    const tracking = ok(await call('', 'GET', `/shop/orders/${o.order.number}?token=${o.order.lookup_token}`))
    expect(tracking.transfer_accounts).toHaveLength(2)
    expect(tracking.payment_method).toBe('transfer')
    const proof = (extra: any = {}) => call('', 'POST', `/shop/orders/${o.order.number}/proof`, { token: o.order.lookup_token, accountId: bank.id, amount: 130000, reference: 'TR-998', filename: 'comprobante.png', mime: 'image/png', dataBase64: png, ...extra })
    expect((await proof({ mime: 'application/x-msdownload' })).status).toBe(400)
    expect((await proof({ token: 'otro' })).status).toBe(404)
    expect((await proof()).status).toBe(201)
    expect((await proof()).status).toBe(409) // ya está en revisión
    expect((await db.query('SELECT payment_status FROM orders WHERE id = $1', [o.order.id])).rows[0].payment_status).toBe('in_review')
    // el stock sigue reservado durante la revisión y no se vende dos veces
    expect(Number((await db.query('SELECT reserved FROM products WHERE id = $1', [prod.id])).rows[0].reserved)).toBe(1)
    let proofs = ok(await call('cash', 'GET', '/payment-proofs?status=pending'))
    expect(proofs).toHaveLength(1)
    const file = await call('cash', 'GET', `/payment-proofs/${proofs[0].id}/file`)
    expect(file.status).toBe(200)
    expect((await call('cash', 'POST', `/payment-proofs/${proofs[0].id}/reject`, { reason: 'x' })).status).toBe(400)
    ok(await call('cash', 'POST', `/payment-proofs/${proofs[0].id}/reject`, { reason: 'El importe no coincide con el pedido' }))
    const after = ok(await call('', 'GET', `/shop/orders/${o.order.number}?token=${o.order.lookup_token}`))
    expect(after.payment_status).toBe('rejected')
    expect(after.proof_rejected_reason).toMatch(/importe/)
    expect((await proof({ reference: 'TR-999' })).status).toBe(201)
    proofs = ok(await call('cash', 'GET', '/payment-proofs?status=pending'))
    // un importe distinto al del pedido no se puede aprobar
    expect((await call('cash', 'POST', `/payment-proofs/${proofs[0].id}/approve`, { amountReceived: 100000 })).status).toBe(409)
    ok(await call('cash', 'POST', `/payment-proofs/${proofs[0].id}/approve`, { amountReceived: 130000 }))
    const done = (await db.query('SELECT payment_status, status, sale_id FROM orders WHERE id = $1', [o.order.id])).rows[0]
    expect(done).toMatchObject({ payment_status: 'approved', status: 'confirmed' })
    // venta, stock y dinero en la cuenta bancaria elegida
    expect(Number((await db.query('SELECT stock FROM products WHERE id = $1', [prod.id])).rows[0].stock)).toBe(4)
    const pay = (await db.query('SELECT method, account_id, amount FROM payments WHERE sale_id = $1', [done.sale_id])).rows[0]
    expect(pay).toMatchObject({ method: 'transfer', account_id: bank.id })
    const bal = ok(await call('boss', 'GET', '/money-accounts')).find((a: any) => a.id === bank.id)
    expect(Number(bal.balance)).toBe(130000)
    expect((await call('cash', 'POST', `/payment-proofs/${proofs[0].id}/approve`, {})).status).toBe(409) // ya revisado
    const tb = ok(await call('boss', 'GET', '/accounting/trial-balance'))
    expect(tb.totalDebit).toBe(tb.totalCredit)
  })

  it('estados de entrega: preparación → listo → despacho → entrega, con incidencias, constancia y registro', async () => {
    const o = (globalThis as any).o
    const set = (status: string, extra: any = {}) => call('cash', 'POST', `/orders/${o.order.id}/delivery`, { status, ...extra })
    expect((await set('delivered')).status).toBe(409) // hay que preparar primero
    ok(await set('preparing'))
    expect((await set('dispatched')).status).toBe(409) // primero queda listo para envío
    ok(await set('ready'))
    expect((await set('incident')).status).toBe(400) // la incidencia necesita descripción
    ok(await set('incident', { reason: 'Dirección no encontrada', rescheduleFor: '2030-01-02' }))
    ok(await set('dispatched', { carrier: 'Moto Express', trackingNumber: 'ME-77', etaDate: '2030-01-03', visibleNote: 'Segundo intento' }))
    expect((await set('delivered')).status).toBe(400) // falta quién recibió
    ok(await set('delivered', { receivedBy: 'Ana Gómez' }))
    const det = ok(await call('cash', 'GET', `/orders/${o.order.id}`))
    expect(det).toMatchObject({ delivery_status: 'delivered', status: 'completed', carrier: 'Moto Express', tracking_number: 'ME-77', received_by: 'Ana Gómez', stage: 'delivered' })
    expect(det.delivered_at).toBeTruthy()
    expect(det.history.map((e: any) => e.to_state)).toEqual(expect.arrayContaining(['preparing', 'ready', 'incident', 'dispatched', 'delivered']))
    expect(det.delivery_attempts).toHaveLength(1)
    expect(det.lookup_token).toBeUndefined()
    const page = ok(await call('cash', 'GET', '/orders?page=1&pageSize=15&payMethod=transfer'))
    expect(page.total).toBe(1)
    expect(ok(await call('cash', 'GET', '/orders?todo=1')).length).toBe(0)
    expect(ok(await call('cash', 'GET', '/orders/counters')).pending).toBeGreaterThanOrEqual(0)
  })

  it('pago con tarjeta en línea con retiro en local sigue funcionando y descuenta el stock', async () => {
    const o = ok(await call('', 'POST', '/shop/orders', { customer: { name: 'Luis Paz', phone: '+595981000111' }, items: [{ productId: prod.id, qty: 2 }], delivery: { method: 'pickup' } }))
    expect(o.payment.url).toBeTruthy()
    const ref = (await db.query('SELECT provider_ref FROM payment_attempts WHERE order_id = $1', [o.order.id])).rows[0].provider_ref
    expect((await app.inject({ method: 'POST', url: '/api/webhooks/bancard', payload: buildConfirmation(ref, Number(o.order.total), true) })).statusCode).toBe(200)
    expect(Number((await db.query('SELECT stock FROM products WHERE id = $1', [prod.id])).rows[0].stock)).toBe(2)
    const mv = (await db.query(`SELECT type, stock_before, stock_after FROM stock_movements WHERE product_id = $1 ORDER BY id DESC LIMIT 1`, [prod.id])).rows[0]
    expect(mv).toMatchObject({ type: 'online_sale', stock_before: 4, stock_after: 2 })
    // sin stock suficiente se rechaza en la creación y nunca se muestra el número
    const bad = await call('', 'POST', '/shop/orders', { customer: { name: 'Luis Paz', phone: '+595981000111' }, items: [{ productId: prod.id, qty: 9 }], delivery: { method: 'pickup' } })
    expect(bad.status).toBe(409)
  })
})
