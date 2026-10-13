import { AGING_BUCKETS, agingBucket } from '../credit.js'
import { Params, localToday, refLink, sumBy, type Ctx, type ReportResult } from './core.js'

const BUCKET_KEYS = ['b0', 'b1', 'b2', 'b3', 'b4']

// Deuda de clientes por antigüedad a una fecha: al día, 1-30, 31-60, 61-90 y más de 90 días de atraso.
export async function receivablesReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const asOf = f.asOf ?? f.to ?? localToday()
  const p = new Params()
  const w = [`i.status = 'open'`, `local_date(i.created_at) <= ${p.add(asOf)}::date`]
  const asOfP = `$1`
  if (f.customerId) w.push(`i.customer_id = ${p.add(f.customerId)}`)
  if (f.q) { const q = p.add(`%${f.q}%`); w.push(`(c.name ILIKE ${q} OR s.number ILIKE ${q})`) }
  if (f.dateField === 'due' && f.from) w.push(`i.due_date >= ${p.add(f.from)}::date`)
  if (f.dateField === 'due' && f.to) w.push(`i.due_date <= ${p.add(f.to)}::date`)
  const { rows } = await ctx.db.query(
    `SELECT i.id, i.customer_id, c.name AS customer, c.phone, s.id AS sale_id, s.number AS sale_number, i.number AS n, i.due_date, i.amount, i.credited,
       COALESCE((SELECT SUM(pa.amount) FROM payment_applications pa JOIN payments pay ON pay.id = pa.payment_id WHERE pa.installment_id = i.id AND local_date(pay.at) <= ${asOfP}::date), 0) AS paid,
       (${asOfP}::date - i.due_date) AS days_late
     FROM installments i JOIN customers c ON c.id = i.customer_id LEFT JOIN sales s ON s.id = i.sale_id
     WHERE ${w.join(' AND ')} ORDER BY c.name, i.due_date, i.id`, p.vals)
  const items = rows.map((r) => {
    const pending = Number(r.amount) - Number(r.credited) - Number(r.paid)
    return { ...r, amount: Number(r.amount), credited: Number(r.credited), paid: Number(r.paid), pending, days_late: Number(r.days_late), bucket: agingBucket(Number(r.days_late)),
      due: String(r.due_date instanceof Date ? r.due_date.toISOString() : r.due_date).slice(0, 10), link: refLink(r.sale_id ? 'sale' : 'customer', r.sale_id ?? r.customer_id) }
  }).filter((r) => r.pending > 0)
  const base = { id: 'receivables', subtitle: `Deuda de clientes al ${asOf}` }
  if (f.view === 'detail') {
    const out = items.map((r) => ({ ...r, state: r.days_late > 0 ? `Vencida ${r.days_late} días` : 'Al día', bucket_label: AGING_BUCKETS[r.bucket] }))
    return { ...base, title: 'Cuentas por cobrar — cuotas',
      columns: [{ key: 'customer', label: 'Cliente', type: 'text' }, { key: 'sale_number', label: 'Venta', type: 'text' }, { key: 'n', label: 'Cuota', type: 'int' }, { key: 'due', label: 'Vencimiento', type: 'date' },
        { key: 'amount', label: 'Importe original', type: 'money' }, { key: 'credited', label: 'Notas de crédito', type: 'money' }, { key: 'paid', label: 'Cobrado', type: 'money' }, { key: 'pending', label: 'Saldo', type: 'money' },
        { key: 'days_late', label: 'Días de atraso', type: 'int' }, { key: 'bucket_label', label: 'Antigüedad', type: 'status' }],
      rows: out, totals: { customer: `${out.length} cuotas`, ...sumBy(out, ['amount', 'credited', 'paid', 'pending']) } }
  }
  const byCustomer = new Map<number, Record<string, any>>()
  for (const r of items) {
    const row = byCustomer.get(r.customer_id) ?? { customer: r.customer, phone: r.phone, customer_id: r.customer_id, b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, total: 0, overdue: 0, link: refLink('customer', r.customer_id) }
    row[BUCKET_KEYS[r.bucket]] += r.pending
    row.total += r.pending
    if (r.bucket > 0) row.overdue += r.pending
    byCustomer.set(r.customer_id, row)
  }
  const out = [...byCustomer.values()].sort((a, b) => b.total - a.total)
  return { ...base, title: 'Cuentas por cobrar — antigüedad de deuda',
    columns: [{ key: 'customer', label: 'Cliente', type: 'text' }, { key: 'phone', label: 'Teléfono', type: 'text' },
      ...BUCKET_KEYS.map((k, i) => ({ key: k, label: AGING_BUCKETS[i], type: 'money' as const })), { key: 'overdue', label: 'Total vencido', type: 'money' }, { key: 'total', label: 'Deuda total', type: 'money' }],
    rows: out, totals: { customer: 'Total general', ...sumBy(out, [...BUCKET_KEYS, 'overdue', 'total']) } }
}

