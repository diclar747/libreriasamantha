import { Params, refLink, sumBy, type Ctx, type ReportResult } from './core.js'

const STATUS: Record<string, string> = { pending: 'Pendiente', partial: 'Pago parcial', paid: 'Pagado', void: 'Anulado' }

// Gastos del período: se distingue el gasto registrado (obligación) de su pago.
export async function expensesReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const p = new Params()
  const w: string[] = []
  const dateExpr = f.dateField === 'due' ? 'e.due_date' : f.dateField === 'payment' ? `(SELECT MAX(local_date(ep.paid_at)) FROM expense_payments ep WHERE ep.expense_id = e.id AND NOT ep.voided)` : 'e.expense_date'
  if (f.from) w.push(`${dateExpr} >= ${p.add(f.from)}::date`)
  if (f.to) w.push(`${dateExpr} <= ${p.add(f.to)}::date`)
  if (f.status === 'open') w.push(`e.status IN ('pending','partial')`)
  else if (f.status) w.push(`e.status = ${p.add(f.status)}`)
  else w.push(`e.status <> 'void'`)
  if (f.categoryId) { const c = p.add(f.categoryId); w.push(`(e.category_id = ${c} OR c.parent_id = ${c})`) }
  if (f.overdue) w.push(`e.status IN ('pending','partial') AND e.due_date < current_date`)
  if (f.q) { const q = p.add(`%${f.q}%`); w.push(`(e.concept ILIKE ${q} OR e.beneficiary ILIKE ${q} OR e.number ILIKE ${q} OR e.document_number ILIKE ${q})`) }
  const from = `FROM expenses e JOIN expense_categories c ON c.id = e.category_id LEFT JOIN expense_categories pc ON pc.id = c.parent_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''}`
  const base = { id: 'expenses', subtitle: `Del ${f.from} al ${f.to}` }
  const g = f.groupBy
  if (g) {
    const expr = g === 'category' ? 'COALESCE(pc.name, c.name)' : g === 'subcategory' ? `CASE WHEN pc.id IS NOT NULL THEN pc.name || ' › ' || c.name ELSE c.name END`
      : g === 'month' ? `to_char(e.expense_date, 'YYYY-MM')` : g === 'day' ? `to_char(e.expense_date, 'YYYY-MM-DD')` : g === 'status' ? 'e.status' : `COALESCE(e.beneficiary, '—')`
    const { rows } = await ctx.db.query(
      `SELECT ${expr} AS grp, COUNT(*)::int AS count, SUM(e.amount)::bigint AS amount, SUM(e.paid_amount)::bigint AS paid, SUM(e.amount - e.paid_amount)::bigint AS balance ${from} GROUP BY 1 ORDER BY ${g === 'day' || g === 'month' ? '1' : 'amount DESC'}`, p.vals)
    const out = rows.map((r) => ({ ...r, grp: g === 'status' ? STATUS[r.grp] ?? r.grp : r.grp }))
    return { ...base, title: 'Gastos — resumen', groupBy: g, columns: [{ key: 'grp', label: 'Grupo', type: 'text' }, { key: 'count', label: 'Gastos', type: 'int' }, { key: 'amount', label: 'Importe', type: 'money' }, { key: 'paid', label: 'Pagado', type: 'money' }, { key: 'balance', label: 'Saldo por pagar', type: 'money' }],
      rows: out, totals: { grp: 'Total general', ...sumBy(out, ['count', 'amount', 'paid', 'balance']) } }
  }
  const { rows } = await ctx.db.query(
    `SELECT e.id, e.number, e.expense_date, e.due_date, e.concept, e.beneficiary, e.document_number, e.status, e.amount, e.paid_amount, (e.amount - e.paid_amount) AS balance,
       CASE WHEN pc.id IS NOT NULL THEN pc.name || ' › ' || c.name ELSE c.name END AS category, (e.status IN ('pending','partial') AND e.due_date < current_date) AS overdue ${from} ORDER BY e.expense_date DESC, e.id DESC LIMIT 20000`, p.vals)
  const day = (d: any) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null)
  const out = rows.map((r) => ({ ...r, expense_date: day(r.expense_date), due_date: day(r.due_date), status: r.overdue ? 'Vencido' : STATUS[r.status], link: refLink('expense', r.id) }))
  return { ...base, title: 'Gastos — detalle',
    columns: [{ key: 'number', label: 'N°', type: 'text' }, { key: 'expense_date', label: 'Fecha', type: 'date' }, { key: 'concept', label: 'Concepto', type: 'text' }, { key: 'category', label: 'Categoría', type: 'text' }, { key: 'beneficiary', label: 'Beneficiario', type: 'text' },
      { key: 'document_number', label: 'Comprobante', type: 'text' }, { key: 'due_date', label: 'Vence', type: 'date' }, { key: 'amount', label: 'Importe', type: 'money' }, { key: 'paid_amount', label: 'Pagado', type: 'money' }, { key: 'balance', label: 'Saldo', type: 'money' }, { key: 'status', label: 'Estado', type: 'status' }],
    rows: out, totals: { number: `${out.length} gastos`, ...sumBy(out, ['amount', 'paid_amount', 'balance']) } }
}
