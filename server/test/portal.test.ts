import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { buildApp } from '../src/app.js'
import { hashPassword } from '../src/auth.js'
import { createPool, migrate, type Db } from '../src/db/client.js'
import { buildConfirmation } from '../src/payments.js'

const BASE = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'
const TEST_DB = 'libreria_samantha_test10'
let db: Db
let app: ReturnType<typeof buildApp>
const tokens: Record<string, string> = {}

async function call(who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, prefix = '/api') {
  const res = await app.inject({ method, url: prefix + url, payload: payload as any, headers: tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {} })
  const ct = String(res.headers['content-type'] ?? '')
  return { status: res.statusCode, body: ct.includes('json') ? res.json() : null, raw: res.rawPayload, headers: res.headers }
}
const C = (who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => call(who, method, '/account' + url, payload, '/api/shop')
const ok = (r: { status: number; body: any }) => { if (r.status >= 300) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`); return r.body }
const reg = { firstName: 'Ana', lastName: 'Gómez', email: 'ana@cliente.test', password: 'Cliente123', confirm: 'Cliente123', phone: '+595981222333', document: '4123456' }
let prod: any, pid: number, local: any

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: BASE })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${TEST_DB}`)
  await admin.end()
  db = createPool(BASE.replace(/\/[^/]*$/, '/' + TEST_DB))
  await migrate(db)
  for (const [u, role] of [['boss', 'owner'], ['cash', 'cashier']]) await db.query('INSERT INTO users (username, name, role, password_hash) VALUES ($1,$1,$2,$3)', [u, role, hashPassword('secret123')])
  await db.query(`INSERT INTO users (username, name, role, password_hash) VALUES ('web','Tienda web','support',$1)`, [hashPassword('x'.repeat(20))]).catch(() => {})
  app = buildApp(db)
  for (const u of ['boss', 'cash']) tokens[u] = (await call('', 'POST', '/login', { username: u, password: 'secret123' })).body.token
  prod = ok(await call('boss', 'POST', '/products', { name: 'Mochila escolar', price: 100000, cost: 60000, initial_stock: 10, min_stock: 2 }))
  pid = prod.id
  // cliente que ya existe en el local con el mismo correo
  local = ok(await call('cash', 'POST', '/customers', { name: 'Ana Gómez (local)', email: 'ana@cliente.test', phone: '+595981222333' }))
})
afterAll(async () => { await db.end() })

