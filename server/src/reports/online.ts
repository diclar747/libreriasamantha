import { Params, refLink, sumBy, type Ctx, type ReportResult } from './core.js'

const ORDER: Record<string, string> = { draft: 'Borrador', confirmed: 'Confirmado', cancelled: 'Cancelado', completed: 'Completado' }
const PAY: Record<string, string> = { pending: 'Pendiente de pago', in_review: 'En revisión', approved: 'Pago aprobado', rejected: 'Pago rechazado', refunded: 'Reembolsado', partially_refunded: 'Reembolso parcial' }
const DEL: Record<string, string> = { pending: 'Sin preparar', preparing: 'En preparación', ready: 'Listo', dispatched: 'En camino', delivered: 'Entregado', incident: 'Incidencia' }

// Pedidos de la tienda online. Pedido, pago y entrega son estados separados: un pedido recibido no es un pedido cobrado.
export async function onlineReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const p = new Params()
  const w: string[] = []
  if (f.from) w.push(`local_date(o.created_at) >= ${p.add(f.from)}::date`)
  if (f.to) w.push(`local_date(o.created_at) <= ${p.add(f.to)}::date`)
  if (f.status) w.push(`o.status = ${p.add(f.status)}`)
  if (f.collection) w.push(`o.payment_status = ${p.add(f.collection)}`)
  if (f.condition) w.push(`o.delivery_status = ${p.add(f.condition)}`)
  if (f.method) w.push(`o.delivery_method = ${p.add(f.method)}`)
  if (f.q) { const q = p.add(`%${f.q}%`); w.push(`(o.number ILIKE ${q} OR o.customer_name ILIKE ${q} OR o.phone ILIKE ${q})`) }
  const from = `FROM orders o LEFT JOIN sales s ON s.id = o.sale_id
    LEFT JOIN LATERAL (SELECT COALESCE(SUM(COALESCE(pay.settled_fee, pay.fee)), 0) AS fee FROM payments pay WHERE pay.sale_id = s.id AND pay.kind = 'sale') pf ON true
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''}`
  const base = { id: 'online', subtitle: `Del ${f.from} al ${f.to}` }
  const g = f.groupBy
  const items = `(SELECT COALESCE(SUM(oi.qty), 0) FROM order_items oi WHERE oi.order_id = o.id)`
  if (g) {
    const expr = g === 'day' ? `to_char(local_date(o.created_at), 'YYYY-MM-DD')` : g === 'month' ? `to_char(local_date(o.created_at), 'YYYY-MM')` : g === 'payment' ? 'o.payment_status'
      : g === 'delivery' ? 'o.delivery_status' : g === 'coupon' ? `COALESCE(o.coupon_code, 'Sin cupón')` : g === 'city' ? `COALESCE(o.city_name, o.delivery_method)` : 'o.status'
    const { rows } = await ctx.db.query(
      `SELECT ${expr} AS grp, COUNT(*)::int AS orders, SUM(o.subtotal)::bigint AS subtotal, SUM(o.discount)::bigint AS discount, SUM(o.delivery_fee)::bigint AS shipping, SUM(o.delivery_cost)::bigint AS delivery_cost,
         SUM(o.total)::bigint AS total, COALESCE(SUM(pf.fee), 0)::bigint AS fee ${from} GROUP BY 1 ORDER BY ${g === 'day' || g === 'month' ? '1' : 'total DESC'}`, p.vals)
    const out = rows.map((r) => ({ ...r, grp: g === 'status' ? ORDER[r.grp] ?? r.grp : g === 'payment' ? PAY[r.grp] ?? r.grp : g === 'delivery' ? DEL[r.grp] ?? r.grp : r.grp, net_received: Number(r.total) - Number(r.fee) }))
    return { ...base, title: 'Tienda online — resumen', groupBy: g, columns: [{ key: 'grp', label: 'Grupo', type: 'text' }, { key: 'orders', label: 'Pedidos', type: 'int' }, { key: 'subtotal', label: 'Productos', type: 'money' }, { key: 'discount', label: 'Descuentos / cupones', type: 'money' },
      { key: 'shipping', label: 'Envío cobrado', type: 'money' }, { key: 'delivery_cost', label: 'Costo de entrega', type: 'money' }, { key: 'total', label: 'Total', type: 'money' }, { key: 'fee', label: 'Comisión pasarela', type: 'money' }, { key: 'net_received', label: 'Neto recibido', type: 'money' }],
      rows: out, totals: { grp: 'Total general', ...sumBy(out, ['orders', 'subtotal', 'discount', 'shipping', 'delivery_cost', 'total', 'fee', 'net_received']) } }
  }
  const { rows } = await ctx.db.query(
    `SELECT o.id, o.number, o.created_at, o.customer_name, o.phone, o.delivery_method, o.city_name, ${items}::int AS units, o.subtotal, o.discount, o.coupon_code, o.delivery_fee AS shipping, o.delivery_cost, o.total,
       o.status, o.payment_status, o.delivery_status, COALESCE(pf.fee, 0) AS fee ${from} ORDER BY o.created_at DESC LIMIT 20000`, p.vals)
  const out = rows.map((r) => ({ ...r, delivery_method: r.delivery_method === 'pickup' ? 'Retiro en local' : 'Delivery', status: ORDER[r.status], payment_status: PAY[r.payment_status] ?? r.payment_status, delivery_status: DEL[r.delivery_status] ?? r.delivery_status,
    net_received: ['approved', 'partially_refunded'].includes(rows.find((x) => x.id === r.id)!.payment_status) ? Number(r.total) - Number(r.fee) : 0, link: refLink('sale', null) }))
  const kpi = (k: string, v: string) => rows.filter((r) => r[k] === v).length
  return { ...base, title: 'Tienda online — pedidos',
    columns: [{ key: 'number', label: 'Pedido', type: 'text' }, { key: 'created_at', label: 'Fecha', type: 'datetime' }, { key: 'customer_name', label: 'Cliente', type: 'text' }, { key: 'delivery_method', label: 'Entrega', type: 'text' }, { key: 'city_name', label: 'Ciudad', type: 'text' },
      { key: 'units', label: 'Unid.', type: 'int' }, { key: 'subtotal', label: 'Productos', type: 'money' }, { key: 'discount', label: 'Descuento', type: 'money' }, { key: 'coupon_code', label: 'Cupón', type: 'text' }, { key: 'shipping', label: 'Envío cobrado', type: 'money' },
      { key: 'delivery_cost', label: 'Costo de entrega', type: 'money' }, { key: 'total', label: 'Total', type: 'money' }, { key: 'status', label: 'Pedido', type: 'status' }, { key: 'payment_status', label: 'Pago', type: 'status' }, { key: 'delivery_status', label: 'Entrega', type: 'status' },
      { key: 'fee', label: 'Comisión', type: 'money' }, { key: 'net_received', label: 'Neto recibido', type: 'money' }],
    rows: out, totals: { number: `${out.length} pedidos`, ...sumBy(out, ['units', 'subtotal', 'discount', 'shipping', 'delivery_cost', 'total', 'fee', 'net_received']) },
    meta: { received: rows.length, pendingPayment: kpi('payment_status', 'pending'), inReview: kpi('payment_status', 'in_review'), paid: kpi('payment_status', 'approved'), cancelled: kpi('status', 'cancelled'),
      buyers: new Set(rows.map((r) => r.phone ?? r.customer_name)).size } }
}

// Productos y categorías vendidos por la tienda (pedidos con pago aprobado).
export async function onlineProductsReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const { rows } = await ctx.db.query(
    `SELECT COALESCE(p.category, '—') AS category, p.code, oi.name AS product, SUM(oi.qty)::int AS units, SUM(oi.qty * oi.unit_price)::bigint AS amount
     FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
     WHERE o.payment_status IN ('approved','partially_refunded') AND local_date(o.created_at) BETWEEN $1::date AND $2::date GROUP BY 1, 2, 3 ORDER BY amount DESC`, [f.from, f.to])
  return { id: 'online-products', title: 'Tienda online — productos vendidos', subtitle: `Del ${f.from} al ${f.to}`,
    columns: [{ key: 'category', label: 'Categoría', type: 'text' }, { key: 'code', label: 'Código', type: 'text' }, { key: 'product', label: 'Producto', type: 'text' }, { key: 'units', label: 'Unidades', type: 'int' }, { key: 'amount', label: 'Importe', type: 'money' }],
    rows, totals: { category: 'Total', ...sumBy(rows, ['units', 'amount']) } }
}
