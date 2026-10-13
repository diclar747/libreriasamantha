import { AGING_BUCKETS, agingBucket } from '../credit.js'
import { Params, localToday, sumBy, type Ctx, type ReportResult } from './core.js'

const PO_STATUS: Record<string, string> = { draft: 'Borrador', pending_approval: 'Pendiente de aprobación', approved: 'Aprobada', issued: 'Emitida', partial: 'Recibida parcial', received: 'Recibida', closed_short: 'Cerrada incompleta', cancelled: 'Anulada' }
const INV_STATUS: Record<string, string> = { open: 'Pendiente de pago', paid: 'Pagada', void: 'Anulada' }
const RET_STATUS: Record<string, string> = { none: 'Sin crédito', pending: 'Crédito pendiente', partial: 'Crédito parcial', credited: 'Acreditada' }
const day = (v: any) => (v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10))

export async function purchaseOrdersReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const p = new Params()
  const w = [`po.order_date BETWEEN ${p.add(f.from)}::date AND ${p.add(f.to)}::date`]
  if (f.supplierId) w.push(`po.supplier_id = ${p.add(f.supplierId)}`)
  if (f.status) w.push(`po.status = ${p.add(f.status)}`)
  if (f.q) { const q = p.add(`%${f.q}%`); w.push(`(po.number ILIKE ${q} OR s.name ILIKE ${q} OR po.reference ILIKE ${q})`) }
  const from = `FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE ${w.join(' AND ')}`
  const base = { id: 'purchase-orders', subtitle: `Del ${f.from} al ${f.to}` }
  if (f.groupBy) {
    const g = f.groupBy
    const expr = g === 'supplier' ? 's.name' : g === 'month' ? `to_char(po.order_date, 'YYYY-MM')` : g === 'day' ? `to_char(po.order_date, 'YYYY-MM-DD')` : 'po.status'
    const { rows } = await ctx.db.query(`SELECT ${expr} AS grp, COUNT(*)::int AS orders, SUM(po.net)::bigint AS net, SUM(po.tax)::bigint AS tax, SUM(po.total)::bigint AS total ${from} GROUP BY 1 ORDER BY ${g === 'month' || g === 'day' ? '1' : 'total DESC'}`, p.vals)
    const out = rows.map((r) => ({ ...r, grp: g === 'status' ? PO_STATUS[r.grp] ?? r.grp : r.grp }))
    return { ...base, title: 'Órdenes de compra — resumen', groupBy: g, columns: [{ key: 'grp', label: 'Grupo', type: 'text' }, { key: 'orders', label: 'Órdenes', type: 'int' }, { key: 'net', label: 'Subtotal', type: 'money' }, { key: 'tax', label: 'IVA', type: 'money' }, { key: 'total', label: 'Total', type: 'money' }],
      rows: out, totals: { grp: 'Total general', ...sumBy(out, ['orders', 'net', 'tax', 'total']) } }
  }
  const { rows } = await ctx.db.query(
    `SELECT po.id, po.number, po.order_date, po.expected_date, s.name AS supplier, po.status, po.net, po.tax, po.extra_costs, po.total,
       COALESCE((SELECT SUM(qty_ordered) FROM purchase_items WHERE order_id = po.id), 0)::int AS qty_ordered, COALESCE((SELECT SUM(qty_received) FROM purchase_items WHERE order_id = po.id), 0)::int AS qty_received,
       COALESCE((SELECT SUM(i.total) FROM purchase_invoices i JOIN purchase_invoice_orders o ON o.invoice_id = i.id WHERE o.order_id = po.id AND i.status <> 'void'), 0)::bigint AS invoiced ${from} ORDER BY po.order_date DESC, po.id DESC LIMIT 20000`, p.vals)
  const out = rows.map((r) => ({ ...r, order_date: day(r.order_date), expected_date: day(r.expected_date), status: PO_STATUS[r.status] ?? r.status, progress: r.qty_ordered ? Math.round((r.qty_received / r.qty_ordered) * 100) : 0, link: `/purchases?open=${r.id}` }))
  return { ...base, title: 'Órdenes de compra', columns: [{ key: 'number', label: 'Orden', type: 'text' }, { key: 'order_date', label: 'Fecha', type: 'date' }, { key: 'supplier', label: 'Proveedor', type: 'text' }, { key: 'status', label: 'Estado', type: 'status' }, { key: 'expected_date', label: 'Entrega prevista', type: 'date' },
    { key: 'net', label: 'Subtotal', type: 'money', sensitive: true }, { key: 'tax', label: 'IVA', type: 'money', sensitive: true }, { key: 'total', label: 'Total', type: 'money', sensitive: true }, { key: 'progress', label: '% recibido', type: 'percent' }, { key: 'invoiced', label: 'Facturado', type: 'money', sensitive: true }],
    rows: out, totals: { number: `${out.length} órdenes`, ...sumBy(out, ['net', 'tax', 'total', 'invoiced']) } }
}

