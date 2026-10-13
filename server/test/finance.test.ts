import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { buildApp } from '../src/app.js'
import { hashPassword } from '../src/auth.js'
import { createPool, migrate, type Db } from '../src/db/client.js'
import { accountBalances } from '../src/finance.js'

const BASE = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'
const TEST_DB = 'libreria_samantha_test5'
let db: Db
let app: ReturnType<typeof buildApp>
const tokens: Record<string, string> = {}

async function call(who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url: '/api' + url, payload: payload as any, headers: tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {} })
  const ct = String(res.headers['content-type'] ?? '')
  return { status: res.statusCode, body: ct.includes('json') ? res.json() : null, raw: res.rawPayload, headers: res.headers }
}
const ensureOpen = async (who: string, float = 0) => { const c = (await call(who, 'GET', '/cash/current')).body; if (!c.session) ok(await call(who, 'POST', '/cash/open', { openingFloat: float })) }
const ok = (r: { status: number; body: any }) => { if (r.status >= 300) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`); return r.body }
const today = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)

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
})
afterAll(async () => { await db.end() })

let prod: { id: number }, prod2: { id: number }, cust: { id: number }, sale1: any, creditSale: any

describe('Finanzas: cobros por medio, cuotas, devoluciones, gastos y caja', () => {
  it('la apertura valida el detalle de billetes y registra turno y fondo', async () => {
    prod = ok(await call('boss', 'POST', '/products', { code: 'CUA', name: 'Cuaderno', price: 11000, cost: 6000, min_stock: 2 }))
    prod2 = ok(await call('boss', 'POST', '/products', { code: 'LIB', name: 'Libro', price: 55000, cost: 30000, tax_rate: 5 }))
    await call('boss', 'POST', '/stock/adjust', { productId: prod.id, delta: 30, reason: 'Inventario inicial', initial: true })
    await call('boss', 'POST', '/stock/adjust', { productId: prod2.id, delta: 10, reason: 'Inventario inicial', initial: true })
    const bad = await call('cash', 'POST', '/cash/open', { openingFloat: 100000, shift: 'Mañana', denominations: { '50000': 1, '20000': 1 } })
    expect(bad.status).toBe(400)
    const open = await call('cash', 'POST', '/cash/open', { openingFloat: 100000, shift: 'Mañana', note: 'Apertura normal', denominations: { '50000': 1, '20000': 2, '10000': 1 } })
    expect(open.status).toBe(201)
    expect(open.body.shift).toBe('Mañana')
  })

  it('pago combinado efectivo + tarjeta + transferencia + QR guarda referencias y no suma efectivo de más', async () => {
    const bank = (await call('boss', 'GET', '/money-accounts')).body.find((a: any) => a.kind === 'bank')
    sale1 = ok(await call('cash', 'POST', '/sales', {
      items: [{ productId: prod.id, qty: 10 }, { productId: prod2.id, qty: 2 }], // 110.000 + 110.000 = 220.000
      payments: [
        { method: 'cash', amount: 80000 },
        { method: 'card', amount: 60000, details: { type: 'debit', processor: 'Bancard', reference: 'AUT-9981' } },
        { method: 'transfer', amount: 50000, details: { accountId: bank.id, bank: 'Itaú' }, reference: 'TRF-77' },
        { method: 'qr', amount: 30000, details: { provider: 'Zimple', reference: 'QR-5' } },
      ],
    }))
    expect(sale1.total).toBe(220000)
    const detail = (await call('cash', 'GET', `/sales/${sale1.id}`)).body
    const card = detail.payments.find((p: any) => p.method === 'card')
    expect(card).toMatchObject({ settlement_status: 'pending', reference: 'AUT-9981' })
    expect(card.details.type).toBe('debit')
    expect(Number(card.fee)).toBe(Math.round((60000 * 1.8) / 100)) // comisión estimada de débito
    const cur = (await call('cash', 'GET', '/cash/current')).body
    expect(cur.expectedCash).toBe(100000 + 80000) // solo el efectivo físico
    const m = Object.fromEntries(cur.byMethod.map((x: any) => [x.method, x.amount]))
    expect(m).toMatchObject({ cash: 80000, card: 60000, transfer: 50000, qr: 30000 })
  })

  it('el cheque exige banco, número y titular; queda pendiente de depósito', async () => {
    const bad = await call('cash', 'POST', '/sales', { items: [{ productId: prod.id, qty: 1 }], payments: [{ method: 'check', amount: 11000 }] })
    expect(bad.status).toBe(400)
    const good = await call('cash', 'POST', '/sales', { items: [{ productId: prod.id, qty: 1 }], payments: [{ method: 'check', amount: 11000, details: { number: '0001234', bank: 'Itaú', holder: 'Ana Gómez', date: today() } }] })
    expect(good.status).toBe(201)
    const pend = (await call('acc', 'GET', '/payments/pending-settlement?method=check')).body
    expect(pend).toHaveLength(1)
  })

  it('liquidar tarjeta y QR separa comisión real y neto acreditado; el cheque se deposita sin comisión', async () => {
    const bank = (await call('boss', 'GET', '/money-accounts')).body.find((a: any) => a.kind === 'bank' && !a.is_demo) ?? (await call('boss', 'GET', '/money-accounts')).body.find((a: any) => a.kind === 'bank')
    const pend = (await call('acc', 'GET', '/payments/pending-settlement')).body.filter((p: any) => ['card', 'qr'].includes(p.method))
    expect(pend.map((p: any) => p.method).sort()).toEqual(['card', 'qr'])
    const r = ok(await call('acc', 'POST', '/payments/settle', { ids: pend.map((p: any) => p.id), accountId: bank.id, fee: 1500 }))
    expect(r).toMatchObject({ gross: 90000, fee: 1500, net: 88500 })
    expect((await call('acc', 'POST', '/payments/settle', { ids: pend.map((p: any) => p.id), accountId: bank.id })).status).toBe(409) // no se liquida dos veces
    const chk = (await call('acc', 'GET', '/payments/pending-settlement?method=check')).body
    expect(ok(await call('acc', 'POST', '/payments/settle', { ids: [chk[0].id], accountId: bank.id }))).toMatchObject({ gross: 11000, fee: 0 })
    const tb = (await call('boss', 'GET', '/accounting/trial-balance')).body
    const bal = (code: string) => tb.rows.find((x: any) => x.code === code)?.balance ?? 0
    expect(bal('1.1.03')).toBe(0) // tarjetas a cobrar liquidadas
    expect(bal('1.1.08')).toBe(0)
    expect(bal('1.1.07')).toBe(0)
    expect(tb.totalDebit).toBe(tb.totalCredit)
  })

  it('venta a crédito en 3 cuotas: el cobro aplica a la cuota más antigua y la deuda se clasifica por antigüedad', async () => {
    cust = ok(await call('cash', 'POST', '/customers', { name: 'Colegio San José', ruc: '80012345-6' }))
    await call('boss', 'PUT', `/customers/${cust.id}`, { credit_limit: 1000000 })
    creditSale = ok(await call('cash', 'POST', '/sales', {
      customerId: cust.id, items: [{ productId: prod2.id, qty: 3 }], onCredit: true, plan: { count: 3, firstDueDays: 10, intervalDays: 30 },
      payments: [{ method: 'cash', amount: 15000 }],
    })) // 165.000 - 15.000 = 150.000 a crédito
    expect(creditSale.credit_amount).toBe(150000)
    const inst = (await db.query('SELECT * FROM installments WHERE sale_id = $1 ORDER BY number', [creditSale.id])).rows
    expect(inst.map((i) => Number(i.amount))).toEqual([50000, 50000, 50000])
    // Se envejecen las cuotas: 5, 45 y 100 días de atraso
    for (const [n, days] of [[1, 5], [2, 45], [3, 100]]) await db.query(`UPDATE installments SET due_date = current_date - $2::int WHERE sale_id = $1 AND number = $3`, [creditSale.id, days, n])
    const pay = ok(await call('cash', 'POST', `/customers/${cust.id}/payments`, { amount: 70000, method: 'cash' }))
    expect(pay.balance).toBe(80000)
    const after = (await db.query('SELECT number, paid FROM installments WHERE sale_id = $1 ORDER BY due_date', [creditSale.id])).rows
    expect(after.map((i) => Number(i.paid))).toEqual([50000, 20000, 0]) // primero la más antigua (la de 100 días), luego la de 45
    const aging = (await call('boss', 'GET', '/reports/receivables')).body
    const row = aging.rows[0]
    expect(row).toMatchObject({ customer: 'Colegio San José', b0: 0, b1: 50000, b2: 30000, b3: 0, b4: 0 })
    expect(Number(aging.totals.total)).toBe(80000)
  })

  it('devolución parcial: stock vuelve solo si se recibe, reembolsa al medio elegido y emite nota de crédito', async () => {
    const stockBefore = (await db.query('SELECT stock FROM products WHERE id = $1', [prod.id])).rows[0].stock
    const items = (await call('boss', 'GET', `/sales/${sale1.id}`)).body.items
    const line = items.find((i: any) => i.product_id === prod.id)
    expect((await call('cash', 'POST', `/sales/${sale1.id}/returns`, { items: [{ saleItemId: line.id, qty: 2 }], reason: 'Falla de impresión' })).status).toBe(403) // el cajero no devuelve
    await ensureOpen('boss')
    const r = ok(await call('boss', 'POST', `/sales/${sale1.id}/returns`, { items: [{ saleItemId: line.id, qty: 2 }], reason: 'Falla de impresión', restock: true, refundMethod: 'cash' }))
    expect(r.total).toBe(22000)
    expect((await db.query('SELECT stock FROM products WHERE id = $1', [prod.id])).rows[0].stock).toBe(stockBefore + 2)
    const again = await call('boss', 'POST', `/sales/${sale1.id}/returns`, { items: [{ saleItemId: line.id, qty: 9 }], reason: 'Exceso' })
    expect(again.status).toBe(409) // solo quedan 8
    const s = (await call('boss', 'GET', `/sales/${sale1.id}`)).body
    expect(s.return_status).toBe('partial')
    expect(s.returns).toHaveLength(1)
    const nc = (await call('acc', 'GET', '/invoices')).body.filter((i: any) => i.kind === 'credit_note' && Number(i.total) === 22000)
    expect(nc).toHaveLength(1)
    expect((await call('boss', 'POST', `/sales/${sale1.id}/void`, { reason: 'Intento' })).status).toBe(409) // con devoluciones ya no se anula
    // devolución sin reponer stock (mercadería dañada): el costo no vuelve al inventario
    const s2 = (await call('boss', 'GET', `/sales/${sale1.id}`)).body
    const before = (await db.query('SELECT stock FROM products WHERE id = $1', [prod.id])).rows[0].stock
    ok(await call('boss', 'POST', `/sales/${sale1.id}/returns`, { items: [{ saleItemId: s2.items.find((i: any) => i.product_id === prod.id).id, qty: 1 }], reason: 'Dañado', restock: false, refundMethod: 'cash' }))
    expect((await db.query('SELECT stock FROM products WHERE id = $1', [prod.id])).rows[0].stock).toBe(before)
    await call('boss', 'POST', '/cash/close', { counted: (await call('boss', 'GET', '/cash/current')).body.expectedCash })
  })

  it('gastos: registrar no es pagar; pagos parciales por distintos medios y anulación vinculada', async () => {
    const cats = (await call('acc', 'GET', '/expense-categories')).body
    const servicios = cats.find((c: any) => c.name === 'Servicios' && !c.parent_id)
    const luz = cats.find((c: any) => c.name === 'Luz')
    expect(luz.parent_id).toBe(servicios.id)
    const e = ok(await call('acc', 'POST', '/expenses', { categoryId: luz.id, concept: 'Factura de luz octubre', beneficiary: 'ANDE', amount: 300000, dueDate: today(), documentNumber: '001-001-123' }))
    expect(e.status).toBe('pending')
    expect((await call('acc', 'GET', '/expenses?status=open')).body[0].remaining).toBe(300000)
    const tb0 = (await call('boss', 'GET', '/accounting/trial-balance')).body
    expect(tb0.rows.find((x: any) => x.code === '2.1.04').balance).toBe(300000) // obligación, no salida de dinero
    expect((await call('acc', 'POST', `/expenses/${e.id}/pay`, { amount: 100000, method: 'cash' })).status).toBe(409) // sin caja abierta
    await ensureOpen('cash')
    const bank = (await call('boss', 'GET', '/money-accounts')).body.find((a: any) => a.kind === 'bank' && a.id)
    const p1 = ok(await call('acc', 'POST', `/expenses/${e.id}/pay`, { amount: 120000, method: 'transfer', accountId: bank.id, reference: 'TRF-1' }))
    expect(p1.status).toBe('partial')
    expect((await call('acc', 'POST', `/expenses/${e.id}/pay`, { amount: 999999, method: 'transfer' })).status).toBe(400)
    const p2 = ok(await call('acc', 'POST', `/expenses/${e.id}/pay`, { method: 'transfer', accountId: bank.id }))
    expect(p2).toMatchObject({ status: 'paid', paid: 300000 })
    const cat = (await call('boss', 'GET', '/reports/expenses?groupBy=category&range=month')).body
    expect(cat.rows.find((r: any) => r.grp === 'Servicios')).toMatchObject({ amount: 300000, paid: 300000, balance: 0 })
    const v = ok(await call('acc', 'POST', `/expenses/${e.id}/void`, { reason: 'Cargado por error' }))
    expect(v.status).toBe('void')
    const tb = (await call('boss', 'GET', '/accounting/trial-balance')).body
    expect(tb.rows.find((x: any) => x.code === '2.1.04')?.balance ?? 0).toBe(0)
    expect(tb.totalDebit).toBe(tb.totalCredit)
  })

  it('recurrentes, transferencias, aportes y retiros no son ventas ni gastos comerciales', async () => {
    const cats = (await call('acc', 'GET', '/expense-categories')).body
    const alq = cats.find((c: any) => c.name === 'Alquiler')
    ok(await call('acc', 'POST', '/recurring-expenses', { concept: 'Alquiler del local', categoryId: alq.id, amount: 2500000, nextDate: today(), frequency: 'monthly', beneficiary: 'Inmobiliaria' }))
    expect((await call('acc', 'POST', '/recurring-expenses/run', {})).body.created).toBe(1)
    expect((await call('acc', 'POST', '/recurring-expenses/run', {})).body.created).toBe(0) // no se duplica
    const accts = (await call('boss', 'GET', '/money-accounts')).body
    const cash = accts.find((a: any) => a.kind === 'cash'), bank = accts.find((a: any) => a.kind === 'bank')
    const before = (await call('boss', 'GET', '/reports/income-statement')).body.meta.result
    await ensureOpen('boss')
    ok(await call('boss', 'POST', '/money-movements', { kind: 'owner_contribution', amount: 1000000, accountId: bank.id, concept: 'Aporte para capital de trabajo' }))
    ok(await call('boss', 'POST', '/money-movements', { kind: 'transfer', amount: 200000, accountId: bank.id, toAccountId: cash.id, concept: 'Reposición de caja' }))
    expect((await call('boss', 'POST', '/money-movements', { kind: 'transfer', amount: 999999999, accountId: bank.id, toAccountId: cash.id, concept: 'Demasiado' })).status).toBe(409)
    ok(await call('boss', 'POST', '/money-movements', { kind: 'owner_withdrawal', amount: 100000, accountId: bank.id, concept: 'Retiro personal' }))
    expect((await call('cash', 'POST', '/money-movements', { kind: 'adjustment_in', amount: 1, accountId: bank.id, concept: 'Intento' })).status).toBe(403)
    const after = (await call('boss', 'GET', '/reports/income-statement')).body.meta.result
    expect(after).toBe(before) // ni aportes, ni retiros, ni transferencias cambian el resultado
  })

  it('el cierre con diferencia queda pendiente de aprobación, descuenta depósito y fondo, y solo se reabre con autorización', async () => {
    await call('boss', 'POST', '/cash/close', { counted: 0 }).catch(() => null)
    const open = ok(await call('cash', 'POST', '/cash/open', { openingFloat: 50000 }).then((r) => (r.status === 409 ? call('cash', 'GET', '/cash/current').then((c) => ({ status: 200, body: c.body.session })) : r)))
    const sid = open.id
    ok(await call('cash', 'POST', '/sales', { items: [{ productId: prod.id, qty: 2 }], payments: [{ method: 'cash', amount: 30000 }, { method: 'card', amount: 0 + 1000, details: { type: 'credit' } }] }))
    expect((await call('cash', 'POST', '/cash/movements', { type: 'out', amount: 500000, reason: 'Retiro grande' })).status).toBe(403) // supera el límite del cajero
    const cur = (await call('cash', 'GET', '/cash/current')).body
    const partial = ok(await call('cash', 'POST', '/cash/count', { counted: cur.expectedCash - 2000, note: 'Arqueo de media jornada' }))
    expect(partial.difference).toBe(-2000)
    const close = ok(await call('cash', 'POST', '/cash/close', { counted: cur.expectedCash - 5000, note: 'Faltan 5.000', deposit: { amount: 40000 }, reserve: 20000, denominations: undefined }))
    expect(close.difference).toBe(-5000)
    const rep = (await call('cash', 'GET', `/cash/sessions/${sid}`)).body
    expect(rep.session).toMatchObject({ status: 'closed', diff_status: 'pending_approval' })
    expect(rep.deposit).toBe(40000)
    expect(rep.reserve).toBe(20000)
    expect(rep.pendingDeposit).toBe(cur.expectedCash - 5000 - 40000 - 20000)
    expect((await call('boss', 'POST', `/cash/sessions/${sid}/approve`, { note: 'Autorizada por el propietario' })).body.diff_status).toBe('approved')
    expect((await call('cash', 'POST', `/cash/sessions/${sid}/reopen`, { reason: 'Quiero corregir' })).status).toBe(403)
    expect(ok(await call('boss', 'POST', `/cash/sessions/${sid}/reopen`, { reason: 'Error de conteo' })).status).toBe('open')
    expect((await call('boss', 'GET', '/audit-log-probe')).status).toBeGreaterThanOrEqual(404)
    const log = (await db.query(`SELECT action FROM audit_log WHERE entity = 'cash_session' AND entity_id = $1`, [sid])).rows.map((r) => r.action)
    expect(log).toEqual(expect.arrayContaining(['cash.close', 'cash.approve_diff', 'cash.reopen']))
    ok(await call('cash', 'POST', '/cash/close', { counted: cur.expectedCash })) // se vuelve a cerrar sin diferencia
  })

  it('el registro de movimientos coincide con el libro diario en caja, bancos y cobros pendientes', async () => {
    const balances = await accountBalances(db)
    const tb = (await call('boss', 'GET', '/accounting/trial-balance')).body
    const ledger = (code: string) => tb.rows.find((x: any) => x.code === code)?.balance ?? 0
    expect(balances.filter((a) => a.kind === 'cash').reduce((s, a) => s + a.balance, 0)).toBe(ledger('1.1.01'))
    expect(balances.filter((a) => a.kind === 'bank').reduce((s, a) => s + a.balance, 0)).toBe(ledger('1.1.02'))
    const pending = Number((await db.query(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE settlement_status = 'pending' AND method IN ('card','online')`)).rows[0].s)
    expect(pending).toBe(ledger('1.1.03'))
    expect(tb.totalDebit).toBe(tb.totalCredit)
    expect((await call('boss', 'GET', '/accounting/balance-sheet')).body.balanced).toBe(true)
  })

  it('el dashboard, los reportes y las exportaciones muestran las mismas cifras', async () => {
    const range = 'range=month'
    const ov = (await call('boss', 'GET', `/reports/overview?${range}`)).body
    const kpi = (k: string) => ov.kpis.find((x: any) => x.key === k)
    const sales = (await call('boss', 'GET', `/reports/sales?${range}&pageSize=all`)).body
    expect(kpi('net').value).toBe(sales.totals.net)
    expect(kpi('gross').value).toBe(sales.totals.gross)
    expect(kpi('returns').value).toBe(sales.totals.returns)
    expect(kpi('sales').value).toBe(sales.rows.length)
    const detail = (await call('boss', 'GET', `/reports/sales?${range}&view=detail&pageSize=all`)).body
    expect(detail.totals.net).toBe(sales.totals.net) // el detalle por artículo suma lo mismo que el resumen por comprobante
    expect(detail.totals.net_ex_vat).toBe(sales.totals.net_ex_vat)
    for (const g of ['day', 'category', 'seller', 'channel', 'method', 'customer', 'product', 'month', 'week', 'session']) {
      const r = (await call('boss', 'GET', `/reports/sales?${range}&groupBy=${g}`)).body
      expect(r.totals.net, `agrupado por ${g}`).toBe(sales.totals.net)
    }
    expect(kpi('result').value).toBe((await call('boss', 'GET', `/reports/income-statement?${range}`)).body.meta.result)
    expect(kpi('expenses').value).toBe((await call('boss', 'GET', `/reports/expenses?${range}`)).body.totals.amount)
    const pay = (await call('boss', 'GET', `/reports/payments?${range}`)).body
    expect(kpi('collected').value).toBe(pay.totals.net)
    // el cajero no ve costos ni ganancias
    const cashierView = await call('cash', 'GET', `/reports/sales?${range}`)
    expect(cashierView.status).toBe(403)
    const acc = (await call('acc', 'GET', `/reports/sales?${range}`)).body
    expect(acc.columns.map((c: any) => c.key)).toEqual(expect.arrayContaining(['cost', 'margin']))
    // paginación: 15 por página y total general sobre todos los registros
    const p1 = (await call('boss', 'GET', `/reports/movements?${range}&pageSize=15`)).body
    expect(p1.rows.length).toBeLessThanOrEqual(15)
    expect(p1.pagination.total).toBeGreaterThan(15)
    const all = (await call('boss', 'GET', `/reports/movements?${range}&pageSize=all`)).body
    expect(all.rows).toHaveLength(p1.pagination.total)
    expect(all.totals.income).toBe(p1.totals.income)
  })

  it('exporta todos los registros filtrados a Excel, PDF y CSV, solo con permiso', async () => {
    const x = await call('boss', 'GET', '/reports/sales/export?range=month&format=xlsx')
    expect(x.status).toBe(200)
    expect(Buffer.from(x.raw).subarray(0, 2).toString()).toBe('PK')
    expect(String(x.headers['content-type'])).toContain('spreadsheetml')
    const p = await call('acc', 'GET', '/reports/sales/export?range=month&format=pdf&charts=1&groupBy=category')
    expect(p.status).toBe(200)
    expect(Buffer.from(p.raw).subarray(0, 4).toString()).toBe('%PDF')
    const c = await call('boss', 'GET', '/reports/movements/export?range=month&format=csv&cols=at,concept,income')
    expect(c.status).toBe(200)
    const lines = Buffer.from(c.raw).toString('utf8').trim().split(/\r?\n/)
    const total = (await call('boss', 'GET', '/reports/movements?range=month&pageSize=all')).body.rows.length
    expect(lines.length - 2).toBe(total) // encabezado + fila de totales + todos los registros
    expect((await call('cash', 'GET', '/reports/sales/export?range=month&format=xlsx')).status).toBe(403)
  })
})