// Estado de cuenta de un cliente: movimientos con saldo corrido, cuotas y comprobantes relacionados.
export async function customerStatementReport(ctx: Ctx): Promise<ReportResult> {
  const id = ctx.filters.customerId
  if (!id) return { id: 'customer-statement', title: 'Estado de cuenta', columns: [], rows: [], meta: { needsCustomer: true } }
  const { rows: cust } = await ctx.db.query('SELECT * FROM customers WHERE id = $1', [id])
  if (!cust[0]) return { id: 'customer-statement', title: 'Estado de cuenta', columns: [], rows: [] }
  const { rows: ledger } = await ctx.db.query(
    `SELECT l.id, l.at, l.type, l.amount, l.note, s.number AS sale_number, s.id AS sale_id FROM customer_ledger l LEFT JOIN sales s ON s.id = l.sale_id WHERE l.customer_id = $1 ORDER BY l.id`, [id])
  let run = 0
  const TYPE: Record<string, string> = { charge: 'Venta a crédito', payment: 'Cobro', void: 'Anulación', return: 'Devolución', cheque_rejected: 'Cheque rechazado' }
  const rows = ledger.map((l) => { run += Number(l.amount); return { ...l, type: TYPE[l.type] ?? l.type, debit: Number(l.amount) > 0 ? Number(l.amount) : 0, credit: Number(l.amount) < 0 ? -Number(l.amount) : 0, balance: run, link: refLink(l.sale_id ? 'sale' : null, l.sale_id) } })
  const { rows: inst } = await ctx.db.query(
    `SELECT i.number AS n, s.number AS sale_number, i.due_date, i.amount, i.credited, i.paid, (i.amount - i.credited - i.paid) AS pending, i.status,
       GREATEST(current_date - i.due_date, 0)::int AS days_late FROM installments i LEFT JOIN sales s ON s.id = i.sale_id WHERE i.customer_id = $1 ORDER BY i.due_date, i.id`, [id])
  const { rows: docs } = await ctx.db.query(
    `SELECT inv.kind, inv.number, inv.total, inv.status, s.number AS sale_number FROM invoices inv JOIN sales s ON s.id = inv.sale_id WHERE s.customer_id = $1 ORDER BY inv.id DESC LIMIT 100`, [id])
  const iv = inst.map((r) => ({ ...r, due: String(r.due_date instanceof Date ? r.due_date.toISOString() : r.due_date).slice(0, 10), state: r.status === 'void' ? 'Anulada' : Number(r.pending) <= 0 ? 'Pagada' : Number(r.days_late) > 0 ? 'Vencida' : 'Al día' }))
  return { id: 'customer-statement', title: `Estado de cuenta — ${cust[0].name}`, subtitle: `Saldo actual Gs. ${Number(cust[0].balance).toLocaleString('es-PY')} · límite Gs. ${Number(cust[0].credit_limit).toLocaleString('es-PY')}`,
    columns: [{ key: 'at', label: 'Fecha', type: 'datetime' }, { key: 'type', label: 'Movimiento', type: 'text' }, { key: 'sale_number', label: 'Venta', type: 'text' }, { key: 'note', label: 'Detalle', type: 'text' },
      { key: 'debit', label: 'Cargos', type: 'money' }, { key: 'credit', label: 'Pagos / créditos', type: 'money' }, { key: 'balance', label: 'Saldo', type: 'money' }],
    rows, totals: { type: 'Total', ...sumBy(rows, ['debit', 'credit']), balance: Number(cust[0].balance) },
    sections: [
      { title: 'Cuotas y vencimientos', columns: [{ key: 'sale_number', label: 'Venta', type: 'text' }, { key: 'n', label: 'Cuota', type: 'int' }, { key: 'due', label: 'Vencimiento', type: 'date' }, { key: 'amount', label: 'Importe', type: 'money' },
        { key: 'credited', label: 'Notas de crédito', type: 'money' }, { key: 'paid', label: 'Cobrado', type: 'money' }, { key: 'pending', label: 'Saldo', type: 'money' }, { key: 'state', label: 'Estado', type: 'status' }], rows: iv, totals: { sale_number: 'Total', ...sumBy(iv.filter((r) => r.status === 'open'), ['amount', 'credited', 'paid', 'pending']) } },
      { title: 'Comprobantes relacionados', columns: [{ key: 'sale_number', label: 'Venta', type: 'text' }, { key: 'number', label: 'Comprobante', type: 'text' }, { key: 'total', label: 'Total', type: 'money' }, { key: 'status', label: 'Estado', type: 'status' }], rows: docs.map((d) => ({ ...d, number: `${d.kind === 'invoice' ? 'Factura' : 'Nota de crédito'} ${d.number}` })) },
    ] }
}