export async function purchaseInvoicesReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const p = new Params()
  const w = [`i.doc_date BETWEEN ${p.add(f.from)}::date AND ${p.add(f.to)}::date`, f.includeVoided ? 'true' : `i.status <> 'void'`]
  if (f.supplierId) w.push(`i.supplier_id = ${p.add(f.supplierId)}`)
  if (f.status) w.push(`i.status = ${p.add(f.status)}`)
  if (f.condition) w.push(`i.payment_condition = ${p.add(f.condition)}`)
  if (f.q) { const q = p.add(`%${f.q}%`); w.push(`(i.doc_number ILIKE ${q} OR s.name ILIKE ${q})`) }
  const from = `FROM purchase_invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE ${w.join(' AND ')}`
  const base = { id: 'purchase-invoices', subtitle: `Del ${f.from} al ${f.to}` }
  if (f.groupBy) {
    const g = f.groupBy
    const expr = g === 'supplier' ? 's.name' : g === 'month' ? `to_char(i.doc_date, 'YYYY-MM')` : g === 'day' ? `to_char(i.doc_date, 'YYYY-MM-DD')` : g === 'condition' ? `CASE i.payment_condition WHEN 'cash' THEN 'Contado' ELSE 'Crédito' END` : 'i.status'
    const { rows } = await ctx.db.query(`SELECT ${expr} AS grp, COUNT(*)::int AS invoices, SUM(i.subtotal)::bigint AS subtotal, SUM(i.tax_total)::bigint AS tax, SUM(i.total)::bigint AS total, SUM(i.paid)::bigint AS paid, SUM(i.credited)::bigint AS credited, SUM(i.total - i.paid - i.credited)::bigint AS pending ${from} GROUP BY 1 ORDER BY ${g === 'month' || g === 'day' ? '1' : 'total DESC'}`, p.vals)
    const out = rows.map((r) => ({ ...r, grp: g === 'status' ? INV_STATUS[r.grp] ?? r.grp : r.grp }))
    return { ...base, title: 'Compras facturadas — resumen', groupBy: g, columns: [{ key: 'grp', label: 'Grupo', type: 'text' }, { key: 'invoices', label: 'Facturas', type: 'int' }, { key: 'subtotal', label: 'Gravado', type: 'money' }, { key: 'tax', label: 'IVA crédito', type: 'money' }, { key: 'total', label: 'Total', type: 'money' }, { key: 'paid', label: 'Pagado', type: 'money' }, { key: 'credited', label: 'Notas de crédito', type: 'money' }, { key: 'pending', label: 'Saldo', type: 'money' }],
      rows: out, totals: { grp: 'Total general', ...sumBy(out, ['invoices', 'subtotal', 'tax', 'total', 'paid', 'credited', 'pending']) } }
  }
  const { rows } = await ctx.db.query(
    `SELECT i.id, i.number, i.doc_date, i.doc_number, i.timbrado, s.name AS supplier, i.payment_condition, i.subtotal, i.extra_costs, i.tax_total, i.total, i.paid, i.credited, (i.total - i.paid - i.credited) AS pending, i.status,
       (SELECT string_agg(DISTINCT po.number, ', ') FROM purchase_invoice_orders o JOIN purchase_orders po ON po.id = o.order_id WHERE o.invoice_id = i.id) AS orders,
       (SELECT MIN(due_date) FROM payables WHERE invoice_id = i.id AND status = 'open' AND amount - paid - credited > 0) AS next_due ${from} ORDER BY i.doc_date DESC, i.id DESC LIMIT 20000`, p.vals)
  const out = rows.map((r) => ({ ...r, doc_date: day(r.doc_date), next_due: day(r.next_due), payment_condition: r.payment_condition === 'cash' ? 'Contado' : 'Crédito', status: INV_STATUS[r.status] ?? r.status, link: `/purchases?tab=invoices&open=${r.id}` }))
  return { ...base, title: 'Compras facturadas', columns: [{ key: 'doc_date', label: 'Fecha', type: 'date' }, { key: 'doc_number', label: 'Factura', type: 'text' }, { key: 'supplier', label: 'Proveedor', type: 'text' }, { key: 'orders', label: 'Órdenes', type: 'text' }, { key: 'payment_condition', label: 'Condición', type: 'text' },
    { key: 'subtotal', label: 'Gravado', type: 'money' }, { key: 'tax_total', label: 'IVA crédito', type: 'money' }, { key: 'total', label: 'Total', type: 'money' }, { key: 'paid', label: 'Pagado', type: 'money' }, { key: 'credited', label: 'N. crédito', type: 'money' }, { key: 'pending', label: 'Saldo', type: 'money' }, { key: 'next_due', label: 'Próx. venc.', type: 'date' }, { key: 'status', label: 'Estado', type: 'status' }],
  rows: out, totals: { doc_date: `${out.length} facturas`, ...sumBy(out, ['subtotal', 'tax_total', 'total', 'paid', 'credited', 'pending']) } }
}

