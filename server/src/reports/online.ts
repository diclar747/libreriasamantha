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

const PAY_METHOD: Record<string, string> = { bancard: 'Tarjeta en línea', transfer: 'Transferencia', cod: 'Contra entrega' }

// Una fila por pedido con TODOS los datos del cliente y de la entrega: sirve para imprimir listas de reparto o exportar a Excel.
export async function onlineShippingReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const p = new Params()
  const w: string[] = [`local_date(o.created_at) BETWEEN ${p.add(f.from)}::date AND ${p.add(f.to)}::date`]
  if (f.status) w.push(`o.status = ${p.add(f.status)}`)
  if (f.collection) w.push(`o.payment_status = ${p.add(f.collection)}`)
  if (f.condition) w.push(`o.delivery_status = ${p.add(f.condition)}`)
  if (f.method) w.push(`o.delivery_method = ${p.add(f.method)}`)
  if (f.q) { const q = p.add(`%${f.q}%`); w.push(`(o.number ILIKE ${q} OR o.customer_name ILIKE ${q} OR o.phone ILIKE ${q} OR o.ruc ILIKE ${q} OR o.billing_ruc ILIKE ${q} OR o.city_name ILIKE ${q} OR o.address ILIKE ${q})`) }
  const { rows } = await ctx.db.query(
    `SELECT o.id, o.number, o.created_at, o.customer_name, o.phone, o.email, COALESCE(o.billing_ruc, o.ruc) AS doc, COALESCE(o.billing_name, o.customer_name) AS billing_name,
       o.delivery_method, o.address, o.neighborhood, o.department, o.city_name, o.address_reference, o.recipient_name, o.recipient_phone, o.customer_note,
       (SELECT string_agg(oi.qty || ' × ' || oi.name, '; ' ORDER BY oi.id) FROM order_items oi WHERE oi.order_id = o.id) AS products,
       (SELECT COALESCE(SUM(oi.qty), 0)::int FROM order_items oi WHERE oi.order_id = o.id) AS units,
       o.delivery_fee, o.total, o.payment_method, o.payment_status, o.delivery_status, o.status
     FROM orders o WHERE ${w.join(' AND ')} ORDER BY o.created_at DESC LIMIT 20000`, p.vals)
  const join = (...x: unknown[]) => x.filter((v) => v !== null && v !== undefined && String(v).trim() !== '').join(', ')
  const out = rows.map((r) => ({ ...r, delivery_method: r.delivery_method === 'pickup' ? 'Retiro en local' : 'Delivery',
    place: join(r.city_name, r.department && r.department !== r.city_name ? r.department : null),
    full_address: r.delivery_method === 'pickup' ? '' : join(r.address, r.neighborhood, r.address_reference && 'Ref.: ' + r.address_reference),
    pay: `${PAY_METHOD[r.payment_method] ?? r.payment_method} · ${PAY[r.payment_status] ?? r.payment_status}`,
    delivery_status: r.status === 'cancelled' ? 'Cancelado' : DEL[r.delivery_status] ?? r.delivery_status,
    recipient: r.recipient_name ? `${r.recipient_name}${r.recipient_phone ? ' · ' + r.recipient_phone : ''}` : '' }))
  return { id: 'online-shipping', title: 'Pedidos en línea — datos del cliente y envío', subtitle: `Del ${f.from} al ${f.to}`,
    columns: [{ key: 'number', label: 'Pedido', type: 'text' }, { key: 'created_at', label: 'Fecha', type: 'datetime' }, { key: 'customer_name', label: 'Cliente', type: 'text' }, { key: 'phone', label: 'Teléfono', type: 'text' }, { key: 'email', label: 'Correo', type: 'text' },
      { key: 'doc', label: 'RUC / CI', type: 'text' }, { key: 'billing_name', label: 'Facturar a', type: 'text' }, { key: 'delivery_method', label: 'Entrega', type: 'text' }, { key: 'place', label: 'Ciudad', type: 'text' },
      { key: 'full_address', label: 'Dirección', type: 'text' }, { key: 'recipient', label: 'Recibe', type: 'text' }, { key: 'products', label: 'Productos', type: 'text' }, { key: 'units', label: 'Unid.', type: 'int' },
      { key: 'delivery_fee', label: 'Delivery', type: 'money' }, { key: 'total', label: 'Total', type: 'money' }, { key: 'pay', label: 'Pago', type: 'text' }, { key: 'delivery_status', label: 'Estado', type: 'text' }, { key: 'customer_note', label: 'Nota del cliente', type: 'text' }],
    rows: out, totals: { number: `${out.length} pedidos`, ...sumBy(out, ['units', 'delivery_fee', 'total']) } }
}

// Delivery cobrado y no cobrado (promociones) por ciudad, departamento o período, con la tarifa que se aplicó en cada pedido.
export async function deliveryReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const g = f.groupBy ?? 'city'
  const expr = g === 'department' ? `COALESCE(o.department, '—')` : g === 'day' ? `to_char(local_date(o.created_at), 'YYYY-MM-DD')` : g === 'month' ? `to_char(local_date(o.created_at), 'YYYY-MM')` : `COALESCE(o.city_name, '—')`
  const { rows } = await ctx.db.query(
    `SELECT ${expr} AS grp, ${g === 'city' ? `COALESCE(o.department, '—')` : `''`} AS department, COUNT(*)::int AS orders, COALESCE(SUM(o.delivery_fee), 0)::bigint AS charged,
       COALESCE(SUM(COALESCE(o.delivery_base_fee, o.delivery_fee)), 0)::bigint AS base_total, COUNT(*) FILTER (WHERE o.delivery_fee = 0)::int AS free_orders,
       COALESCE(SUM(COALESCE(o.delivery_base_fee, o.delivery_fee) - o.delivery_fee), 0)::bigint AS forgone, COALESCE(SUM(o.subtotal), 0)::bigint AS products, COALESCE(SUM(o.total), 0)::bigint AS total
     FROM orders o WHERE o.delivery_method = 'delivery' AND o.status <> 'cancelled' AND local_date(o.created_at) BETWEEN $1::date AND $2::date
     GROUP BY 1, 2 ORDER BY ${g === 'day' || g === 'month' ? '1' : 'orders DESC, 1'}`, [f.from, f.to])
  const cols: any[] = [{ key: 'grp', label: g === 'department' ? 'Departamento' : g === 'day' ? 'Día' : g === 'month' ? 'Mes' : 'Ciudad', type: 'text' }]
  if (g === 'city') cols.push({ key: 'department', label: 'Departamento', type: 'text' })
  cols.push({ key: 'orders', label: 'Pedidos', type: 'int' }, { key: 'products', label: 'Productos', type: 'money' }, { key: 'charged', label: 'Delivery cobrado', type: 'money' }, { key: 'free_orders', label: 'Con delivery gratis', type: 'int' },
    { key: 'forgone', label: 'No cobrado por promoción', type: 'money' }, { key: 'total', label: 'Total vendido', type: 'money' })
  return { id: 'delivery', title: 'Delivery por ciudad', subtitle: `Del ${f.from} al ${f.to}`, groupBy: g, columns: cols, rows, totals: { grp: 'Total', ...sumBy(rows, ['orders', 'products', 'charged', 'free_orders', 'forgone', 'total']) } }
}
