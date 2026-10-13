// Clientes de ejemplo con cuenta en la tienda, direcciones y pedidos en distintos estados.
// Uso: npx tsx src/db/demo-customers.ts   (repetible: si las cuentas ya existen, no hace nada)
import 'dotenv/config'
import { buildApp } from '../app.js'
import { buildConfirmation } from '../payments.js'
import { createPool, migrate } from './client.js'

const db = createPool(process.env.DATABASE_URL!)
await migrate(db)
const app = buildApp(db)
const call = async (token: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} })
  const body = r.headers['content-type']?.toString().includes('json') ? r.json() : null
  if (r.statusCode >= 300) throw new Error(`${method} ${url} → ${r.statusCode} ${JSON.stringify(body)}`)
  return body
}
const exists = await db.query(`SELECT 1 FROM customer_accounts WHERE email = 'ana@cliente.test'`)
if (exists.rowCount) { console.log('Los clientes de ejemplo ya existen.'); await db.end(); process.exit(0) }

await db.query(`UPDATE settings SET value = value || '{"codEnabled": true}'::jsonb WHERE key = 'shop'`)
const admin = (await call(null, 'POST', '/api/login', { username: 'admin', password: 'admin1234' })).token
const prods = (await call(null, 'GET', '/api/shop/products')).filter((p: any) => p.availability !== 'out')
const pick = (i: number) => prods[i % prods.length]
const cities = await call(null, 'GET', '/api/shop/cities')
const city = (name: string) => cities.find((c: any) => c.name === name).id

async function customer(first: string, last: string, email: string, doc: string, phone: string) {
  const r = await call(null, 'POST', '/api/shop/account/register', { firstName: first, lastName: last, email, password: 'Cliente123', confirm: 'Cliente123', phone, document: doc })
  await call(null, 'POST', '/api/shop/account/verify', { token: r.devVerifyToken })
  return r.token as string
}
const ana = await customer('Ana', 'Gómez', 'ana@cliente.test', '4123456', '+595981222333')
const luis = await customer('Luis', 'Paz', 'luis@cliente.test', '3654321', '+595982111444')
await customer('María', 'Benítez', 'maria@cliente.test', '80012345-6', '+595983555666')

await call(ana, 'POST', '/api/shop/account/addresses', { label: 'Casa', street: 'Av. Mcal. López', houseNumber: '1234', cityId: city('Asunción'), neighborhood: 'Recoleta', reference: 'Portón negro, frente a la farmacia', instructions: 'Tocar timbre' })
await call(ana, 'POST', '/api/shop/account/addresses', { label: 'Oficina', street: 'Calle Palma', houseNumber: '450', cityId: city('Lambaré'), neighborhood: 'Centro', recipientName: 'Recepción', recipientPhone: '+595981999888' })
await call(luis, 'POST', '/api/shop/account/addresses', { label: 'Casa', street: 'Ruta 2 km 14', cityId: city('Capiatá'), neighborhood: 'Itapytã', reference: 'Casa celeste' })
await call(ana, 'POST', `/api/shop/account/favorites/${pick(1).id}`)

const addr = (await call(ana, 'GET', '/api/shop/account/addresses'))[0]
const order = (tok: string, who: any, items: [any, number][], extra: any = {}) => call(tok, 'POST', '/api/shop/account/orders', {
  customer: { name: who, phone: '+595981222333', email: extra.email ?? 'ana@cliente.test' }, items: items.map(([p, qty]) => ({ productId: p.id, qty })), idempotencyKey: 'demo-' + Math.random().toString(36).slice(2),
  delivery: { method: 'pickup' }, paymentMethod: 'transfer', ...extra.body })
const payCard = async (r: any) => { const ref = (await db.query('SELECT provider_ref FROM payment_attempts WHERE order_id = $1', [r.order.id])).rows[0].provider_ref; await app.inject({ method: 'POST', url: '/api/webhooks/bancard', payload: buildConfirmation(ref, Number(r.order.total), true) }) }
const move = (id: number, status: string, extra: any = {}) => call(admin, 'POST', `/api/orders/${id}/delivery`, { status, ...extra })

// 1) Entregado a domicilio (tarjeta)
const o1 = await order(ana, 'Ana Gómez', [[pick(0), 1], [pick(2), 2]], { body: { delivery: { method: 'delivery', cityId: addr.cityId, address: `${addr.street} ${addr.houseNumber}`, reference: addr.reference, neighborhood: addr.neighborhood }, paymentMethod: 'bancard' } })
await payCard(o1); await move(o1.order.id, 'preparing'); await move(o1.order.id, 'ready'); await move(o1.order.id, 'dispatched', { carrier: 'Moto Express', trackingNumber: 'ME-1042', etaDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10) }); await move(o1.order.id, 'delivered', { receivedBy: 'Ana Gómez' })
// 2) En camino (tarjeta)
const o2 = await order(ana, 'Ana Gómez', [[pick(3), 1]], { body: { delivery: { method: 'delivery', cityId: addr.cityId, address: `${addr.street} ${addr.houseNumber}`, neighborhood: addr.neighborhood }, paymentMethod: 'bancard' } })
await payCard(o2); await move(o2.order.id, 'preparing'); await move(o2.order.id, 'ready'); await move(o2.order.id, 'dispatched', { carrier: 'Reparto propio' })
// 3) Pendiente de transferencia (necesita acción del cliente)
await order(ana, 'Ana Gómez', [[pick(4), 1]])
// 4) Luis: listo para retirar
const o4 = await order(luis, 'Luis Paz', [[pick(5), 2]], { body: { paymentMethod: 'bancard' }, email: 'luis@cliente.test' })
await payCard(o4); await move(o4.order.id, 'preparing'); await move(o4.order.id, 'ready')
// 5) Luis: pedido cancelado
const o5 = await order(luis, 'Luis Paz', [[pick(6), 1]], { email: 'luis@cliente.test' })
await call(luis, 'POST', `/api/shop/account/orders/${o5.order.number}/cancel-request`, { reason: 'Ya lo compré en el local' })
await call(admin, 'POST', `/api/orders/${o5.order.id}/cancel-request/resolve`, { approve: true, response: 'Cancelado' })
console.log('Clientes de ejemplo creados.')
await db.end()
