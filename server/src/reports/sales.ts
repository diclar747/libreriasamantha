import { CHANNEL_LABEL, COLLECTION_LABEL, STATE_LABEL, Params, pct, refLink, sumBy, type Column, type Ctx, type Filters, type ReportResult } from './core.js'
import { METHOD_LABEL } from '../finance.js'

// Una fila por línea de venta, con todas las dimensiones para filtrar y agrupar.
// El descuento global se reparte entre las líneas con redondeo acumulado: la suma de las líneas es exactamente el total de la venta.
export function salesItemsSql(f: Filters, p: Params) {
  const w: string[] = []
  const add = (sql: string, v: unknown) => w.push(sql.split('$#').join(p.add(v)))
  if (f.from) add('it.day >= $#::date', f.from)
  if (f.to) add('it.day <= $#::date', f.to)
  if (f.channel) add('it.channel = $#', f.channel)
  if (f.sellerId) add('it.seller_id = $#', f.sellerId)
  if (f.customerId) add('it.customer_id = $#', f.customerId)
  if (f.sessionId) add('it.session_id = $#', f.sessionId)
  if (f.productId) add('it.product_id = $#', f.productId)
  if (f.category) add('it.category ILIKE $#', f.category)
  if (f.brand) add('it.brand ILIKE $#', f.brand)
  if (f.condition) add('it.condition = $#', f.condition)
  if (f.collection) add('it.collection = $#', f.collection)
  if (f.method) add('it.methods LIKE $#', `%${f.method}%`)
  if (f.q) add('(it.number ILIKE $# OR it.customer ILIKE $# OR it.product ILIKE $# OR it.code ILIKE $#)', `%${f.q}%`)
  if (f.state && f.state !== 'active' && f.state !== 'all') add('it.state = $#', f.state)
  else if (f.state !== 'all') w.push(`it.state <> 'void'`) // por defecto, las anuladas no suman
  const sql = `
  WITH sb AS (
    SELECT s.id, s.number, s.created_at, local_date(s.created_at) AS day, s.channel, s.user_id AS seller_id, u.name AS seller,
      s.customer_id, COALESCE(c.name, 'Consumidor final') AS customer, s.session_id, s.status, s.subtotal, s.total, s.returned_total, s.credit_amount,
      CASE WHEN s.credit_amount > 0 THEN 'credit' ELSE 'cash' END AS condition,
      CASE WHEN s.status = 'void' THEN 'void' WHEN s.returned_total = 0 THEN 'valid' WHEN s.returned_total >= s.total THEN 'returned' ELSE 'partial_return' END AS state,
      COALESCE((SELECT SUM(x.amount) FROM payments x WHERE x.sale_id = s.id AND x.kind = 'sale' AND x.settlement_status <> 'rejected'), 0) AS pay_in,
      COALESCE((SELECT -SUM(x.amount) FROM payments x WHERE x.sale_id = s.id AND x.kind IN ('refund','return')), 0) AS pay_back,
      COALESCE((SELECT SUM(i.paid) FROM installments i WHERE i.sale_id = s.id), 0) AS inst_paid,
      (SELECT string_agg(DISTINCT x.method, ',' ORDER BY x.method) FROM payments x WHERE x.sale_id = s.id AND x.kind = 'sale' AND x.method <> 'advance') AS methods
    FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN customers c ON c.id = s.customer_id
  ), it AS (
    SELECT sb.*, si.id AS item_id, si.product_id, si.name AS product, si.qty, si.unit_price, si.unit_cost, si.tax_rate, p.code, p.category, p.brand,
      si.qty * si.unit_price AS gross,
      ROUND(SUM(si.total) OVER (PARTITION BY sb.id ORDER BY si.id) * sb.total::numeric / NULLIF(sb.subtotal, 0))
        - COALESCE(ROUND(SUM(si.total) OVER (PARTITION BY sb.id ORDER BY si.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) * sb.total::numeric / NULLIF(sb.subtotal, 0)), 0) AS alloc,
      COALESCE((SELECT SUM(ri.amount) FROM sale_return_items ri WHERE ri.sale_item_id = si.id), 0) AS returned_amt,
      COALESCE((SELECT SUM(ri.qty) FROM sale_return_items ri WHERE ri.sale_item_id = si.id), 0) AS returned_qty,
      COALESCE((SELECT SUM(ri.qty) FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id WHERE ri.sale_item_id = si.id AND r.restock), 0) AS restocked_qty,
      CASE WHEN sb.methods IS NULL THEN CASE WHEN sb.credit_amount > 0 THEN 'credit' ELSE 'none' END WHEN position(',' in sb.methods) > 0 THEN 'mixed' ELSE sb.methods END AS pay_label,
      CASE WHEN sb.state = 'void' THEN 'void'
           WHEN sb.pay_in - sb.pay_back + sb.inst_paid >= sb.total - sb.returned_total THEN 'paid'
           WHEN sb.pay_in - sb.pay_back + sb.inst_paid <= 0 THEN 'pending' ELSE 'partial' END AS collection
    FROM sb JOIN sale_items si ON si.sale_id = sb.id JOIN products p ON p.id = si.product_id
  ), m AS (
    SELECT it.*, COALESCE(it.alloc, 0) AS alloc_n, COALESCE(it.alloc, 0) - it.returned_amt AS net,
      (COALESCE(it.alloc, 0) - it.returned_amt) - CASE it.tax_rate WHEN 10 THEN ROUND((COALESCE(it.alloc, 0) - it.returned_amt) / 11.0) WHEN 5 THEN ROUND((COALESCE(it.alloc, 0) - it.returned_amt) / 21.0) ELSE 0 END AS net_ex_vat,
      (it.qty - it.restocked_qty) * it.unit_cost AS cost
    FROM it
  )`
  return { sql, where: w.length ? 'WHERE ' + w.join(' AND ').replace(/\bit\./g, 'm.') : '' }
}

