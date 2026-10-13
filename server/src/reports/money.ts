import { KIND_LABEL, METHOD_LABEL, MOVEMENTS_SQL, accountBalances, movementsWhere, type MovementFilters } from '../finance.js'
import { Params, refLink, sumBy, type Column, type Ctx, type ReportResult, localToday } from './core.js'

const STATUS_LABEL: Record<string, string> = { none: '—', pending: 'Pendiente de liquidar', settled: 'Liquidado', rejected: 'Rechazado' }
const dayKey = (d: unknown) => (d instanceof Date ? new Date(d.getTime()).toISOString().slice(0, 10) : String(d).slice(0, 10))

// ---------------------------------------------------------------- Cobros por medio de pago
function detailText(method: string, d: any, reference: string | null) {
  d = d ?? {}
  const parts: (string | undefined | null)[] = []
  if (method === 'card') parts.push(d.type === 'debit' ? 'Débito' : 'Crédito', d.processor, d.last4 && `****${d.last4}`)
  else if (method === 'qr') parts.push(d.provider, d.status === 'confirmed' ? 'confirmado' : d.status)
  else if (method === 'transfer') parts.push(d.bank)
  else if (method === 'check') parts.push(`N° ${d.number ?? '—'}`, d.bank, d.holder, d.date, d.status === 'rejected' ? 'rechazado' : d.status === 'received' ? 'recibido' : d.status)
  else if (method === 'cash' && d.received) parts.push(`Recibido ${Number(d.received).toLocaleString('es-PY')}`, d.change ? `vuelto ${Number(d.change).toLocaleString('es-PY')}` : null)
  if (reference && method !== 'check') parts.push(`ref. ${reference}`)
  return parts.filter(Boolean).join(' · ')
}