const BUCKETS = ['b0', 'b1', 'b2', 'b3', 'b4']
// Cuentas por pagar por antigüedad de vencimiento a una fecha.
export async function payablesReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const asOf = f.asOf ?? f.to ?? localToday()
  const p = new Params()
  const w = [`pb.status = 'open'`, `i.doc_date <= ${p.add(asOf)}::date`]
  if (f.supplierId) w.push(`pb.supplier_id = ${p.add(f.supplierId)}`)
  if (f.dateField === 'due' && f.from) w.push(`pb.due_date >= ${p.add(f.from)}::date`)
  if (f.dateField === 'due' && f.to) w.push(`pb.due_date <= ${p.add(f.to)}::date`)
  if (f.q) { const q = p.add(`%${f.q}%`); w.push(`(s.name ILIKE ${q} OR i.doc_number ILIKE ${q})`) }
  const { rows } = await ctx.db.query(
    `SELECT pb.id, pb.supplier_id, s.name AS supplier, s.phone, i.id AS invoice_id, i.doc_number, pb.number AS n, pb.due_date, pb.amount, pb.credited,
       COALESCE((SELECT SUM(a.amount) FROM supplier_payment_allocations a JOIN supplier_payments sp ON sp.id = a.payment_id WHERE a.payable_id = pb.id AND NOT sp.voided AND local_date(sp.at) <= $1::date), 0) AS paid,
       ($1::date - pb.due_date) AS days_late
     FROM payables pb JOIN purchase_invoices i ON i.id = pb.invoice_id JOIN suppliers s ON s.id = pb.supplier_id WHERE ${w.join(' AND ')} ORDER BY s.name, pb.due_date`, p.vals)
  const items = rows.map((r) => { const pending = Number(r.amount) - Number(r.credited) - Number(r.paid); return { ...r, amount: Number(r.amount), credited: Number(r.credited), paid: Number(r.paid), pending, days_late: Number(r.days_late), bucket: agingBucket(Number(r.days_late)), due: day(r.due_date) } }).filter((r) => r.pending > 0)
  const base = { id: 'payables', subtitle: `Deuda con proveedores al ${asOf}` }
  if (f.view === 'detail') {
    const out = items.map((r) => ({ ...r, state: r.days_late > 0 ? `Vencida ${r.days_late} días` : 'Al día', bucket_label: AGING_BUCKETS[r.bucket], link: `/purchases?tab=invoices&open=${r.invoice_id}` }))
    return { ...base, title: 'Cuentas por pagar — facturas', columns: [{ key: 'supplier', label: 'Proveedor', type: 'text' }, { key: 'doc_number', label: 'Factura', type: 'text' }, { key: 'n', label: 'Cuota', type: 'int' }, { key: 'due', label: 'Vencimiento', type: 'date' }, { key: 'amount', label: 'Importe', type: 'money' }, { key: 'credited', label: 'N. crédito', type: 'money' }, { key: 'paid', label: 'Pagado', type: 'money' }, { key: 'pending', label: 'Saldo', type: 'money' }, { key: 'days_late', label: 'Días de atraso', type: 'int' }, { key: 'bucket_label', label: 'Antigüedad', type: 'status' }],
      rows: out, totals: { supplier: `${out.length} cuotas`, ...sumBy(out, ['amount', 'credited', 'paid', 'pending']) } }
  }
  const by = new Map<number, Record<string, any>>()
  for (const r of items) {
    const row = by.get(r.supplier_id) ?? { supplier: r.supplier, phone: r.phone, b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, total: 0, overdue: 0, link: `/suppliers?open=${r.supplier_id}` }
    row[BUCKETS[r.bucket]] += r.pending; row.total += r.pending; if (r.bucket > 0) row.overdue += r.pending
    by.set(r.supplier_id, row)
  }
  const out = [...by.values()].sort((a, b) => b.total - a.total)
  return { ...base, title: 'Cuentas por pagar — antigüedad de deuda', columns: [{ key: 'supplier', label: 'Proveedor', type: 'text' }, { key: 'phone', label: 'Teléfono', type: 'text' }, ...BUCKETS.map((k, i) => ({ key: k, label: AGING_BUCKETS[i], type: 'money' as const })), { key: 'overdue', label: 'Total vencido', type: 'money' }, { key: 'total', label: 'Deuda total', type: 'money' }],
    rows: out, totals: { supplier: 'Total general', ...sumBy(out, [...BUCKETS, 'overdue', 'total']) } }
}