const MONEY = ['gross', 'discount', 'returns', 'net', 'net_ex_vat', 'cost', 'margin']
const AGG = `SUM(m.gross)::bigint AS gross, SUM(m.gross - m.alloc_n)::bigint AS discount, SUM(m.returned_amt)::bigint AS returns, SUM(m.net)::bigint AS net,
  SUM(m.net_ex_vat)::bigint AS net_ex_vat, SUM(m.cost)::bigint AS cost, SUM(m.net_ex_vat - m.cost)::bigint AS margin, SUM(m.qty - m.returned_qty)::int AS units`

const GROUPS: Record<string, { label: string; expr: string; order: string }> = {
  day: { label: 'Día', expr: `to_char(m.day, 'YYYY-MM-DD')`, order: 'grp' },
  week: { label: 'Semana', expr: `to_char(date_trunc('week', m.day), 'YYYY-MM-DD')`, order: 'grp' },
  month: { label: 'Mes', expr: `to_char(m.day, 'YYYY-MM')`, order: 'grp' },
  category: { label: 'Categoría', expr: `COALESCE(m.category, 'Sin categoría')`, order: 'net DESC' },
  seller: { label: 'Vendedor', expr: 'm.seller', order: 'net DESC' },
  channel: { label: 'Canal', expr: 'm.channel', order: 'net DESC' },
  method: { label: 'Medio de pago', expr: 'm.pay_label', order: 'net DESC' },
  customer: { label: 'Cliente', expr: 'm.customer', order: 'net DESC' },
  product: { label: 'Producto', expr: `m.code || ' · ' || m.product`, order: 'net DESC' },
  session: { label: 'Caja / turno', expr: `CASE WHEN m.session_id IS NULL THEN 'Sin turno' ELSE 'Turno #' || m.session_id END`, order: 'grp' },
  brand: { label: 'Marca', expr: `COALESCE(m.brand, 'Sin marca')`, order: 'net DESC' },
}
export const SALES_GROUPS = Object.fromEntries(Object.entries(GROUPS).map(([k, v]) => [k, v.label]))

const groupLabel = (g: string, v: string) =>
  g === 'channel' ? CHANNEL_LABEL[v] ?? v : g === 'method' ? ({ credit: 'Crédito', mixed: 'Pago combinado', none: 'Sin cobro' } as Record<string, string>)[v] ?? METHOD_LABEL[v] ?? v
  : g === 'week' ? `Semana del ${v}` : v

