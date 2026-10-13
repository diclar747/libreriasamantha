import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { buildApp } from '../src/app.js'
import { hashPassword } from '../src/auth.js'
import { createPool, migrate, type Db } from '../src/db/client.js'

const BASE = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'
const TEST_DB = 'libreria_samantha_test'
let db: Db
let app: ReturnType<typeof buildApp>
const tokens: Record<string, string> = {}

async function call(who: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await app.inject({ method, url: '/api' + url, payload: payload as any, headers: tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {} })
  return { status: res.statusCode, body: res.json() }
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: BASE })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${TEST_DB}`)
  await admin.end()
  db = createPool(BASE.replace(/\/[^/]*$/, '/' + TEST_DB))
  await migrate(db)
  for (const [u, role] of [['boss', 'owner'], ['cash', 'cashier'], ['stock', 'warehouse'], ['buy', 'buyer']]) {
    await db.query('INSERT INTO users (username, name, role, password_hash) VALUES ($1,$1,$2,$3)', [u, role, hashPassword('secret123')])
  }
  app = buildApp(db)
  for (const u of ['boss', 'cash', 'stock', 'buy']) {
    tokens[u] = (await call('', 'POST', '/login', { username: u, password: 'secret123' })).body.token
  }
})
afterAll(async () => { await db.end() })

describe('Librería Samantha — flujos críticos', () => {
  let pid: number, cid: number

  it('exige autenticación y respeta permisos por rol', async () => {
    expect((await call('', 'GET', '/products')).status).toBe(401)
    expect((await call('cash', 'POST', '/products', { code: 'X', name: 'X', price: 1 })).status).toBe(403)
  })

  it('compra por caja de 12 y venta por unidad convierte cantidades y costos', async () => {
    const p = await call('boss', 'POST', '/products', { code: 'LAP', name: 'Lápiz', price: 2000, cost: 0, purchase_unit: 'caja', units_per_purchase: 12, min_stock: 5 })
    pid = p.body.id
    const sup = await call('boss', 'POST', '/suppliers', { name: 'Proveedor' })
    const po = await call('buy', 'POST', '/purchases', { supplierId: sup.body.id, items: [{ productId: pid, qty: 2, unitCost: 12000 }] })
    expect((await call('boss', 'GET', `/products?q=LAP`)).body[0].stock).toBe(0) // la orden no mueve stock
    expect((await call('stock', 'POST', `/purchases/${po.body.id}/receive`, { items: [{ itemId: 1, qty: 1 }] })).status).toBe(409) // en borrador no se recibe
    expect((await call('buy', 'POST', `/purchases/${po.body.id}/approve`)).status).toBe(403) // el comprador no aprueba
    await call('boss', 'POST', `/purchases/${po.body.id}/approve`)
    expect((await call('boss', 'POST', `/purchases/${po.body.id}/issue`)).body.status).toBe('issued')
    const detail = await call('buy', 'GET', `/purchases/${po.body.id}`)
    const itemId = detail.body.items[0].id
    expect((await call('stock', 'POST', `/purchases/${po.body.id}/receive`, { items: [{ itemId, qty: 1 }] })).body.status).toBe('partial')
    expect((await call('stock', 'POST', `/purchases/${po.body.id}/receive`, { items: [{ itemId, qty: 2 }] })).status).toBe(409) // excede lo pedido
    expect((await call('stock', 'POST', `/purchases/${po.body.id}/receive`, { items: [{ itemId, qty: 1 }] })).body.status).toBe('received')
    const prod = (await call('boss', 'GET', '/products?q=LAP')).body[0]
    expect(prod.stock).toBe(24)
    expect(prod.cost).toBe(1000) // 12000 por caja / 12
  })

  it('no vende sin caja abierta ni más que el stock disponible', async () => {
    expect((await call('cash', 'POST', '/sales', { items: [{ productId: pid, qty: 1 }], payments: [{ method: 'cash', amount: 2000 }] })).status).toBe(409)
    await call('cash', 'POST', '/cash/open', { openingFloat: 100000 })
    const over = await call('cash', 'POST', '/sales', { items: [{ productId: pid, qty: 25 }], payments: [{ method: 'cash', amount: 50000 }] })
    expect(over.status).toBe(409)
  })

  it('venta en efectivo calcula vuelto y descuenta stock; el cajero no oculta costos ni cambia precios', async () => {
    const r = await call('cash', 'POST', '/sales', { items: [{ productId: pid, qty: 3 }], payments: [{ method: 'cash', amount: 10000 }] })
    expect(r.status).toBe(201)
    expect(r.body.total).toBe(6000)
    expect(r.body.change_given).toBe(4000)
    expect((await call('cash', 'GET', '/products?q=LAP')).body[0].cost).toBeUndefined()
    expect((await call('cash', 'POST', '/sales', { items: [{ productId: pid, qty: 1, unitPrice: 1 }], payments: [{ method: 'cash', amount: 1 }] })).status).toBe(403)
    expect((await call('cash', 'POST', '/sales', { items: [{ productId: pid, qty: 1, discount: 1000 }], payments: [{ method: 'cash', amount: 1000 }] })).status).toBe(403)
  })

  it('crédito respeta el límite y los pagos reducen la deuda', async () => {
    cid = (await call('cash', 'POST', '/customers', { name: 'Colegio San José' })).body.id
    const items = [{ productId: pid, qty: 5 }] // 10000
    expect((await call('cash', 'POST', '/sales', { customerId: cid, items, payments: [], onCredit: true })).status).toBe(409) // límite 0
    expect((await call('cash', 'PUT', `/customers/${cid}`, { credit_limit: 50000 })).status).toBe(403)
    await call('boss', 'PUT', `/customers/${cid}`, { credit_limit: 50000 })
    const s = await call('cash', 'POST', '/sales', { customerId: cid, items, payments: [{ method: 'card', amount: 4000 }], onCredit: true })
    expect(s.status).toBe(201)
    expect(s.body.credit_amount).toBe(6000)
    expect((await call('cash', 'POST', `/customers/${cid}/payments`, { amount: 2000, method: 'cash' })).body.balance).toBe(4000)
  })

  it('anular una venta repone stock, devuelve el dinero y revierte el crédito; solo con permiso', async () => {
    const stockBefore = (await call('boss', 'GET', '/products?q=LAP')).body[0].stock
    const sales = (await call('boss', 'GET', '/sales')).body
    const credit = sales.find((s: any) => s.credit_amount > 0)
    expect((await call('cash', 'POST', `/sales/${credit.id}/void`, { reason: 'error' })).status).toBe(403)
    await call('boss', 'POST', '/cash/open', { openingFloat: 0 })
    expect((await call('boss', 'POST', `/sales/${credit.id}/void`, { reason: 'Error de carga' })).status).toBe(200)
    expect((await call('boss', 'POST', `/sales/${credit.id}/void`, { reason: 'Otra vez' })).status).toBe(409)
    expect((await call('boss', 'GET', '/products?q=LAP')).body[0].stock).toBe(stockBefore + 5)
    const st = await call('boss', 'GET', `/customers/${cid}/statement`)
    expect(st.body.customer.balance).toBe(-2000) // se anuló la deuda de 6000 pero ya había pagado 2000
  })

  it('el cierre de caja compara esperado vs contado', async () => {
    const cur = await call('cash', 'GET', '/cash/current')
    // apertura 100000 + venta efectivo 6000 + cobro 2000
    expect(cur.body.expectedCash).toBe(108000)
    const close = await call('cash', 'POST', '/cash/close', { counted: 107000 })
    expect(close.body).toMatchObject({ expected: 108000, counted: 107000, difference: -1000 })
  })

  it('la última unidad no se vende dos veces en ventas simultáneas', async () => {
    const p = await call('boss', 'POST', '/products', { code: 'ULT', name: 'Último', price: 1000 })
    await call('stock', 'POST', '/stock/adjust', { productId: p.body.id, delta: 1, reason: 'Inventario inicial' })
    await call('cash', 'POST', '/cash/open', { openingFloat: 0 })
    const attempt = () => call('cash', 'POST', '/sales', { items: [{ productId: p.body.id, qty: 1 }], payments: [{ method: 'cash', amount: 1000 }] })
    const results = await Promise.all([attempt(), attempt(), attempt()])
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409])
  })
})
