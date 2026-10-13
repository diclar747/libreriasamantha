import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { buildApp } from '../src/app.js'
import { hashPassword } from '../src/auth.js'
import { createPool, migrate, type Db } from '../src/db/client.js'
import { eanCheck, internalBarcode, normalizeScan } from '../src/scanning.js'

const BASE = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'
const TEST_DB = 'libreria_samantha_test9'
let db: Db
let app: ReturnType<typeof buildApp>
const tokens: Record<string, string> = {}

async function call(who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, prefix = '/api') {
  const res = await app.inject({ method, url: prefix + url, payload: payload as any, headers: tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {} })
  const ct = String(res.headers['content-type'] ?? '')
  return { status: res.statusCode, body: ct.includes('json') ? res.json() : null, raw: res.rawPayload, headers: res.headers }
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

let p1: any, p2: any

describe('Escaneo: códigos, lector en el teléfono, conteo físico y etiquetas', () => {
  it('valida el dígito verificador de EAN/ISBN y normaliza lo que entrega el lector', async () => {
    expect(eanCheck('7501031311309')).toBe(true)
    expect(eanCheck('7501031311308')).toBe(false)
    expect(normalizeScan(' 978-9974-0-1234-9\r\n')).toBe('9789974012349')
    expect(internalBarcode(15)).toMatch(/^200000000015\d$/)
    expect(eanCheck(internalBarcode(15))).toBe(true)
    const bad = await call('boss', 'POST', '/products', { name: 'Producto con EAN malo', price: 5000, barcode: '7501031311308' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/EAN-13/)
    p1 = ok(await call('boss', 'POST', '/products', { name: 'Lapicera azul', price: 3000, cost: 1500, barcode: '7501031311309', initial_stock: 10 }))
    p2 = ok(await call('boss', 'POST', '/products', { name: 'Libro de cuentos', price: 45000, cost: 25000, isbn: '978-9974-0-1234-9', initial_stock: 5 }))
    expect((await call('boss', 'POST', '/products', { name: 'Libro con ISBN malo', price: 45000, isbn: '9789974012340' })).status).toBe(400)
  })

  it('el lookup encuentra por barras, ISBN (con o sin guiones), código interno y avisa de duplicados', async () => {
    expect(ok(await call('cash', 'GET', '/products/lookup?code=7501031311309')).id).toBe(p1.id)
    expect(ok(await call('cash', 'GET', `/products/lookup?code=${p2.isbn.replace(/-/g, '')}`)).id).toBe(p2.id)
    expect(ok(await call('cash', 'GET', `/products/lookup?code=${p1.code}`)).id).toBe(p1.id)
    expect((await call('cash', 'GET', '/products/lookup?code=0000')).status).toBe(404)
    // EAN-13 con cero inicial equivale al UPC-A de 12 dígitos
    const upc = ok(await call('boss', 'POST', '/products', { name: 'Cuaderno UPC', price: 8000, barcode: '036000291452' }))
    expect(ok(await call('cash', 'GET', '/products/lookup?code=0036000291452')).id).toBe(upc.id)
    // generar un código interno propio para un producto sin código
    const sin = ok(await call('boss', 'POST', '/products', { name: 'Producto artesanal', price: 12000 }))
    const gen = ok(await call('boss', 'POST', `/products/${sin.id}/generate-barcode`))
    expect(eanCheck(gen.barcode)).toBe(true)
    expect((await call('boss', 'POST', `/products/${sin.id}/generate-barcode`)).status).toBe(409)
    expect(ok(await call('cash', 'GET', `/products/lookup?code=${gen.barcode}`)).id).toBe(sin.id)
    const png = await call('cash', 'GET', `/products/${p1.id}/barcode.png`)
    expect(png.status).toBe(200)
    expect(String(png.headers['content-type'])).toBe('image/png')
    const labels = await call('cash', 'GET', `/products/labels?ids=${p1.id},${p2.id}&copies=2`)
    expect(labels.status).toBe(200)
    expect(String(labels.headers['content-type'])).toBe('application/pdf')
    expect(labels.raw.subarray(0, 4).toString()).toBe('%PDF')
  })

  it('el teléfono se vincula con un enlace temporal y envía lecturas sin duplicarlas', async () => {
    const link = ok(await call('cash', 'POST', '/scan/links', { purpose: 'sale' }))
    expect(link.path).toBe(`/escanear/${link.token}`)
    expect(ok(await call('cash', 'GET', `/scan/links/${link.id}`)).status).toBe('pending')
    const join = await call('', 'GET', `/scan/${link.token}`, undefined, '/api/shop')
    expect(join.status).toBe(200)
    expect(ok(await call('cash', 'GET', `/scan/links/${link.id}`)).status).toBe('linked')
    const send = (code: string, eventId?: string) => call('', 'POST', `/scan/${link.token}/events`, { code, eventId }, '/api/shop')
    expect((await send('7501031311309', 'e1')).status).toBe(201)
    expect((await send('7501031311309', 'e1')).body.duplicate).toBe(true) // reintento por mala conexión
    expect((await send('7501031311309', 'e2')).status).toBe(201) // segunda unidad del mismo producto
    expect((await send('9999999')).body.product).toBeNull() // código desconocido: el POS decide qué hacer
    const first = ok(await call('cash', 'GET', `/scan/links/${link.id}/events`))
    expect(first.map((e: any) => e.code)).toEqual(['7501031311309', '7501031311309', '9999999'])
    expect(ok(await call('cash', 'GET', `/scan/links/${link.id}/events`))).toEqual([]) // se entregan una sola vez
    expect((await call('stock', 'GET', `/scan/links/${link.id}/events`)).status).toBe(404) // otro usuario no lo lee
    // un enlace nuevo cierra el anterior; uno vencido no acepta lecturas
    const link2 = ok(await call('cash', 'POST', '/scan/links', { purpose: 'sale' }))
    expect((await send('1')).status).toBe(410)
    await db.query(`UPDATE scan_links SET expires_at = now() - interval '1 minute' WHERE id = $1`, [link2.id])
    expect((await call('', 'POST', `/scan/${link2.token}/events`, { code: '1' }, '/api/shop')).status).toBe(410)
    expect((await call('', 'GET', '/scan/token-inexistente', undefined, '/api/shop')).status).toBe(410)
  })

  it('conteo físico con lector: suma lecturas, calcula diferencias y ajusta sin pisar ventas hechas durante el conteo', async () => {
    const c = ok(await call('stock', 'POST', '/inventory-counts', { note: 'Estante 1' }))
    expect(c.number).toMatch(/^CF-/)
    for (let i = 0; i < 8; i++) ok(await call('stock', 'POST', `/inventory-counts/${c.id}/scan`, { code: '7501031311309' })) // 8 contadas de 10
    ok(await call('stock', 'POST', `/inventory-counts/${c.id}/scan`, { code: p2.isbn, qty: 5, set: true }))
    expect((await call('stock', 'POST', `/inventory-counts/${c.id}/scan`, { code: 'nada' })).status).toBe(404)
    // mientras se contaba, se vendió una lapicera
    ok(await call('cash', 'POST', '/cash/open', { openingFloat: 0 }))
    ok(await call('cash', 'POST', '/sales', { items: [{ productId: p1.id, qty: 1 }], payments: [{ method: 'cash', amount: 3000 }] }))
    const det = ok(await call('stock', 'GET', `/inventory-counts/${c.id}`))
    expect(det.summary).toMatchObject({ products: 2, differences: 1 })
    expect(det.items.find((i: any) => i.product_id === p1.id)).toMatchObject({ counted: 8, expected: 10, diff: -2 })
    const applied = ok(await call('stock', 'POST', `/inventory-counts/${c.id}/apply`))
    expect(applied.applied).toBe(1)
    expect(applied.loss).toBe(3000) // 2 unidades x costo 1500
    // stock final = 10 - 1 vendida - 2 de diferencia = 7 (la venta no se pisa)
    expect(Number((await db.query('SELECT stock FROM products WHERE id = $1', [p1.id])).rows[0].stock)).toBe(7)
    expect((await db.query(`SELECT type, stock_before, stock_after FROM stock_movements WHERE product_id = $1 ORDER BY id DESC LIMIT 1`, [p1.id])).rows[0]).toMatchObject({ type: 'count', stock_before: 9, stock_after: 7 })
    expect((await call('stock', 'POST', `/inventory-counts/${c.id}/apply`)).status).toBe(409)
    const tb = ok(await call('boss', 'GET', '/accounting/trial-balance'))
    expect(tb.totalDebit).toBe(tb.totalCredit)
    expect((await call('cash', 'POST', '/inventory-counts', {})).status).toBe(403)
  })
})