const moneyCols = (extra: Column[] = []): Column[] => [
  { key: 'gross', label: 'Venta bruta', type: 'money' }, { key: 'discount', label: 'Descuentos', type: 'money' }, { key: 'returns', label: 'Devoluciones', type: 'money' },
  { key: 'net', label: 'Venta neta (IVA incl.)', type: 'money' }, { key: 'net_ex_vat', label: 'Venta neta sin IVA', type: 'money' },
  { key: 'cost', label: 'Costo', type: 'money', sensitive: true }, { key: 'margin', label: 'Margen', type: 'money', sensitive: true },
  { key: 'margin_pct', label: 'Margen %', type: 'percent', sensitive: true }, ...extra,
]

// Ventas por comprobante (resumen), por artículo (detalle) o agrupadas por cualquier dimensión.
export async function salesReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const p = new Params()
  const { sql, where } = salesItemsSql(f, p)
  const view = f.view === 'detail' ? 'detail' : 'summary'
  const g = f.groupBy && GROUPS[f.groupBy] ? f.groupBy : undefined
  const base = { id: 'sales', subtitle: `Del ${f.from} al ${f.to}` }

  if (g) {
    const { rows } = await ctx.db.query(
      `${sql} SELECT ${GROUPS[g].expr} AS grp, COUNT(DISTINCT m.id)::int AS sales, ${AGG} FROM m ${where} GROUP BY 1 ORDER BY ${GROUPS[g].order}`, p.vals)
    const out = rows.map((r) => ({ ...r, grp: groupLabel(g, r.grp), margin_pct: pct(Number(r.margin), Number(r.net_ex_vat)) }))
    const totals = totalize(out, rows.length ? undefined : undefined)
    return { ...base, title: `Ventas por ${GROUPS[g].label.toLowerCase()}`, groupBy: g,
      columns: [{ key: 'grp', label: GROUPS[g].label, type: 'text' }, { key: 'sales', label: 'Ventas', type: 'int' }, { key: 'units', label: 'Unidades', type: 'int' }, ...moneyCols()],
      rows: out, totals: { ...totals, grp: 'Total general', sales: await distinctSales(ctx, sql, where, p) } }
  }

  if (view === 'detail') {
    const { rows } = await ctx.db.query(
      `${sql} SELECT m.number, m.id AS sale_id, m.created_at AS at, m.channel, m.customer, m.seller, m.code, m.product, m.category, m.qty - m.returned_qty AS units, m.unit_price,
         m.gross::bigint AS gross, (m.gross - m.alloc_n)::bigint AS discount, m.returned_amt::bigint AS returns, m.net::bigint AS net, m.net_ex_vat::bigint AS net_ex_vat,
         m.cost::bigint AS cost, (m.net_ex_vat - m.cost)::bigint AS margin, m.state, m.collection
       FROM m ${where} ORDER BY m.created_at DESC, m.item_id LIMIT 20000`, p.vals)
    const out = rows.map((r) => ({ ...r, channel: CHANNEL_LABEL[r.channel] ?? r.channel, state: STATE_LABEL[r.state], collection: COLLECTION_LABEL[r.collection] ?? '—',
      margin_pct: pct(Number(r.margin), Number(r.net_ex_vat)), link: refLink('sale', r.sale_id) }))
    return { ...base, title: 'Ventas — detalle por artículo',
      columns: [{ key: 'number', label: 'Comprobante', type: 'text' }, { key: 'at', label: 'Fecha', type: 'datetime' }, { key: 'channel', label: 'Canal', type: 'text' },
        { key: 'customer', label: 'Cliente', type: 'text' }, { key: 'seller', label: 'Vendedor', type: 'text' }, { key: 'code', label: 'Código', type: 'text' },
        { key: 'product', label: 'Producto', type: 'text' }, { key: 'category', label: 'Categoría', type: 'text' }, { key: 'units', label: 'Cant.', type: 'int' },
        { key: 'unit_price', label: 'Precio', type: 'money' }, ...moneyCols([{ key: 'state', label: 'Estado', type: 'status' }])],
      rows: out, totals: { ...totalize(out), number: 'Total general', units: out.reduce((a, r) => a + Number(r.units), 0) } }
  }

  const { rows } = await ctx.db.query(
    `${sql} SELECT m.id AS sale_id, m.number, m.created_at AS at, m.channel, m.customer, m.seller, m.session_id, m.condition, m.state, m.collection, m.methods,
       SUM(m.qty - m.returned_qty)::int AS units, SUM(m.gross)::bigint AS gross, SUM(m.gross - m.alloc_n)::bigint AS discount, SUM(m.returned_amt)::bigint AS returns,
       SUM(m.net)::bigint AS net, SUM(m.net_ex_vat)::bigint AS net_ex_vat, SUM(m.cost)::bigint AS cost, SUM(m.net_ex_vat - m.cost)::bigint AS margin,
       MAX(m.pay_in - m.pay_back + m.inst_paid)::bigint AS collected, GREATEST(MAX(m.total - m.returned_total) - MAX(m.pay_in - m.pay_back + m.inst_paid), 0)::bigint AS balance
     FROM m ${where} GROUP BY m.id, m.number, m.created_at, m.channel, m.customer, m.seller, m.session_id, m.condition, m.state, m.collection, m.methods
     ORDER BY m.created_at DESC LIMIT 20000`, p.vals)
  const out = rows.map((r) => ({
    ...r, channel: CHANNEL_LABEL[r.channel] ?? r.channel, condition: r.condition === 'credit' ? 'Crédito' : 'Contado', state: STATE_LABEL[r.state], collection: COLLECTION_LABEL[r.collection] ?? '—',
    methods: (r.methods ?? '').split(',').filter(Boolean).map((m: string) => METHOD_LABEL[m] ?? m).join(' + ') || (r.condition === 'credit' ? 'A crédito' : '—'),
    session: r.session_id ? `#${r.session_id}` : '—', margin_pct: pct(Number(r.margin), Number(r.net_ex_vat)), link: refLink('sale', r.sale_id),
  }))
  return { ...base, title: 'Ventas — resumen por comprobante',
    columns: [{ key: 'number', label: 'Comprobante', type: 'text' }, { key: 'at', label: 'Fecha', type: 'datetime' }, { key: 'channel', label: 'Canal', type: 'text' },
      { key: 'customer', label: 'Cliente', type: 'text' }, { key: 'seller', label: 'Vendedor', type: 'text' }, { key: 'session', label: 'Turno', type: 'text' },
      { key: 'condition', label: 'Condición', type: 'text' }, { key: 'methods', label: 'Medios de pago', type: 'text' }, { key: 'units', label: 'Unid.', type: 'int' },
      ...moneyCols([{ key: 'collected', label: 'Cobrado', type: 'money' }, { key: 'balance', label: 'Saldo', type: 'money' }, { key: 'collection', label: 'Cobro', type: 'status' }, { key: 'state', label: 'Estado', type: 'status' }])],
    rows: out, totals: { ...totalize(out), number: `${out.length} ventas`, units: out.reduce((a, r) => a + Number(r.units), 0), collected: out.reduce((a, r) => a + Number(r.collected), 0), balance: out.reduce((a, r) => a + Number(r.balance), 0) } }
}