export async function paymentsReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const p = new Params()
  const w: string[] = [`p.kind IN ('sale','customer_payment','refund','return')`, `p.method <> 'advance'`]
  const dateExpr = f.dateField === 'settlement' ? 'local_date(p.settled_at)' : 'local_date(p.at)'
  if (f.dateField === 'settlement') w.push(`p.settlement_status = 'settled'`)
  if (f.from) w.push(`${dateExpr} >= ${p.add(f.from)}::date`)
  if (f.to) w.push(`${dateExpr} <= ${p.add(f.to)}::date`)
  if (f.method) w.push(`p.method = ${p.add(f.method)}`)
  if (f.accountId) { const a = p.add(f.accountId); w.push(`(p.account_id = ${a} OR p.settled_account_id = ${a})`) }
  if (f.status) w.push(`p.settlement_status = ${p.add(f.status)}`)
  if (f.sessionId) w.push(`p.session_id = ${p.add(f.sessionId)}`)
  if (f.q) { const q = p.add(`%${f.q}%`); w.push(`(s.number ILIKE ${q} OR p.reference ILIKE ${q} OR COALESCE(c.name, c2.name) ILIKE ${q})`) }
  const from = `FROM payments p LEFT JOIN sales s ON s.id = p.sale_id LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN customers c2 ON c2.id = p.customer_id
    LEFT JOIN money_accounts a ON a.id = COALESCE(p.settled_account_id, p.account_id) WHERE ${w.join(' AND ')}`
  const g = f.groupBy ?? (f.view === 'detail' ? undefined : 'method')
  const base = { id: 'payments', subtitle: `Del ${f.from} al ${f.to}${f.dateField === 'settlement' ? ' · por fecha de acreditación' : ''}` }

  if (g) {
    const expr = g === 'day' ? `to_char(local_date(p.at), 'YYYY-MM-DD')` : g === 'month' ? `to_char(local_date(p.at), 'YYYY-MM')`
      : g === 'account' ? `COALESCE(a.name, 'Sin cuenta (pendiente de liquidar)')` : g === 'processor' ? `COALESCE(NULLIF(p.details->>'processor', ''), NULLIF(p.details->>'provider', ''), '—')`
      : g === 'card_type' ? `CASE WHEN p.method <> 'card' THEN '—' WHEN p.details->>'type' = 'debit' THEN 'Débito' ELSE 'Crédito' END` : 'p.method'
    const { rows } = await ctx.db.query(
      `SELECT ${expr} AS grp, COUNT(*)::int AS count, COALESCE(SUM(p.amount) FILTER (WHERE p.amount > 0), 0)::bigint AS collected,
         COALESCE(-SUM(p.amount) FILTER (WHERE p.amount < 0), 0)::bigint AS refunds, COALESCE(SUM(p.amount), 0)::bigint AS net,
         COALESCE(SUM(CASE WHEN p.amount > 0 THEN COALESCE(p.settled_fee, p.fee) ELSE 0 END), 0)::bigint AS fee,
         COALESCE(SUM(p.amount) FILTER (WHERE p.settlement_status = 'pending'), 0)::bigint AS pending,
         COALESCE(SUM(p.amount) FILTER (WHERE p.settlement_status = 'settled'), 0)::bigint AS settled
       ${from} GROUP BY 1 ORDER BY ${g === 'day' || g === 'month' ? '1' : 'net DESC'}`, p.vals)
    const out = rows.map((r) => ({ ...r, grp: g === 'method' ? METHOD_LABEL[r.grp] ?? r.grp : r.grp, received: Number(r.net) - Number(r.fee) }))
    const { rows: comb } = await ctx.db.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(t.total), 0)::bigint AS amount FROM (
         SELECT p.sale_id, SUM(p.amount) AS total ${from} AND p.kind = 'sale' AND p.sale_id IS NOT NULL GROUP BY p.sale_id HAVING COUNT(DISTINCT p.method) > 1) t`, p.vals)
    return { ...base, title: 'Cobros por medio de pago', groupBy: g,
      columns: [{ key: 'grp', label: g === 'method' ? 'Medio de pago' : g === 'day' ? 'Día' : g === 'month' ? 'Mes' : g === 'account' ? 'Cuenta' : g === 'processor' ? 'Procesador / proveedor' : 'Tipo de tarjeta', type: 'text' },
        { key: 'count', label: 'Cobros', type: 'int' }, { key: 'collected', label: 'Cobrado', type: 'money' }, { key: 'refunds', label: 'Reembolsos', type: 'money' }, { key: 'net', label: 'Cobro neto', type: 'money' },
        { key: 'fee', label: 'Comisión', type: 'money' }, { key: 'received', label: 'Neto a recibir', type: 'money' }, { key: 'pending', label: 'Pendiente de liquidar', type: 'money' }, { key: 'settled', label: 'Liquidado', type: 'money' }],
      rows: out, totals: { grp: 'Total general', ...sumBy(out, ['count', 'collected', 'refunds', 'net', 'fee', 'received', 'pending', 'settled']) },
      meta: { combinedSales: comb[0].n, combinedAmount: Number(comb[0].amount) } }
  }

  const { rows } = await ctx.db.query(
    `SELECT p.id, p.at, p.kind, p.method, p.amount, p.reference, p.details, p.settlement_status, p.settled_at, p.sale_id, s.number AS sale_number, COALESCE(c.name, c2.name) AS customer,
       a.name AS account, CASE WHEN p.amount > 0 THEN COALESCE(p.settled_fee, p.fee) ELSE 0 END AS fee
     ${from} ORDER BY p.at DESC, p.id DESC LIMIT 20000`, p.vals)
  const out = rows.map((r) => ({ ...r, kind: ({ sale: 'Cobro de venta', customer_payment: 'Cobro de cuota/anticipo', refund: 'Reembolso', return: 'Devolución' } as any)[r.kind], method: METHOD_LABEL[r.method] ?? r.method,
    detail: detailText(r.method, r.details, r.reference), status: STATUS_LABEL[r.settlement_status], received: Number(r.amount) - Number(r.fee), link: refLink(r.sale_id ? 'sale' : null, r.sale_id) }))
  return { ...base, title: 'Cobros — detalle',
    columns: [{ key: 'at', label: 'Fecha y hora', type: 'datetime' }, { key: 'sale_number', label: 'Venta', type: 'text' }, { key: 'customer', label: 'Cliente', type: 'text' }, { key: 'kind', label: 'Tipo', type: 'text' },
      { key: 'method', label: 'Medio', type: 'text' }, { key: 'detail', label: 'Detalle', type: 'text' }, { key: 'account', label: 'Cuenta', type: 'text' }, { key: 'amount', label: 'Importe', type: 'money' },
      { key: 'fee', label: 'Comisión', type: 'money' }, { key: 'received', label: 'Neto', type: 'money' }, { key: 'status', label: 'Liquidación', type: 'status' }, { key: 'settled_at', label: 'Acreditado', type: 'datetime' }],
    rows: out, totals: { sale_number: `${out.length} cobros`, ...sumBy(out, ['amount', 'fee', 'received']) } }
}

// ---------------------------------------------------------------- Registro unificado de movimientos
export function movementFilters(f: Ctx['filters']): MovementFilters {
  return { from: f.from, to: f.to, kinds: f.kinds, direction: f.direction, method: f.method, accountId: f.accountId, sessionId: f.sessionId, userId: f.userId ?? f.sellerId,
    partyType: f.partyType, partyId: f.partyId, q: f.q, category: f.category, includeVoided: f.includeVoided }
}

export async function movementsReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const params: unknown[] = []
  const where = movementsWhere(movementFilters(f), params)
  const base = { id: 'movements', subtitle: `Del ${f.from} al ${f.to}` }
  const sums = `COALESCE(SUM(amount) FILTER (WHERE amount > 0 AND kind NOT IN ('owner_contribution')), 0)::bigint AS income, COALESCE(-SUM(amount) FILTER (WHERE amount < 0 AND kind NOT IN ('owner_withdrawal')), 0)::bigint AS expense,
    COALESCE(SUM(amount) FILTER (WHERE kind = 'owner_contribution'), 0)::bigint AS owner_in, COALESCE(-SUM(amount) FILTER (WHERE kind = 'owner_withdrawal'), 0)::bigint AS owner_out`
  const g = f.groupBy
  if (g) {
    const expr = g === 'day' ? `to_char(local_date(mv.at), 'YYYY-MM-DD')` : g === 'month' ? `to_char(local_date(mv.at), 'YYYY-MM')` : g === 'category' ? 'mv.category'
      : g === 'kind' ? 'mv.kind' : g === 'method' ? 'mv.method' : g === 'account' ? `COALESCE(a.name, '—')` : `COALESCE(u.name, '—')`
    const { rows } = await ctx.db.query(
      `WITH mv AS (${MOVEMENTS_SQL}) SELECT ${expr} AS grp, COUNT(*)::int AS count, ${sums.replace(/\b(amount|kind)\b/g, 'mv.$1')}
       FROM mv LEFT JOIN money_accounts a ON a.id = mv.account_id LEFT JOIN users u ON u.id = mv.user_id ${where} GROUP BY 1 ORDER BY ${g === 'day' || g === 'month' ? '1' : 'income DESC'}`, params)
    const out = rows.map((r) => ({ ...r, grp: g === 'kind' ? KIND_LABEL[r.grp] ?? r.grp : g === 'method' ? METHOD_LABEL[r.grp] ?? r.grp : r.grp, net: Number(r.income) - Number(r.expense) }))
    return { ...base, title: 'Movimientos de dinero — resumen', groupBy: g,
      columns: [{ key: 'grp', label: 'Grupo', type: 'text' }, { key: 'count', label: 'Movimientos', type: 'int' }, { key: 'income', label: 'Ingresos', type: 'money' }, { key: 'expense', label: 'Egresos', type: 'money' },
        { key: 'net', label: 'Resultado', type: 'money' }, { key: 'owner_in', label: 'Aportes del propietario', type: 'money' }, { key: 'owner_out', label: 'Retiros del propietario', type: 'money' }],
      rows: out, totals: { grp: 'Total general', ...sumBy(out, ['count', 'income', 'expense', 'net', 'owner_in', 'owner_out']) } }
  }
  const { rows } = await ctx.db.query(
    `WITH mv AS (${MOVEMENTS_SQL}) SELECT mv.*, u.name AS user_name, a.name AS account_name FROM mv LEFT JOIN users u ON u.id = mv.user_id LEFT JOIN money_accounts a ON a.id = mv.account_id ${where}
     ORDER BY mv.at DESC, mv.key DESC LIMIT 20000`, params)
  const out = rows.map((r) => ({ ...r, kind_label: KIND_LABEL[r.kind] ?? r.kind, method_label: METHOD_LABEL[r.method] ?? r.method, party: r.party_name ?? '—',
    income: Number(r.amount) > 0 ? Number(r.amount) : 0, expense: Number(r.amount) < 0 ? -Number(r.amount) : 0, state: r.voided ? 'Anulado' : '', link: refLink(r.ref_type, r.ref_id) }))
  const { rows: t } = await ctx.db.query(`WITH mv AS (${MOVEMENTS_SQL}) SELECT ${sums.replace(/\b(amount|kind)\b/g, 'mv.$1')} FROM mv ${where}`, params)
  return { ...base, title: 'Registro de movimientos de dinero',
    columns: [{ key: 'at', label: 'Fecha y hora', type: 'datetime' }, { key: 'kind_label', label: 'Tipo', type: 'text' }, { key: 'concept', label: 'Concepto', type: 'text' }, { key: 'category', label: 'Categoría', type: 'text' },
      { key: 'method_label', label: 'Medio', type: 'text' }, { key: 'account_name', label: 'Cuenta / caja', type: 'text' }, { key: 'party', label: 'Cliente / proveedor', type: 'text' }, { key: 'user_name', label: 'Responsable', type: 'text' },
      { key: 'ref_number', label: 'Comprobante', type: 'text' }, { key: 'reference', label: 'Referencia', type: 'text' }, { key: 'income', label: 'Ingreso', type: 'money' }, { key: 'expense', label: 'Egreso', type: 'money' },
      { key: 'notes', label: 'Observaciones', type: 'text' }, { key: 'state', label: 'Estado', type: 'status' }],
    rows: out, totals: { concept: `${out.length} movimientos`, income: Number(t[0].income) + Number(t[0].owner_in), expense: Number(t[0].expense) + Number(t[0].owner_out) },
    meta: { income: Number(t[0].income), expense: Number(t[0].expense), ownerIn: Number(t[0].owner_in), ownerOut: Number(t[0].owner_out) } }
}

// Ingresos y egresos operativos del período (sin aportes ni retiros del propietario ni transferencias internas).
export async function moneyFlowTotals(ctx: Ctx) {
  const params: unknown[] = []
  const where = movementsWhere(movementFilters({ ...ctx.filters, kinds: undefined, groupBy: undefined }), params)
  const { rows } = await ctx.db.query(
    `WITH mv AS (${MOVEMENTS_SQL}) SELECT COALESCE(SUM(amount) FILTER (WHERE amount > 0 AND kind <> 'owner_contribution'), 0)::bigint AS income,
       COALESCE(-SUM(amount) FILTER (WHERE amount < 0 AND kind <> 'owner_withdrawal'), 0)::bigint AS expense,
       COALESCE(SUM(amount) FILTER (WHERE kind = 'owner_contribution'), 0)::bigint AS owner_in, COALESCE(-SUM(amount) FILTER (WHERE kind = 'owner_withdrawal'), 0)::bigint AS owner_out
     FROM mv ${where}`, params)
  const r = rows[0]
  return { income: Number(r.income), expense: Number(r.expense), owner_in: Number(r.owner_in), owner_out: Number(r.owner_out) }
}

export async function dailyFlow(ctx: Ctx) {
  const params: unknown[] = []
  const where = movementsWhere(movementFilters({ ...ctx.filters, kinds: undefined }), params)
  const { rows } = await ctx.db.query(
    `WITH mv AS (${MOVEMENTS_SQL}) SELECT local_date(at) AS day, COALESCE(SUM(amount) FILTER (WHERE amount > 0 AND kind <> 'owner_contribution'), 0)::bigint AS income,
       COALESCE(-SUM(amount) FILTER (WHERE amount < 0 AND kind <> 'owner_withdrawal'), 0)::bigint AS expense FROM mv ${where} GROUP BY 1 ORDER BY 1`, params)
  return rows.map((r) => ({ day: dayKey(r.day), income: Number(r.income), expense: Number(r.expense) }))
}

// ---------------------------------------------------------------- Flujo de dinero por caja y banco
export async function cashflowReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const { rows } = await ctx.db.query(
    `WITH mv AS (${MOVEMENTS_SQL})
     SELECT a.id, a.kind, a.name, a.opening_balance + COALESCE(SUM(mv.account_delta) FILTER (WHERE local_date(mv.at) < $1::date), 0) AS opening,
       COALESCE(SUM(mv.account_delta) FILTER (WHERE mv.account_delta > 0 AND local_date(mv.at) BETWEEN $1::date AND $2::date), 0) AS inflow,
       COALESCE(-SUM(mv.account_delta) FILTER (WHERE mv.account_delta < 0 AND local_date(mv.at) BETWEEN $1::date AND $2::date), 0) AS outflow
     FROM money_accounts a LEFT JOIN mv ON mv.account_id = a.id AND NOT mv.voided GROUP BY a.id ORDER BY a.kind, a.id`, [f.from, f.to])
  const out = rows.map((r) => ({ name: `${r.kind === 'cash' ? 'Caja' : 'Banco'} · ${r.name}`, opening: Number(r.opening), inflow: Number(r.inflow), outflow: Number(r.outflow), closing: Number(r.opening) + Number(r.inflow) - Number(r.outflow) }))
  const { rows: kinds } = await ctx.db.query(
    `WITH mv AS (${MOVEMENTS_SQL}) SELECT mv.kind, COALESCE(SUM(mv.account_delta) FILTER (WHERE mv.account_delta > 0), 0) AS inflow, COALESCE(-SUM(mv.account_delta) FILTER (WHERE mv.account_delta < 0), 0) AS outflow
     FROM mv WHERE NOT mv.voided AND mv.account_delta IS NOT NULL AND local_date(mv.at) BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 2 DESC, 3 DESC`, [f.from, f.to])
  const k = kinds.map((r) => ({ concept: KIND_LABEL[r.kind] ?? r.kind, inflow: Number(r.inflow), outflow: Number(r.outflow) }))
  return { id: 'cashflow', title: 'Flujo de dinero', subtitle: `Del ${f.from} al ${f.to}`,
    columns: [{ key: 'name', label: 'Caja / cuenta', type: 'text' }, { key: 'opening', label: 'Saldo inicial', type: 'money' }, { key: 'inflow', label: 'Cobros / entradas', type: 'money' }, { key: 'outflow', label: 'Pagos / salidas', type: 'money' }, { key: 'closing', label: 'Saldo final', type: 'money' }],
    rows: out, totals: { name: 'Total', ...sumBy(out, ['opening', 'inflow', 'outflow', 'closing']) },
    sections: [{ title: 'De dónde vienen y a dónde van los movimientos (incluye transferencias entre cuentas propias)', columns: [{ key: 'concept', label: 'Concepto', type: 'text' }, { key: 'inflow', label: 'Entradas', type: 'money' }, { key: 'outflow', label: 'Salidas', type: 'money' }], rows: k, totals: { concept: 'Total', ...sumBy(k, ['inflow', 'outflow']) } }] }
}

// ---------------------------------------------------------------- Turnos de caja
export async function cashSessionsReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const p = new Params()
  const w: string[] = []
  if (f.from) w.push(`local_date(cs.opened_at) >= ${p.add(f.from)}::date`)
  if (f.to) w.push(`local_date(cs.opened_at) <= ${p.add(f.to)}::date`)
  if (f.userId ?? f.sellerId) w.push(`cs.user_id = ${p.add(f.userId ?? f.sellerId)}`)
  if (f.status) w.push(`cs.status = ${p.add(f.status)}`)
  if (f.sessionId) w.push(`cs.id = ${p.add(f.sessionId)}`)
  const { rows } = await ctx.db.query(
    `WITH mv AS (${MOVEMENTS_SQL}), agg AS (
       SELECT mv.session_id,
         COALESCE(SUM(mv.account_delta) FILTER (WHERE a.kind = 'cash' AND mv.kind <> 'cash_difference' AND COALESCE(mv.reference, '') NOT LIKE 'close:%' AND mv.account_delta > 0), 0) AS cash_in,
         COALESCE(-SUM(mv.account_delta) FILTER (WHERE a.kind = 'cash' AND mv.kind <> 'cash_difference' AND COALESCE(mv.reference, '') NOT LIKE 'close:%' AND mv.account_delta < 0), 0) AS cash_out,
         COALESCE(SUM(mv.amount) FILTER (WHERE mv.kind IN ('sale_payment','customer_payment') AND mv.method = 'cash'), 0) AS cash_sales,
         COALESCE(SUM(mv.amount) FILTER (WHERE mv.kind IN ('sale_payment','customer_payment') AND mv.method <> 'cash'), 0) AS other_methods,
         COALESCE(-SUM(mv.amount) FILTER (WHERE mv.kind IN ('refund','sale_return')), 0) AS refunds
       FROM mv LEFT JOIN money_accounts a ON a.id = mv.account_id WHERE NOT mv.voided AND mv.session_id IS NOT NULL GROUP BY mv.session_id)
     SELECT cs.id, u.name AS cashier, cs.shift, cs.opened_at, cs.closed_at, cs.status, cs.opening_float, cs.expected_cash, cs.counted_cash, cs.diff_status, cs.deposit_amount, cs.reserve_amount, cs.reopen_count,
       COALESCE(agg.cash_in, 0) AS cash_in, COALESCE(agg.cash_out, 0) AS cash_out, COALESCE(agg.cash_sales, 0) AS cash_sales, COALESCE(agg.other_methods, 0) AS other_methods, COALESCE(agg.refunds, 0) AS refunds
     FROM cash_sessions cs JOIN users u ON u.id = cs.user_id LEFT JOIN agg ON agg.session_id = cs.id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY cs.id DESC LIMIT 500`, p.vals)
  const DIFF: Record<string, string> = { none: '—', pending_approval: 'Pendiente de aprobar', approved: 'Aprobada' }
  const out = rows.map((r) => {
    const expected = r.status === 'closed' ? Number(r.expected_cash) : Number(r.opening_float) + Number(r.cash_in) - Number(r.cash_out)
    const counted = r.status === 'closed' ? Number(r.counted_cash) : null
    return { ...r, expected, counted, difference: counted === null ? null : counted - expected, state: r.status === 'closed' ? 'Cerrada' : 'Abierta', diff: DIFF[r.diff_status], link: refLink('cash_session', r.id), number: `#${r.id}`,
      pending_deposit: r.status === 'closed' ? Number(r.counted_cash) - Number(r.deposit_amount) - Number(r.reserve_amount) : null }
  })
  return { id: 'cash-sessions', title: 'Cajas y turnos', subtitle: `Del ${f.from} al ${f.to}`,
    columns: [{ key: 'number', label: 'Turno', type: 'text' }, { key: 'cashier', label: 'Responsable', type: 'text' }, { key: 'shift', label: 'Turno', type: 'text' }, { key: 'opened_at', label: 'Apertura', type: 'datetime' }, { key: 'closed_at', label: 'Cierre', type: 'datetime' },
      { key: 'opening_float', label: 'Fondo inicial', type: 'money' }, { key: 'cash_sales', label: 'Cobros en efectivo', type: 'money' }, { key: 'other_methods', label: 'Otros medios', type: 'money' }, { key: 'refunds', label: 'Reembolsos', type: 'money' },
      { key: 'expected', label: 'Efectivo esperado', type: 'money' }, { key: 'counted', label: 'Contado', type: 'money' }, { key: 'difference', label: 'Sobrante / faltante', type: 'money' },
      { key: 'diff', label: 'Diferencia', type: 'status' }, { key: 'deposit_amount', label: 'Depositado', type: 'money' }, { key: 'reserve_amount', label: 'Fondo reservado', type: 'money' }, { key: 'state', label: 'Estado', type: 'status' }],
    rows: out, totals: { number: `${out.length} turnos`, ...sumBy(out.filter((r) => r.status === 'closed'), ['difference']), ...sumBy(out, ['cash_sales', 'other_methods', 'refunds', 'deposit_amount', 'reserve_amount']) } }
}

export { accountBalances, localToday }
export const _columns: Column[] = []
