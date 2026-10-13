import { accountBalances } from '../finance.js'
import { expensesReport } from './expenses.js'
import { cashflowReport, dailyFlow, moneyFlowTotals, paymentsReport } from './money.js'
import { receivablesReport } from './receivables.js'
import { balanceSheetReport, incomeStatementReport, profitSeries } from './results.js'
import { salesReport, salesTotals } from './sales.js'
import { previousPeriod, type Ctx } from './core.js'

const delta = (cur: number, prev: number) => (prev === 0 ? null : Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10)

async function periodFigures(ctx: Ctx, p: { from: string; to: string }) {
  const c: Ctx = { ...ctx, filters: { from: p.from, to: p.to } }
  const [sales, flow, exp, pay, is, web, pos, credit] = await Promise.all([
    salesTotals(c), moneyFlowTotals(c), expensesReport(c), paymentsReport({ ...c, filters: { ...c.filters, groupBy: 'method' } }), incomeStatementReport(c),
    salesTotals({ ...c, filters: { ...c.filters, channel: 'web' } }), salesTotals({ ...c, filters: { ...c.filters, channel: 'pos' } }),
    ctx.db.query(
      `SELECT COALESCE(SUM(s.credit_amount) FILTER (WHERE s.status = 'completed'), 0) AS credit_sales,
         (SELECT COALESCE(SUM(pa.amount), 0) FROM payment_applications pa JOIN payments pay ON pay.id = pa.payment_id WHERE local_date(pay.at) BETWEEN $1::date AND $2::date) AS installments_collected
       FROM sales s WHERE local_date(s.created_at) BETWEEN $1::date AND $2::date`, [p.from, p.to]),
  ])
  const purchases = await ctx.db.query(
    `SELECT COALESCE(SUM(pi.qty_ordered * pi.unit_cost), 0) AS ordered FROM purchase_orders po JOIN purchase_items pi ON pi.order_id = po.id
     WHERE po.status NOT IN ('cancelled','draft') AND po.order_date BETWEEN $1::date AND $2::date`, [p.from, p.to])
  const invoiced = await ctx.db.query(
    `SELECT COALESCE(SUM(total), 0) AS total FROM purchase_invoices WHERE status <> 'void' AND doc_date BETWEEN $1::date AND $2::date`, [p.from, p.to])
  return {
    sales, web, pos, flow, expenses: Number(exp.totals?.amount ?? 0), collected: Number(pay.totals?.collected ?? 0), refunds: Number(pay.totals?.refunds ?? 0), fees: Number(pay.totals?.fee ?? 0),
    payByMethod: pay.rows, result: is.meta as Record<string, number>, creditSales: Number(credit.rows[0].credit_sales), installmentsCollected: Number(credit.rows[0].installments_collected),
    purchasesOrdered: Number(purchases.rows[0].ordered), purchasesInvoiced: Number(invoiced.rows[0].total),
  }
}

