import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import sharp from 'sharp'
import { buildApp } from '../src/app.js'
import { hashPassword } from '../src/auth.js'
import { createPool, migrate, type Db } from '../src/db/client.js'

const BASE = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'
const TEST_DB = 'libreria_samantha_test6'
let db: Db
let app: ReturnType<typeof buildApp>
const tokens: Record<string, string> = {}

async function call(who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, prefix = '/api') {
  const res = await app.inject({ method, url: prefix + url, payload: payload as any, headers: tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {} })
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
  for (const [u, role] of [['boss', 'owner'], ['cash', 'cashier'], ['buyer', 'buyer']]) {
    await db.query('INSERT INTO users (username, name, role, password_hash) VALUES ($1,$1,$2,$3)', [u, role, hashPassword('secret123')])
  }
  app = buildApp(db)
  for (const u of ['boss', 'cash', 'buyer']) tokens[u] = (await call('', 'POST', '/login', { username: u, password: 'secret123' })).body.token
})
afterAll(async () => { await db.end() })

let p1: any

describe('Productos: alta, validaciones, precios, ofertas, imágenes y baja', () => {
  it('crea con código automático, stock inicial y valida duplicados', async () => {
    p1 = ok(await call('boss', 'POST', '/products', { name: 'Cuaderno 100 hojas', category: 'Papelería', price: 11000, cost: 6000, barcode: '7890001', initial_stock: 20, min_stock: 5 }))
    expect(p1.code).toMatch(/^P-\d{6}$/)
    expect(p1.stock).toBe(20)
    expect(p1.price_vat).toBe(1000) // 11000 con IVA 10% -> IVA 1000
    const dup = await call('boss', 'POST', '/products', { name: 'Otro', price: 5000, barcode: '7890001' })
    expect(dup.status).toBe(409)
    expect(dup.body.error).toMatch(/código de barras/)
    expect((await call('boss', 'POST', '/products', { name: 'Otro', price: 5000, code: p1.code })).status).toBe(409)
    expect((await call('boss', 'POST', '/products', { name: 'X', price: 5000 })).status).toBe(400) // nombre muy corto
    expect((await call('boss', 'POST', '/products', { name: 'Sin precio', price: 0 })).status).toBe(400)
    expect((await call('boss', 'POST', '/products', { name: 'Mayorista alto', price: 5000, wholesale_price: 9000 })).status).toBe(400)
  })

  it('la calculadora y el control de venta bajo costo funcionan', async () => {
    const calc = ok(await call('boss', 'POST', '/products/price-calc', { cost: 6000, markup_pct: 50, tax_rate: 10 }))
    expect(calc.price).toBe(9900)
    expect(calc.vat).toBe(900)
    const below = await call('boss', 'POST', '/products', { name: 'Regalado', price: 3000, cost: 6000 })
    expect(below.status).toBe(409)
    expect(ok(await call('boss', 'POST', '/products', { name: 'Regalado', price: 3000, cost: 6000, confirmBelowCost: true })).id).toBeGreaterThan(0)
    expect((await call('buyer', 'POST', '/products', { name: 'Compras', price: 100 })).status).toBe(403)
  })

  it('oferta con vigencia: cambia el precio vigente por canal y valida fechas', async () => {
    expect((await call('boss', 'PUT', `/products/${p1.id}`, { offer_enabled: true, offer_price: 12000 })).status).toBe(400) // mayor al precio
    expect((await call('boss', 'PUT', `/products/${p1.id}`, { offer_enabled: true, offer_pct: 10, offer_start: plus(2), offer_end: plus(1) })).status).toBe(400)
    let r = ok(await call('boss', 'PUT', `/products/${p1.id}`, { offer_enabled: true, offer_pct: 10, offer_start: today(), offer_end: plus(3), offer_channel: 'online', offer_label: 'Vuelta a clases' }))
    expect(r.sell_price).toBe(11000) // solo online
    expect(r.online_price).toBe(9900)
    r = ok(await call('boss', 'PUT', `/products/${p1.id}`, { offer_channel: 'both' }))
    expect(r.sell_price).toBe(9900)
    const shop = ok(await call('', 'GET', `/shop/products/${p1.id}`))
    expect(shop.price).toBe(9900)
    expect(shop.list_price).toBe(11000)
    expect(shop.on_offer).toBe(true)
    expect(shop.availability).toBe('available')
    expect(shop.stock).toBeUndefined() // la tienda nunca expone números de stock
    expect(shop.available).toBeUndefined()
    expect(shop.cost).toBeUndefined()
    // vencida: vuelve al precio de lista
    r = ok(await call('boss', 'PUT', `/products/${p1.id}`, { offer_start: plus(-5), offer_end: plus(-1) }))
    expect(r.on_offer).toBe(false)
    ok(await call('boss', 'PUT', `/products/${p1.id}`, { offer_start: today(), offer_end: plus(3) }))
  })

  it('el POS cobra el precio de oferta y guarda precio de lista y promoción', async () => {
    ok(await call('cash', 'POST', '/cash/open', { openingFloat: 0 }))
    const s = ok(await call('cash', 'POST', '/sales', { items: [{ productId: p1.id, qty: 2 }], payments: [{ method: 'cash', amount: 19800 }] }))
    expect(s.total).toBe(19800)
    const { rows } = await db.query('SELECT list_price, promo_label, unit_price FROM sale_items WHERE sale_id = $1', [s.id])
    expect(Number(rows[0].list_price)).toBe(11000)
    expect(rows[0].promo_label).toBe('Vuelta a clases')
    // descuento que deja el precio bajo el costo: requiere autorización
    const bad = await call('cash', 'POST', '/sales', { items: [{ productId: p1.id, qty: 1, discount: 5000 }], payments: [{ method: 'cash', amount: 4900 }] })
    expect(bad.status).toBe(403)
    expect((await call('cash', 'POST', '/sales/authorize', { username: 'cash', password: 'secret123' })).status).toBe(403) // el cajero no autoriza
    const auth = ok(await call('cash', 'POST', '/sales/authorize', { username: 'boss', password: 'secret123' }))
    const sale = { items: [{ productId: p1.id, qty: 1, discount: 5000 }], payments: [{ method: 'cash', amount: 4900 }] }
    expect((await call('cash', 'POST', '/sales', { ...sale, approvalToken: auth.token })).status).toBe(400) // falta el motivo
    const authSale = ok(await call('cash', 'POST', '/sales', { ...sale, approvalToken: auth.token, discountReason: 'Producto con envase dañado' }))
    expect(Number((await db.query('SELECT discount_approved_by FROM sales WHERE id = $1', [authSale.id])).rows[0].discount_approved_by)).toBeGreaterThan(0)
    expect((await db.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'sale.authorize'")).rows[0].n).toBe(1)
  })

  it('el cajero no ve costos; el listado se pagina y filtra', async () => {
    const list = ok(await call('cash', 'GET', '/products?q=cuaderno'))
    expect(list[0].cost).toBeUndefined()
    expect(list[0].margin).toBeUndefined()
    const full = ok(await call('boss', 'GET', '/products?page=1&pageSize=15&sort=price&dir=desc'))
    expect(full.pageSize).toBe(15)
    expect(full.total).toBeGreaterThanOrEqual(2)
    expect(full.items[0].margin).not.toBeUndefined()
    expect(ok(await call('boss', 'GET', '/products?page=1&pageSize=15&offer=1')).items.map((x: any) => x.id)).toContain(p1.id)
    expect(ok(await call('boss', 'GET', '/products?page=1&pageSize=15&stock=out')).total).toBeGreaterThanOrEqual(1)
  })

  it('las imágenes se optimizan, se ordenan y la principal alimenta la tienda', async () => {
    const png = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#cc3366' } }).png().toBuffer()
    const up = ok(await call('boss', 'POST', `/products/${p1.id}/images`, { data: 'data:image/png;base64,' + png.toString('base64') }))
    expect(up.width).toBe(1200)
    expect(up.size).toBeLessThan(png.length)
    const bad = await call('boss', 'POST', `/products/${p1.id}/images`, { data: 'data:image/png;base64,' + Buffer.from('no soy imagen').toString('base64') })
    expect(bad.status).toBe(400)
    const second = ok(await call('boss', 'POST', `/products/${p1.id}/images`, { data: 'data:image/png;base64,' + png.toString('base64') }))
    ok(await call('boss', 'PUT', `/products/${p1.id}/images/order`, { ids: [second.id, up.id] }))
    const detail = ok(await call('boss', 'GET', `/products/${p1.id}`))
    expect(detail.images.map((i: any) => i.id)).toEqual([second.id, up.id])
    expect(detail.image_url).toContain(`/img/${second.id}`)
    const img = await call('', 'GET', `/shop/img/${second.id}?s=thumb`)
    expect(img.status).toBe(200)
    expect(String(img.headers['content-type'])).toBe('image/webp')
    expect((await sharp(img.raw).metadata()).width).toBe(240)
    ok(await call('boss', 'DELETE', `/products/${p1.id}/images/${second.id}`))
    expect(ok(await call('boss', 'GET', `/products/${p1.id}`)).image_url).toContain(`/img/${up.id}`)
  })

  it('lookup por lector, historial con antes/después y baja segura', async () => {
    expect(ok(await call('boss', 'GET', '/products/lookup?code=7890001')).id).toBe(p1.id)
    expect((await call('boss', 'GET', '/products/lookup?code=nada')).status).toBe(404)
    ok(await call('boss', 'PUT', `/products/${p1.id}`, { price: 12000, location: 'Estante 3' }))
    const h = ok(await call('boss', 'GET', `/products/${p1.id}/history`))
    expect(h.prices.some((x: any) => x.field === 'price' && Number(x.new_value) === 12000)).toBe(true)
    const upd = h.changes.find((c: any) => c.action === 'product.update')
    expect(upd.detail.changes['Precio']).toEqual([11000, 12000])
    expect(h.movements.some((m: any) => m.stock_after != null && m.type === 'opening')).toBe(true)
    // con movimientos no se borra: se desactiva
    const del = ok(await call('boss', 'DELETE', `/products/${p1.id}`))
    expect(del.deactivated).toBe(true)
    // uno sin uso sí se elimina
    const tmp = ok(await call('boss', 'POST', '/products', { name: 'Temporal', price: 1000 }))
    expect(ok(await call('boss', 'DELETE', `/products/${tmp.id}`)).deleted).toBe(true)
  })
})