function totalize(rows: Record<string, any>[], _?: unknown) {
  const t: Record<string, any> = sumBy(rows, MONEY.filter((k) => k !== 'margin_pct'))
  t.margin_pct = pct(Number(t.margin), Number(t.net_ex_vat))
  t.units = rows.reduce((a, r) => a + Number(r.units ?? 0), 0)
  return t
}

async function distinctSales(ctx: Ctx, sql: string, where: string, p: Params) {
  const { rows } = await ctx.db.query(`${sql} SELECT COUNT(DISTINCT m.id)::int AS n FROM m ${where}`, p.vals)
  return rows[0].n as number
}

// Totales de ventas para el dashboard: las mismas cifras que el reporte, sin traer filas.
export async function salesTotals(ctx: Ctx) {
  const p = new Params()
  const { sql, where } = salesItemsSql(ctx.filters, p)
  const { rows } = await ctx.db.query(`${sql} SELECT COUNT(DISTINCT m.id)::int AS sales, COALESCE(${AGG}, 0) FROM m ${where}`.replace('COALESCE(' + AGG + ', 0)', AGG), p.vals)
  const r = rows[0]
  const n = (k: string) => Number(r[k] ?? 0)
  return { sales: n('sales'), units: n('units'), gross: n('gross'), discount: n('discount'), returns: n('returns'), net: n('net'), net_ex_vat: n('net_ex_vat'), cost: n('cost'), margin: n('margin'),
    avg_ticket: n('sales') ? Math.round(n('net') / n('sales')) : 0 }
}