// Panel de dirección: cada cifra sale de los mismos reportes que su detalle (por eso los totales coinciden).
export async function overviewReport(ctx: Ctx) {
  const f = ctx.filters
  const period = { from: f.from!, to: f.to! }
  const prevP = previousPeriod(period)
  const [cur, prev] = await Promise.all([periodFigures(ctx, period), periodFigures(ctx, prevP)])
  const q = { from: period.from, to: period.to }
  const k = (key: string, label: string, value: number, previous: number, drill: { path: string; params?: Record<string, string> }, opts: { kind?: 'money' | 'int'; good?: 'up' | 'down'; hint?: string } = {}) =>
    ({ key, label, value, previous, delta: delta(value, previous), kind: opts.kind ?? 'money', good: opts.good ?? 'up', hint: opts.hint, drill: { path: drill.path, params: { ...q, ...(drill.params ?? {}) } } })

  const asOf = period.to
  const [ar, balances, snap, daily, flowDaily, byCat, topProducts, channels, profit, stockRows, onlineSnap, poSnap, payables] = await Promise.all([
    receivablesReport({ ...ctx, filters: { asOf } }),
    accountBalances(ctx.db, asOf),
    ctx.db.query(`SELECT COUNT(*) FILTER (WHERE stock - reserved <= 0)::int AS out_of_stock, COUNT(*) FILTER (WHERE stock - reserved > 0 AND stock - reserved <= min_stock)::int AS low_stock,
      COALESCE(SUM(stock * cost), 0)::bigint AS inventory_cost, COALESCE(SUM(stock * price), 0)::bigint AS inventory_potential
      FROM products WHERE active AND kind = 'product'`),
    salesReport({ ...ctx, filters: { ...period, groupBy: 'day' } }),
    dailyFlow({ ...ctx, filters: period }),
    expensesReport({ ...ctx, filters: { ...period, groupBy: 'category' } }),
    salesReport({ ...ctx, filters: { ...period, groupBy: 'product' } }),
    salesReport({ ...ctx, filters: { ...period, groupBy: 'channel' } }),
    profitSeries({ ...ctx, filters: period }),
    ctx.db.query(`SELECT id, code, name, stock, reserved, min_stock, stock - reserved AS available FROM products WHERE active AND kind = 'product' AND stock - reserved <= min_stock ORDER BY stock - reserved, name LIMIT 12`),
    ctx.db.query(`SELECT COUNT(*) FILTER (WHERE payment_status IN ('pending') AND status <> 'cancelled')::int AS pending_payment, COUNT(*) FILTER (WHERE payment_status = 'in_review')::int AS in_review,
      COUNT(*) FILTER (WHERE payment_status = 'approved' AND status = 'confirmed' AND delivery_status IN ('pending','preparing'))::int AS to_prepare,
      COUNT(*) FILTER (WHERE payment_status = 'approved' AND status = 'confirmed' AND delivery_status IN ('ready','dispatched','incident'))::int AS to_deliver FROM orders`),
    ctx.db.query(`SELECT COUNT(*)::int AS orders, COALESCE(SUM(pi.qty_ordered - pi.qty_received), 0)::int AS pending_units FROM purchase_orders po JOIN purchase_items pi ON pi.order_id = po.id WHERE po.status IN ('issued','partial')`),
    ctx.db.query(`SELECT COALESCE(SUM(amount - paid - credited), 0)::bigint AS total, COALESCE(SUM(amount - paid - credited) FILTER (WHERE due_date < current_date), 0)::bigint AS overdue FROM payables WHERE status = 'open'`),
  ])
  const cash = balances.filter((b) => b.kind === 'cash').reduce((a, b) => a + b.balance, 0)
  const bank = balances.filter((b) => b.kind === 'bank').reduce((a, b) => a + b.balance, 0)
  const overdueInst = await ctx.db.query(`SELECT COALESCE(SUM(amount - credited - paid), 0)::bigint AS total, COUNT(*)::int AS n FROM installments WHERE status = 'open' AND amount - credited - paid > 0 AND due_date < current_date`)
  const s = cur.sales, ps = prev.sales
  const kpis = [
    k('gross', 'Ventas brutas', s.gross, ps.gross, { path: '/reports/sales' }),
    k('discount', 'Descuentos', s.discount, ps.discount, { path: '/reports/sales', params: { view: 'detail' } }, { good: 'down' }),
    k('returns', 'Devoluciones', s.returns, ps.returns, { path: '/reports/sales', params: { state: 'all' } }, { good: 'down' }),
    k('net', 'Ventas netas', s.net, ps.net, { path: '/reports/sales' }, { hint: 'IVA incluido' }),
    k('pos', 'Ventas del local', cur.pos.net, prev.pos.net, { path: '/reports/sales', params: { channel: 'pos' } }),
    k('web', 'Ventas de la tienda online', cur.web.net, prev.web.net, { path: '/reports/sales', params: { channel: 'web' } }),
    k('sales', 'Cantidad de ventas', s.sales, ps.sales, { path: '/reports/sales' }, { kind: 'int' }),
    k('units', 'Unidades vendidas', s.units, ps.units, { path: '/reports/sales', params: { view: 'detail' } }, { kind: 'int' }),
    k('ticket', 'Ticket promedio', s.avg_ticket, ps.avg_ticket, { path: '/reports/sales' }),
    k('collected', 'Total cobrado', cur.collected - cur.refunds, prev.collected - prev.refunds, { path: '/reports/payments' }, { hint: 'neto de reembolsos' }),
    k('receivable', 'Pendiente de cobro (clientes)', Number(ar.totals?.total ?? 0), 0, { path: '/reports/receivables', params: { asOf } }, { good: 'down' }),
    k('income', 'Ingresos de dinero', cur.flow.income, prev.flow.income, { path: '/reports/movements', params: { direction: 'in' } }),
    k('expense', 'Egresos de dinero', cur.flow.expense, prev.flow.expense, { path: '/reports/movements', params: { direction: 'out' } }, { good: 'down' }),
    k('purchases', 'Compras facturadas', cur.purchasesInvoiced, prev.purchasesInvoiced, { path: '/reports/purchase-invoices' }),
    k('payables', 'Deuda con proveedores', Number(payables.rows[0].total), 0, { path: '/reports/payables' }, { good: 'down', hint: `vencida Gs. ${Number(payables.rows[0].overdue).toLocaleString('es-PY')}` }),
    k('expenses', 'Gastos operativos', cur.expenses, prev.expenses, { path: '/reports/expenses' }, { good: 'down' }),
    k('cogs', 'Costo de lo vendido', Number(cur.result.cogs), Number(prev.result.cogs), { path: '/reports/results' }, { good: 'down' }),
    k('gross_profit', 'Utilidad bruta', Number(cur.result.gross), Number(prev.result.gross), { path: '/reports/results' }, { hint: `${cur.result.grossMarginPct}% de las ventas netas` }),
    k('result', 'Resultado neto', Number(cur.result.result), Number(prev.result.result), { path: '/reports/results' }),
    k('cash', 'Efectivo en cajas', cash, 0, { path: '/reports/cashflow' }),
    k('bank', 'Saldo en bancos', bank, 0, { path: '/reports/cashflow' }),
    k('credit_sales', 'Ventas a crédito', cur.creditSales, prev.creditSales, { path: '/reports/sales', params: { condition: 'credit' } }),
    k('installments', 'Cuotas cobradas', cur.installmentsCollected, prev.installmentsCollected, { path: '/reports/payments', params: { kinds: 'customer_payment' } }),
    k('overdue', 'Cuotas vencidas', Number(overdueInst.rows[0].total), 0, { path: '/reports/receivables', params: { view: 'detail' } }, { good: 'down', hint: `${overdueInst.rows[0].n} cuotas` }),
  ]
  return {
    period, previous: prevP, kpis,
    accounts: balances.filter((b) => b.active),
    stock: { ...snap.rows[0], inventory_cost: Number(snap.rows[0].inventory_cost), inventory_potential: Number(snap.rows[0].inventory_potential), alerts: stockRows.rows },
    online: onlineSnap.rows[0], purchaseOrders: poSnap.rows[0],
    series: {
      daily: daily.rows.map((r) => ({ day: r.grp, net: Number(r.net), sales: r.sales })),
      flow: flowDaily,
      expensesByCategory: byCat.rows,
      paymentsByMethod: cur.payByMethod,
      topProducts: topProducts.rows.slice(0, 10),
      channels: channels.rows,
      profit,
    },
  }
}

export { cashflowReport, balanceSheetReport }
