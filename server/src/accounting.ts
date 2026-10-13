import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePerm } from './auth.js'
import { HttpError, withTx, type Db, type Tx } from './db/client.js'

export const ACC = {
  cash: '1.1.01', bank: '1.1.02', cards: '1.1.03', receivable: '1.1.04', inventory: '1.1.05', vatCredit: '1.1.06', checks: '1.1.07', qr: '1.1.08',
  accrued: '2.1.04', ownerDraw: '3.1.04', salesReturns: '4.1.02', cashOver: '4.2.02', cashShort: '5.2.03',
  capital: '3.1.01', payable: '2.1.01', vatDebit: '2.1.02', advances: '2.1.03',
  sales: '4.1.01', otherIncome: '4.2.01', cogs: '5.1.01', adjustments: '5.1.02', expenses: '5.2.01', bankFees: '5.2.02',
} as const

export const methodAccount = (method: string) =>
  method === 'cash' ? ACC.cash : method === 'card' || method === 'online' ? ACC.cards : method === 'qr' ? ACC.qr : method === 'check' ? ACC.checks : method === 'advance' ? ACC.advances : ACC.bank

export interface PostLine { code: string; debit?: number; credit?: number }

// Registra un asiento balanceado. Se llama dentro de la misma transacción que la operación de origen.
export async function post(tx: Tx, e: { description: string; refType?: string; refId?: number; userId?: number | null; reversalOf?: number; date?: string; lines: PostLine[] }) {
  const lines = e.lines.filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0)
  const d = lines.reduce((s, l) => s + (l.debit ?? 0), 0)
  const c = lines.reduce((s, l) => s + (l.credit ?? 0), 0)
  if (d !== c) throw new HttpError(500, `Asiento desbalanceado (${d} ≠ ${c}): ${e.description}`)
  if (!lines.length) return null
  const { rows: found } = await tx.query('SELECT code FROM accounts WHERE code = ANY($1) AND active', [lines.map((l) => l.code)])
  const missing = lines.find((l) => !found.some((f) => f.code === l.code))
  if (missing) throw new HttpError(400, `Cuenta inexistente: ${missing.code}`)
  const { rows } = await tx.query(
    `INSERT INTO journal_entries (description, ref_type, ref_id, user_id, reversal_of, date) VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, current_date)) RETURNING id`,
    [e.description, e.refType ?? null, e.refId ?? null, e.userId ?? null, e.reversalOf ?? null, e.date ?? null])
  for (const l of lines) {
    await tx.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1,(SELECT id FROM accounts WHERE code = $2),$3,$4)`,
      [rows[0].id, l.code, l.debit ?? 0, l.credit ?? 0])
  }
  return rows[0].id as number
}

// Anula contablemente las operaciones de origen generando el asiento inverso (nunca se borra nada).
export async function reverse(tx: Tx, refType: string, refId: number, description: string, userId?: number) {
  const { rows: entries } = await tx.query(
    `SELECT id FROM journal_entries e WHERE ref_type = $1 AND ref_id = $2 AND reversal_of IS NULL
       AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reversal_of = e.id) ORDER BY id`, [refType, refId])
  for (const en of entries) {
    const { rows: ls } = await tx.query(`SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = $1`, [en.id])
    await post(tx, {
      description, refType, refId, userId, reversalOf: en.id,
      lines: ls.map((l) => ({ code: l.code, debit: Number(l.credit), credit: Number(l.debit) })),
    })
  }
}

// IVA incluido en los precios: se calcula por línea, prorrateando el descuento global.
export function saleTax(items: { total: number; tax_rate: number }[], discount: number) {
  const subtotal = items.reduce((s, i) => s + i.total, 0)
  const out = { tax10: 0, tax5: 0, exempt: 0, vat10: 0, vat5: 0 }
  let rest = discount
  items.forEach((it, idx) => {
    const share = idx === items.length - 1 ? rest : Math.round((discount * it.total) / (subtotal || 1))
    rest -= share
    const net = it.total - share
    if (it.tax_rate === 10) { out.tax10 += net; out.vat10 += Math.round(net / 11) }
    else if (it.tax_rate === 5) { out.tax5 += net; out.vat5 += Math.round(net / 21) }
    else out.exempt += net
  })
  return out
}

// Asiento de venta: cobros por medio, crédito, ingreso neto de IVA, IVA débito y costo de mercaderías.
export async function postSale(tx: Tx, o: {
  saleId: number; number: string; userId?: number | null
  payments: { method: string; amount: number }[]; credit: number; total: number
  items: { total: number; tax_rate: number; qty: number; cost: number; kind: string }[]; discount: number
}) {
  const t = saleTax(o.items, o.discount)
  const vat = t.vat10 + t.vat5
  const cogs = o.items.filter((i) => i.kind === 'product').reduce((s, i) => s + i.qty * i.cost, 0)
  const lines: PostLine[] = o.payments.map((p) => ({ code: methodAccount(p.method), debit: p.amount }))
  lines.push({ code: ACC.receivable, debit: o.credit })
  lines.push({ code: ACC.sales, credit: o.total - vat }, { code: ACC.vatDebit, credit: vat })
  lines.push({ code: ACC.cogs, debit: cogs }, { code: ACC.inventory, credit: cogs })
  await post(tx, { description: `Venta ${o.number}`, refType: 'sale', refId: o.saleId, userId: o.userId, lines })
  return t
}

// Devolución de venta: revierte ingreso e IVA (en proporción) y, si la mercadería vuelve, el costo.
export async function postReturn(tx: Tx, o: {
  returnId: number; number: string; userId?: number | null; total: number
  items: { amount: number; tax_rate: number; qty: number; cost: number; kind: string }[]
  restock: boolean
  settle: { applied: number; refunds: { method: string; amount: number }[] }
}) {
  let vat = 0
  for (const i of o.items) vat += i.tax_rate === 10 ? Math.round(i.amount / 11) : i.tax_rate === 5 ? Math.round(i.amount / 21) : 0
  const lines: PostLine[] = [
    { code: ACC.salesReturns, debit: o.total - vat },
    { code: ACC.vatDebit, debit: vat },
    { code: ACC.receivable, credit: o.settle.applied },
    ...o.settle.refunds.map((r) => ({ code: methodAccount(r.method), credit: r.amount })),
  ]
  if (o.restock) {
    const cost = o.items.filter((i) => i.kind === 'product').reduce((s, i) => s + i.qty * i.cost, 0)
    lines.push({ code: ACC.inventory, debit: cost }, { code: ACC.cogs, credit: cost })
  }
  await post(tx, { description: `Devolución ${o.number}`, refType: 'sale_return', refId: o.returnId, userId: o.userId, lines })
}

async function balances(db: Db, from?: string, to?: string) {
  const { rows } = await db.query(
    `SELECT a.code, a.name, a.type, COALESCE(SUM(l.debit),0) AS debit, COALESCE(SUM(l.credit),0) AS credit
     FROM accounts a
     LEFT JOIN journal_lines l ON l.account_id = a.id
     LEFT JOIN journal_entries e ON e.id = l.entry_id AND ($1::date IS NULL OR e.date >= $1) AND ($2::date IS NULL OR e.date <= $2)
     WHERE l.id IS NULL OR e.id IS NOT NULL
     GROUP BY a.id ORDER BY a.code`, [from ?? null, to ?? null])
  return rows.map((r) => {
    const debit = Number(r.debit), credit = Number(r.credit)
    const natural = r.type === 'asset' || r.type === 'expense' ? debit - credit : credit - debit
    return { code: r.code, name: r.name, type: r.type, debit, credit, balance: natural }
  })
}

export function accountingRoutes(app: FastifyInstance, db: Db) {
  app.get('/accounting/accounts', async (req) => {
    requirePerm(req, 'accounting.view')
    return (await db.query('SELECT * FROM accounts ORDER BY code')).rows
  })
  app.post('/accounting/accounts', async (req, reply) => {
    requirePerm(req, 'accounting.write')
    const b = z.object({ code: z.string().min(1), name: z.string().min(1), type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']) }).parse(req.body)
    const { rows } = await db.query('INSERT INTO accounts (code, name, type) VALUES ($1,$2,$3) RETURNING *', [b.code, b.name, b.type])
    return reply.code(201).send(rows[0])
  })

  app.get('/accounting/journal', async (req) => {
    requirePerm(req, 'accounting.view')
    const { from, to } = req.query as Record<string, string | undefined>
    const { rows } = await db.query(
      `SELECT e.id, e.date, e.description, e.ref_type, e.ref_id, e.reversal_of,
         json_agg(json_build_object('code', a.code, 'name', a.name, 'debit', l.debit, 'credit', l.credit) ORDER BY l.id) AS lines
       FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
       WHERE ($1::date IS NULL OR e.date >= $1) AND ($2::date IS NULL OR e.date <= $2)
       GROUP BY e.id ORDER BY e.id DESC LIMIT 300`, [from ?? null, to ?? null])
    return rows
  })

  app.get('/accounting/ledger/:code', async (req) => {
    requirePerm(req, 'accounting.view')
    const code = (req.params as any).code
    const { from, to } = req.query as Record<string, string | undefined>
    const { rows: acc } = await db.query('SELECT * FROM accounts WHERE code = $1', [code])
    if (!acc[0]) throw new HttpError(404, 'Cuenta inexistente')
    const { rows } = await db.query(
      `SELECT e.id, e.date, e.description, l.debit, l.credit FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = $1 AND ($2::date IS NULL OR e.date >= $2) AND ($3::date IS NULL OR e.date <= $3) ORDER BY e.id`,
      [acc[0].id, from ?? null, to ?? null])
    const sign = acc[0].type === 'asset' || acc[0].type === 'expense' ? 1 : -1
    let run = 0
    return { account: acc[0], lines: rows.map((r) => ({ ...r, debit: Number(r.debit), credit: Number(r.credit), balance: (run += sign * (Number(r.debit) - Number(r.credit))) })) }
  })

  app.get('/accounting/trial-balance', async (req) => {
    requirePerm(req, 'accounting.view')
    const { from, to } = req.query as Record<string, string | undefined>
    const rows = (await balances(db, from, to)).filter((r) => r.debit || r.credit)
    return { rows, totalDebit: rows.reduce((s, r) => s + r.debit, 0), totalCredit: rows.reduce((s, r) => s + r.credit, 0) }
  })

  app.get('/accounting/income-statement', async (req) => {
    requirePerm(req, 'accounting.view')
    const { from, to } = req.query as Record<string, string | undefined>
    const all = await balances(db, from, to)
    const income = all.filter((r) => r.type === 'income' && r.balance), expenses = all.filter((r) => r.type === 'expense' && r.balance)
    const totalIncome = income.reduce((s, r) => s + r.balance, 0), totalExpenses = expenses.reduce((s, r) => s + r.balance, 0)
    const cogs = all.find((r) => r.code === ACC.cogs)?.balance ?? 0
    const sales = all.find((r) => r.code === ACC.sales)?.balance ?? 0
    return { income, expenses, totalIncome, totalExpenses, grossProfit: sales - cogs, netIncome: totalIncome - totalExpenses }
  })

  app.get('/accounting/balance-sheet', async (req) => {
    requirePerm(req, 'accounting.view')
    const { to } = req.query as Record<string, string | undefined>
    const all = await balances(db, undefined, to)
    const pick = (t: string) => all.filter((r) => r.type === t && r.balance)
    const netIncome = all.filter((r) => r.type === 'income').reduce((s, r) => s + r.balance, 0) - all.filter((r) => r.type === 'expense').reduce((s, r) => s + r.balance, 0)
    const assets = pick('asset'), liabilities = pick('liability'), equity = pick('equity')
    const tA = assets.reduce((s, r) => s + r.balance, 0), tL = liabilities.reduce((s, r) => s + r.balance, 0), tE = equity.reduce((s, r) => s + r.balance, 0) + netIncome
    return { assets, liabilities, equity, netIncome, totalAssets: tA, totalLiabilities: tL, totalEquity: tE, balanced: tA === tL + tE }
  })

  // Asientos manuales (saldos iniciales, gastos, ajustes) con partida doble validada
  app.post('/accounting/entries', async (req, reply) => {
    requirePerm(req, 'accounting.write')
    const b = z.object({
      description: z.string().min(3),
      lines: z.array(z.object({ code: z.string(), debit: z.number().int().min(0).default(0), credit: z.number().int().min(0).default(0) })).min(2),
    }).parse(req.body)
    const id = await withTx(db, (tx) => post(tx, { description: b.description, refType: 'manual', userId: req.user!.id, lines: b.lines }))
    return reply.code(201).send({ id })
  })
}
