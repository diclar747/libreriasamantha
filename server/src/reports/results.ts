import { Params, pct, type Ctx, type ReportResult } from './core.js'

interface Bal { code: string; name: string; type: string; debit: number; credit: number; balance: number }

// Saldos por cuenta del libro diario en un período (o hasta una fecha). Ingresos y pasivos: haber − debe; activos y gastos: debe − haber.
export async function journalBalances(ctx: Ctx, from: string | null, to: string | null): Promise<Bal[]> {
  const p = new Params()
  const f = p.add(from)
  const t = p.add(to)
  const { rows } = await ctx.db.query(
    `SELECT a.code, a.name, a.type, COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
     FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id
       LEFT JOIN journal_entries e ON e.id = l.entry_id AND (${f}::date IS NULL OR e.date >= ${f}::date) AND (${t}::date IS NULL OR e.date <= ${t}::date)
     WHERE l.id IS NULL OR e.id IS NOT NULL GROUP BY a.id ORDER BY a.code`, p.vals)
  return rows.map((r) => {
    const debit = Number(r.debit), credit = Number(r.credit)
    return { code: r.code, name: r.name, type: r.type, debit, credit, balance: r.type === 'asset' || r.type === 'expense' ? debit - credit : credit - debit }
  })
}

const sum = (b: Bal[], pred: (x: Bal) => boolean) => b.filter(pred).reduce((a, x) => a + x.balance, 0)

// Estado de resultados: ventas netas − costo = utilidad bruta; + otros ingresos − gastos = resultado neto. Los aportes del propietario no son utilidad.
export async function incomeStatementReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const b = await journalBalances(ctx, f.from ?? null, f.to ?? null)
  const sales = sum(b, (x) => x.code === '4.1.01')
  const returns = sum(b, (x) => x.code === '4.1.02')
  const net = sales - returns
  const cogs = sum(b, (x) => x.code === '5.1.01')
  const gross = net - cogs
  const otherIncome = b.filter((x) => x.type === 'income' && !x.code.startsWith('4.1') && x.balance !== 0)
  const adjustments = sum(b, (x) => x.code === '5.1.02')
  const opEx = b.filter((x) => x.type === 'expense' && x.code !== '5.1.01' && x.code !== '5.1.02' && x.balance !== 0)
  const totalOther = otherIncome.reduce((a, x) => a + x.balance, 0)
  const totalEx = opEx.reduce((a, x) => a + x.balance, 0)
  const result = gross + totalOther - adjustments - totalEx
  const L = (label: string, amount: number, level = 0, bold = false) => ({ label, amount, level, bold, pct: net ? pct(amount, net) : 0 })
  const rows = [
    L('Ventas', sales), L('(−) Devoluciones sobre ventas', -returns), L('Ventas netas', net, 0, true),
    L('(−) Costo de mercaderías vendidas', -cogs), L('Utilidad bruta', gross, 0, true),
    ...(otherIncome.length ? [L('Otros ingresos', totalOther, 0, true), ...otherIncome.map((x) => L(x.name, x.balance, 1))] : []),
    ...(adjustments ? [L('(−) Ajustes de inventario', -adjustments)] : []),
    L('Gastos operativos', -totalEx, 0, true), ...opEx.map((x) => L(x.name, -x.balance, 1)),
    L('Resultado neto del período', result, 0, true),
  ]
  return { id: 'income-statement', title: 'Estado de resultados', subtitle: `Del ${f.from} al ${f.to} · ventas sin IVA · costo por método de costo promedio`,
    columns: [{ key: 'label', label: 'Concepto', type: 'text' }, { key: 'amount', label: 'Importe', type: 'money' }, { key: 'pct', label: '% s/ ventas netas', type: 'percent' }],
    rows, totals: undefined, meta: { sales, returns, net, cogs, gross, otherIncome: totalOther, adjustments, expenses: totalEx, result, grossMarginPct: net ? pct(gross, net) : 0 } }
}

// Balance general a una fecha: activos = pasivos + patrimonio (el resultado acumulado se suma al patrimonio).
export async function balanceSheetReport(ctx: Ctx): Promise<ReportResult> {
  const asOf = ctx.filters.asOf ?? ctx.filters.to ?? null
  const b = await journalBalances(ctx, null, asOf)
  const assets = b.filter((x) => x.type === 'asset' && x.balance !== 0)
  const liabilities = b.filter((x) => x.type === 'liability' && x.balance !== 0)
  const equity = b.filter((x) => x.type === 'equity' && x.balance !== 0)
  const result = sum(b, (x) => x.type === 'income') - sum(b, (x) => x.type === 'expense')
  const tA = assets.reduce((a, x) => a + x.balance, 0), tL = liabilities.reduce((a, x) => a + x.balance, 0), tE = equity.reduce((a, x) => a + x.balance, 0) + result
  const L = (label: string, amount: number, level = 0, bold = false) => ({ label, amount, level, bold })
  const rows = [
    L('ACTIVO', tA, 0, true), ...assets.map((x) => L(`${x.code} · ${x.name}`, x.balance, 1)),
    L('PASIVO', tL, 0, true), ...liabilities.map((x) => L(`${x.code} · ${x.name}`, x.balance, 1)),
    L('PATRIMONIO', tE, 0, true), ...equity.map((x) => L(`${x.code} · ${x.name}`, x.balance, 1)), L('Resultado acumulado (no retirado)', result, 1),
    L('PASIVO + PATRIMONIO', tL + tE, 0, true),
  ]
  return { id: 'balance-sheet', title: 'Balance general', subtitle: `Al ${asOf ?? 'hoy'} · ${tA === tL + tE ? 'activo = pasivo + patrimonio' : 'NO CUADRA'}`,
    columns: [{ key: 'label', label: 'Cuenta', type: 'text' }, { key: 'amount', label: 'Importe', type: 'money' }], rows, meta: { assets: tA, liabilities: tL, equity: tE, balanced: tA === tL + tE, result } }
}

// Resultado por día según contabilidad (evolución de la rentabilidad).
export async function profitSeries(ctx: Ctx) {
  const { rows } = await ctx.db.query(
    `SELECT e.date AS day, COALESCE(SUM(CASE WHEN a.type = 'income' THEN l.credit - l.debit WHEN a.type = 'expense' THEN l.credit - l.debit END), 0) AS result,
       COALESCE(SUM(CASE WHEN a.code IN ('4.1.01','4.1.02') THEN l.credit - l.debit END), 0) AS net_sales
     FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE a.type IN ('income','expense') AND e.date BETWEEN $1::date AND $2::date GROUP BY e.date ORDER BY e.date`, [ctx.filters.from, ctx.filters.to])
  return rows.map((r) => ({ day: String(r.day instanceof Date ? r.day.toISOString() : r.day).slice(0, 10), result: Number(r.result), net_sales: Number(r.net_sales) }))
}