export async function supplierReturnsReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const p = new Params()
  const w = [`local_date(r.created_at) BETWEEN ${p.add(f.from)}::date AND ${p.add(f.to)}::date`]
  if (f.supplierId) w.push(`r.supplier_id = ${p.add(f.supplierId)}`)
  const { rows } = await ctx.db.query(
    `SELECT r.id, r.number, r.created_at, s.name AS supplier, po.number AS order_number, r.reason, r.total, r.invoiced_value, r.credited, r.credit_status
     FROM supplier_returns r JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN purchase_orders po ON po.id = r.order_id WHERE ${w.join(' AND ')} ORDER BY r.id DESC LIMIT 20000`, p.vals)
  const out = rows.map((r) => ({ ...r, credit_status: RET_STATUS[r.credit_status] ?? r.credit_status, pending_credit: Number(r.invoiced_value) - Number(r.credited) }))
  return { id: 'supplier-returns', title: 'Devoluciones a proveedores', subtitle: `Del ${f.from} al ${f.to}`, columns: [{ key: 'number', label: 'Devolución', type: 'text' }, { key: 'created_at', label: 'Fecha', type: 'datetime' }, { key: 'supplier', label: 'Proveedor', type: 'text' }, { key: 'order_number', label: 'Orden', type: 'text' }, { key: 'reason', label: 'Motivo', type: 'text' },
    { key: 'total', label: 'Valor devuelto', type: 'money', sensitive: true }, { key: 'credited', label: 'Acreditado', type: 'money', sensitive: true }, { key: 'pending_credit', label: 'Crédito pendiente', type: 'money', sensitive: true }, { key: 'credit_status', label: 'Estado', type: 'status' }],
  rows: out, totals: { number: `${out.length} devoluciones`, ...sumBy(out, ['total', 'credited', 'pending_credit']) } }
}