describe('Portal del cliente: cuenta, pedidos, seguimiento y devoluciones', () => {
  it('registro validado, contraseña segura y sin cuentas duplicadas', async () => {
    expect((await C('', 'POST', '/register', { ...reg, password: 'corta', confirm: 'corta' })).status).toBe(400)
    expect((await C('', 'POST', '/register', { ...reg, confirm: 'Otra12345' })).status).toBe(400)
    expect((await C('', 'POST', '/register', { ...reg, email: 'no-es-correo' })).status).toBe(400)
    const r = ok(await C('', 'POST', '/register', reg))
    tokens.ana = r.token
    expect(r.profile.emailVerified).toBe(false)
    expect(JSON.stringify(r)).not.toMatch(/password_hash|\$|scrypt/)
    ;(globalThis as any).verify = r.devVerifyToken
    expect((await C('', 'POST', '/register', reg)).status).toBe(409)
    const hash = (await db.query('SELECT password_hash FROM customer_accounts')).rows[0].password_hash
    expect(hash).not.toContain('Cliente123')
    // el personal no ve contraseñas de clientes en ninguna lista
    expect(JSON.stringify(ok(await call('cash', 'GET', '/customer-accounts')))).not.toMatch(/password|hash/)
  })

  it('verificar el correo vincula la ficha del local con el mismo correo, sin duplicarla', async () => {
    expect((await C('', 'POST', '/verify', { token: 'x'.repeat(30) })).status).toBe(400)
    ok(await C('', 'POST', '/verify', { token: (globalThis as any).verify }))
    expect(ok(await C('ana', 'GET', '/me')).emailVerified).toBe(true)
    expect(Number((await db.query('SELECT customer_id FROM customer_accounts')).rows[0].customer_id)).toBe(local.id)
    expect(Number((await db.query('SELECT COUNT(*) AS n FROM customers WHERE lower(email) = $1', ['ana@cliente.test'])).rows[0].n)).toBe(1)
    expect((await C('', 'POST', '/verify', { token: (globalThis as any).verify })).status).toBe(400) // un solo uso
    // un segundo cliente con nombre y teléfono iguales pero otro correo NO hereda esa ficha
    const b = ok(await C('', 'POST', '/register', { ...reg, email: 'otra@cliente.test' }))
    tokens.otra = b.token
    ok(await C('', 'POST', '/verify', { token: b.devVerifyToken }))
    expect(Number((await db.query(`SELECT customer_id FROM customer_accounts WHERE email = 'otra@cliente.test'`)).rows[0].customer_id)).not.toBe(local.id)
  })

  it('inicio de sesión, bloqueo por intentos, recuperación y cierre de sesión', async () => {
    expect((await C('', 'POST', '/login', { email: 'ana@cliente.test', password: 'incorrecta1' })).status).toBe(401)
    const l = ok(await C('', 'POST', '/login', { email: 'ANA@cliente.test', password: 'Cliente123' }))
    expect(l.token).toBeTruthy()
    expect((await C('', 'GET', '/me')).status).toBe(401)
    tokens.tmp = l.token
    ok(await C('tmp', 'POST', '/logout'))
    expect((await C('tmp', 'GET', '/me')).status).toBe(401)
    const f = ok(await C('', 'POST', '/forgot', { email: 'ana@cliente.test' }))
    expect((await C('', 'POST', '/forgot', { email: 'noexiste@x.com' })).body.message).toBe(f.message) // no revela quién existe
    ok(await C('', 'POST', '/reset', { token: f.devResetToken, password: 'Nueva12345' }))
    expect((await C('', 'POST', '/login', { email: 'ana@cliente.test', password: 'Cliente123' })).status).toBe(401)
    tokens.ana = ok(await C('', 'POST', '/login', { email: 'ana@cliente.test', password: 'Nueva12345' })).token
    for (let i = 0; i < 5; i++) await C('', 'POST', '/login', { email: 'otra@cliente.test', password: 'mala12345' })
    expect((await C('', 'POST', '/login', { email: 'otra@cliente.test', password: 'Cliente123' })).status).toBe(429) // cuenta bloqueada un rato
    // el correo nuevo se aplica recién al verificarlo
    const ch = ok(await C('ana', 'POST', '/me/email', { email: 'ana.nueva@cliente.test', password: 'Nueva12345' }))
    expect(ok(await C('ana', 'GET', '/me')).email).toBe('ana@cliente.test')
    ok(await C('', 'POST', '/verify', { token: ch.devVerifyToken }))
    expect(ok(await C('ana', 'GET', '/me')).email).toBe('ana.nueva@cliente.test')
  })

  it('perfil, direcciones y una sola dirección predeterminada', async () => {
    const p = ok(await C('ana', 'PUT', '/me', { firstName: 'Ana', lastName: 'Gómez Ruiz', phone: '+595981000111', whatsapp: '+595981000111', document: '4123456', billingName: 'Ana Gómez', billingDoc: '4123456-0' }))
    expect(p.lastName).toBe('Gómez Ruiz')
    const city = (await db.query(`SELECT id FROM geo_cities WHERE name = 'Asunción'`)).rows[0].id
    const a1 = ok(await C('ana', 'POST', '/addresses', { label: 'Casa', street: 'Av. Mcal. López', houseNumber: '123', cityId: city, neighborhood: 'Recoleta', reference: 'Portón negro' }))
    expect(a1.isDefault).toBe(true)
    const a2 = ok(await C('ana', 'POST', '/addresses', { label: 'Oficina', street: 'Calle Palma', houseNumber: '45', cityId: city, recipientName: 'Recepción', recipientPhone: '+595981999888' }))
    expect(a2.isDefault).toBe(false)
    ok(await C('ana', 'POST', `/addresses/${a2.id}/default`))
    const list = ok(await C('ana', 'GET', '/addresses'))
    expect(list.filter((x: any) => x.isDefault)).toHaveLength(1)
    expect(list[0].id).toBe(a2.id)
    expect((await C('otra', 'PUT', `/addresses/${a1.id}`, { street: 'Hackeada' })).status).toBe(404) // no se toca la dirección ajena
    ;(globalThis as any).addr = a1
  })

  it('compra con cuenta: pedido único, reintento sin duplicar, pago y notificaciones', async () => {
    const a1 = (globalThis as any).addr
    const body = { customer: { name: 'Ana Gómez', phone: '+595981000111', email: 'ana.nueva@cliente.test' }, items: [{ productId: pid, qty: 2 }], idempotencyKey: 'k-1',
      delivery: { method: 'delivery', cityId: a1.cityId, address: `${a1.street} ${a1.houseNumber}`, reference: a1.reference, neighborhood: a1.neighborhood }, paymentMethod: 'bancard', recipient: { name: 'Pedro Gómez', phone: '+595981777666' } }
    const r1 = ok(await C('ana', 'POST', '/orders', body))
    const r2 = await C('ana', 'POST', '/orders', body) // doble clic / reenvío
    expect(r2.status).toBe(200)
    expect(r2.body.order.id).toBe(r1.order.id)
    expect(Number((await db.query('SELECT COUNT(*) AS n FROM orders WHERE account_id IS NOT NULL')).rows[0].n)).toBe(1)
    expect(Number((await db.query('SELECT reserved FROM products WHERE id = $1', [pid])).rows[0].reserved)).toBe(2) // la reserva no se duplicó
    expect(r1.order.recipient_name).toBe('Pedro Gómez')
    // cambiar el perfil después no toca el pedido ya hecho
    ok(await C('ana', 'PUT', '/me', { firstName: 'Anita', lastName: 'Otra', phone: '+595981000111' }))
    const det = ok(await C('ana', 'GET', `/orders/${r1.order.number}`))
    expect(det.delivery.recipientName).toBe('Pedro Gómez')
    expect(det.stage).toBe('pending')
    expect(det.actions).toEqual(expect.arrayContaining(['pay', 'cancel', 'message', 'reorder']))
    expect(det.progress.filter((p: any) => p.done).map((p: any) => p.stage)).toEqual(['pending']) // solo lo que realmente ocurrió
    const dash = ok(await C('ana', 'GET', '/dashboard'))
    expect(dash.needs.map((n: any) => n.kind)).toContain('pay')
    // la pasarela confirma dos veces: no se cobra ni descuenta dos veces
    const ref = (await db.query('SELECT provider_ref FROM payment_attempts WHERE order_id = $1', [r1.order.id])).rows[0].provider_ref
    const hook = () => app.inject({ method: 'POST', url: '/api/webhooks/bancard', payload: buildConfirmation(ref, Number(r1.order.total), true) })
    expect((await hook()).statusCode).toBe(200); expect((await hook()).statusCode).toBe(200)
    expect(Number((await db.query('SELECT stock FROM products WHERE id = $1', [pid])).rows[0].stock)).toBe(8)
    const paid = ok(await C('ana', 'GET', `/orders/${r1.order.number}`))
    expect(paid).toMatchObject({ stage: 'confirmed', payment: { status: 'approved' } })
    expect(paid.money).toMatchObject({ total: 230000, paid: 230000, pending: 0 }) // 2 x 100.000 + envío 30.000
    const notes = ok(await C('ana', 'GET', '/notifications'))
    expect(notes.items.map((n: any) => n.title)).toEqual(expect.arrayContaining(['Recibimos tu pedido', 'Pago confirmado']))
    expect(Number((await db.query(`SELECT COUNT(*) AS n FROM outbox WHERE channel = 'email' AND to_email = 'ana.nueva@cliente.test'`)).rows[0].n)).toBeGreaterThan(0)
    // la venta quedó ligada a la ficha del local
    expect(Number((await db.query('SELECT customer_id FROM sales WHERE id = (SELECT sale_id FROM orders WHERE id = $1)', [r1.order.id])).rows[0].customer_id)).toBe(local.id)
    ;(globalThis as any).o = r1.order
  })

  it('cada cliente ve solo lo suyo y el personal no filtra notas internas', async () => {
    const o = (globalThis as any).o
    expect((await C('otra', 'GET', `/orders/${o.number}`)).status).toBe(404)
    expect(ok(await C('otra', 'GET', '/orders')).total).toBe(0)
    expect((await C('', 'GET', '/orders')).status).toBe(401)
    ok(await call('cash', 'POST', `/orders/${o.id}/notes`, { note: 'Cliente pidió llamar antes', visible: false }))
    ok(await call('cash', 'POST', `/orders/${o.id}/notes`, { note: 'Te llamamos al llegar', visible: true }))
    const det = ok(await C('ana', 'GET', `/orders/${o.number}`))
    expect(JSON.stringify(det)).not.toContain('llamar antes')
    expect(det.messages.map((m: any) => m.note)).toContain('Te llamamos al llegar')
  })

  it('preparación → envío → entrega desde el administrador se refleja en el perfil y avisa', async () => {
    const o = (globalThis as any).o
    const s = (status: string, x: any = {}) => call('cash', 'POST', `/orders/${o.id}/delivery`, { status, ...x })
    ok(await s('preparing'))
    expect(ok(await C('ana', 'GET', `/orders/${o.number}`)).stage).toBe('preparing')
    ok(await s('ready')); ok(await s('dispatched', { carrier: 'Moto Express', etaDate: '2030-05-01' }))
    const det = ok(await C('ana', 'GET', `/orders/${o.number}`))
    expect(det).toMatchObject({ stage: 'shipped', delivery: { carrier: 'Moto Express', eta: '2030-05-01' } })
    expect(det.actions).not.toContain('cancel') // ya salió
    expect(det.actions).toContain('return')
    ok(await s('delivered', { receivedBy: 'Pedro Gómez' }))
    expect(ok(await C('ana', 'GET', `/orders/${o.number}`))).toMatchObject({ stage: 'delivered', delivery: { receivedBy: 'Pedro Gómez' } })
    const titles = ok(await C('ana', 'GET', '/notifications')).items.map((n: any) => n.title)
    expect(titles).toEqual(expect.arrayContaining(['En preparación', 'Tu pedido va en camino', 'Pedido entregado']))
    const inv = ok(await C('ana', 'GET', `/orders/${o.number}`)).invoices
    if (inv.length) {
      const pdf = await C('ana', 'GET', `/orders/${o.number}/invoice/${inv[0].id}`)
      expect(pdf.raw.subarray(0, 4).toString()).toBe('%PDF')
    }
  })

  it('devolución: solicitud → aprobación → recepción verificada → reembolso (el stock vuelve solo al recibirla)', async () => {
    const o = (globalThis as any).o
    const item = ok(await C('ana', 'GET', `/orders/${o.number}`)).items[0]
    expect((await C('ana', 'POST', `/orders/${o.number}/return-request`, { reason: 'Defecto', items: [{ orderItemId: item.id, qty: 5 }] })).status).toBe(409)
    const rr = ok(await C('ana', 'POST', `/orders/${o.number}/return-request`, { reason: 'Se rompió el cierre', items: [{ orderItemId: item.id, qty: 1 }] }))
    const stock = async () => Number((await db.query('SELECT stock FROM products WHERE id = $1', [pid])).rows[0].stock)
    expect(await stock()).toBe(8)
    expect((await call('cash', 'POST', `/order-returns/${rr.id}/receive`, { restock: true })).status).toBe(409) // primero se aprueba
    ok(await call('cash', 'POST', `/order-returns/${rr.id}/approve`, { instructions: 'Traela al local con la factura' }))
    expect(ok(await C('ana', 'GET', `/orders/${o.number}`)).returns[0]).toMatchObject({ status: 'approved', instructions: 'Traela al local con la factura' })
    expect(await stock()).toBe(8) // todavía no volvió
    ok(await call('cash', 'POST', `/order-returns/${rr.id}/receive`, { restock: true }))
    expect((await call('cash', 'POST', `/order-returns/${rr.id}/process-refund`, { method: 'transfer' })).status).toBe(403) // reembolsar requiere permiso
    ok(await call('boss', 'POST', `/order-returns/${rr.id}/process-refund`, { method: 'transfer' }))
    expect(await stock()).toBe(9)
    const after = ok(await C('ana', 'GET', `/orders/${o.number}`))
    expect(after.returns[0].status).toBe('refunded')
    expect(after.payment.status).toBe('partially_refunded')
    expect(after.money.refunded).toBe(100000)
    const tb = ok(await call('boss', 'GET', '/accounting/trial-balance'))
    expect(tb.totalDebit).toBe(tb.totalCredit)
  })

  it('cancelación solicitada antes del despacho libera la reserva; "volver a comprar" revisa precio y stock', async () => {
    const body = { customer: { name: 'Ana', phone: '+595981000111', email: 'ana.nueva@cliente.test' }, items: [{ productId: pid, qty: 3 }], delivery: { method: 'pickup' }, paymentMethod: 'transfer', idempotencyKey: 'k-2' }
    const r = ok(await C('ana', 'POST', '/orders', body))
    const reserved = async () => Number((await db.query('SELECT reserved FROM products WHERE id = $1', [pid])).rows[0].reserved)
    expect(await reserved()).toBe(3)
    ok(await C('ana', 'POST', `/orders/${r.order.number}/cancel-request`, { reason: 'Me equivoqué de producto' }))
    expect(ok(await C('ana', 'GET', `/orders/${r.order.number}`)).cancelRequested).toBe(true)
    const dash = ok(await call('cash', 'GET', '/orders/counters'))
    expect(dash.cancel_requests).toBe(1)
    ok(await call('cash', 'POST', `/orders/${r.order.id}/cancel-request/resolve`, { approve: true, response: 'Listo' }))
    expect(await reserved()).toBe(0)
    const det = ok(await C('ana', 'GET', `/orders/${r.order.number}`))
    expect(det).toMatchObject({ stage: 'cancelled', status: 'cancelled' })
    expect(det.actions).toContain('reorder')
    await db.query('UPDATE products SET price = 120000 WHERE id = $1', [pid])
    const re = ok(await C('ana', 'POST', `/orders/${r.order.number}/reorder`))
    expect(re.items[0]).toMatchObject({ id: pid, qty: 3, price: 120000, oldPrice: 100000, priceChanged: true })
  })

  it('retiro en el local no exige dirección; favoritos y datos del cliente en el administrador', async () => {
    const r = ok(await C('ana', 'POST', '/orders', { customer: { name: 'Ana', phone: '+595981000111' }, items: [{ productId: pid, qty: 1 }], delivery: { method: 'pickup' }, paymentMethod: 'transfer' }))
    expect(r.order.delivery_method).toBe('pickup')
    ok(await C('ana', 'POST', `/favorites/${pid}`))
    expect(ok(await C('ana', 'GET', '/favorites'))[0].id).toBe(pid)
    expect(JSON.stringify(ok(await C('ana', 'GET', '/favorites')))).not.toMatch(/"stock"|"cost"/)
    const portal = ok(await call('cash', 'GET', `/customers/${local.id}/portal`))
    expect(portal.account.email).toBe('ana.nueva@cliente.test')
    expect(portal.orders.length).toBeGreaterThanOrEqual(3)
    expect(portal.addresses.length).toBe(2)
    expect(portal.stats.pendingPayments).toBeGreaterThan(0)
    const search = ok(await call('cash', 'GET', '/orders?q=4123456'))
    expect(Array.isArray(search)).toBe(true)
    const m = ok(await call('cash', 'GET', '/orders/metrics'))
    expect(m.orders).toBeGreaterThanOrEqual(3)
  })
})
