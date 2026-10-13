import { Params, sumBy, type Ctx, type ReportResult } from './core.js'

const MOVE: Record<string, string> = {
  opening: 'Stock inicial', sale: 'Venta', void: 'Anulación de venta', return: 'Devolución de cliente', purchase: 'Compra / recepción', supplier_return: 'Devolución a proveedor',
  adjustment: 'Ajuste', count: 'Conteo físico', online_sale: 'Venta online', transfer: 'Transferencia',
}

// Inventario valorizado al costo y al precio de venta.
export async function inventoryReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const p = new Params()
  const w = [`p.kind = 'product'`, f.status === 'inactive' ? 'NOT p.active' : f.status === 'all' ? 'true' : 'p.active']
  if (f.category) w.push(`p.category = ${p.add(f.category)}`)
  if (f.brand) w.push(`p.brand = ${p.add(f.brand)}`)
  if (f.supplierId) w.push(`EXISTS (SELECT 1 FROM product_suppliers ps WHERE ps.product_id = p.id AND ps.supplier_id = ${p.add(f.supplierId)})`)
  if (f.condition === 'low') w.push('p.min_stock > 0 AND p.stock - p.reserved <= p.min_stock AND p.stock - p.reserved > 0')
  if (f.condition === 'out') w.push('p.stock - p.reserved <= 0')
  if (f.q) { const q = p.add(`%${f.q}%`); w.push(`(p.name ILIKE ${q} OR p.code ILIKE ${q} OR p.barcode ILIKE ${q})`) }
  const net = `CASE WHEN p.cost_includes_vat THEN p.cost - ROUND(p.cost::numeric * p.tax_rate / (100 + p.tax_rate)) ELSE p.cost END`
  const { rows } = await ctx.db.query(
    `SELECT p.id, p.code, p.name, p.category, p.brand, p.stock, p.reserved, (p.stock - p.reserved) AS available, p.min_stock, (${net})::bigint AS cost, p.price,
       ((${net}) * p.stock)::bigint AS cost_value, (p.price * p.stock)::bigint AS price_value,
       CASE WHEN p.price > 0 THEN ROUND(((p.price - ROUND(p.price::numeric * p.tax_rate / (100 + p.tax_rate)) - (${net}))::numeric / NULLIF(p.price - ROUND(p.price::numeric * p.tax_rate / (100 + p.tax_rate)), 0)) * 100, 1) END AS margin
     FROM products p WHERE ${w.join(' AND ')} ORDER BY ${f.groupBy ? 'p.category,' : ''} p.name LIMIT 20000`, p.vals)
  const base = { id: 'inventory', subtitle: 'Existencias actuales' }
  if (f.groupBy === 'category' || f.groupBy === 'brand') {
    const key = f.groupBy
    const by = new Map<string, any>()
    for (const r of rows) { const k = r[key] ?? 'Sin ' + (key === 'brand' ? 'marca' : 'categoría'); const g = by.get(k) ?? { grp: k, products: 0, stock: 0, cost_value: 0, price_value: 0 }; g.products++; g.stock += r.stock; g.cost_value += Number(r.cost_value); g.price_value += Number(r.price_value); by.set(k, g) }
    const out = [...by.values()].sort((a, b) => b.cost_value - a.cost_value)
    return { ...base, title: 'Inventario valorizado — resumen', groupBy: key, columns: [{ key: 'grp', label: 'Grupo', type: 'text' }, { key: 'products', label: 'Productos', type: 'int' }, { key: 'stock', label: 'Unidades', type: 'int' }, { key: 'cost_value', label: 'Valor al costo', type: 'money', sensitive: true }, { key: 'price_value', label: 'Valor a precio de venta', type: 'money' }],
      rows: out, totals: { grp: 'Total general', ...sumBy(out, ['products', 'stock', 'cost_value', 'price_value']) } }
  }
  return { ...base, title: 'Inventario valorizado', columns: [{ key: 'code', label: 'Código', type: 'text' }, { key: 'name', label: 'Producto', type: 'text' }, { key: 'category', label: 'Categoría', type: 'text' }, { key: 'stock', label: 'Stock', type: 'int' }, { key: 'reserved', label: 'Reservado', type: 'int' }, { key: 'min_stock', label: 'Mínimo', type: 'int' },
    { key: 'cost', label: 'Costo unit.', type: 'money', sensitive: true }, { key: 'price', label: 'Precio', type: 'money' }, { key: 'margin', label: 'Margen %', type: 'percent', sensitive: true }, { key: 'cost_value', label: 'Valor al costo', type: 'money', sensitive: true }, { key: 'price_value', label: 'Valor de venta', type: 'money' }],
  rows: rows.map((r) => ({ ...r, link: `/products?open=${r.id}` })), totals: { code: `${rows.length} productos`, ...sumBy(rows, ['stock', 'reserved', 'cost_value', 'price_value']) } }
}

// Productos en o bajo el mínimo, con lo que ya está pedido y la reposición sugerida.
export async function lowStockReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const p = new Params()
  const w = [`p.kind = 'product'`, 'p.active', `p.min_stock > 0`, `p.stock - p.reserved <= p.min_stock`]
  if (f.category) w.push(`p.category = ${p.add(f.category)}`)
  if (f.supplierId) w.push(`EXISTS (SELECT 1 FROM product_suppliers ps WHERE ps.product_id = p.id AND ps.supplier_id = ${p.add(f.supplierId)})`)
  const { rows } = await ctx.db.query(
    `SELECT p.id, p.code, p.name, p.category, p.stock, p.reserved, (p.stock - p.reserved) AS available, p.min_stock,
       COALESCE((SELECT SUM((pi.qty_ordered - pi.qty_received) * pi.units_per_presentation) FROM purchase_items pi JOIN purchase_orders po ON po.id = pi.order_id WHERE pi.product_id = p.id AND po.status IN ('issued','partial')), 0)::int AS pending_in,
       (SELECT s.name FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id WHERE ps.product_id = p.id ORDER BY ps.preferred DESC, ps.last_cost NULLS LAST LIMIT 1) AS supplier
     FROM products p WHERE ${w.join(' AND ')} ORDER BY (p.stock - p.reserved), p.name`, p.vals)
  const out = rows.map((r) => ({ ...r, state: Number(r.available) <= 0 ? 'Agotado' : 'Stock bajo', suggested: Math.max(r.min_stock * 2 - Number(r.available) - r.pending_in, 0), link: `/products?open=${r.id}` }))
  return { id: 'low-stock', title: 'Stock bajo y agotados', subtitle: 'Productos en o por debajo del mínimo', columns: [{ key: 'code', label: 'Código', type: 'text' }, { key: 'name', label: 'Producto', type: 'text' }, { key: 'category', label: 'Categoría', type: 'text' }, { key: 'available', label: 'Disponible', type: 'int' }, { key: 'min_stock', label: 'Mínimo', type: 'int' },
    { key: 'pending_in', label: 'Pedido sin recibir', type: 'int' }, { key: 'suggested', label: 'Reposición sugerida', type: 'int' }, { key: 'supplier', label: 'Proveedor habitual', type: 'text' }, { key: 'state', label: 'Estado', type: 'status' }],
  rows: out, totals: { code: `${out.length} productos`, ...sumBy(out, ['pending_in', 'suggested']) } }
}

// Historial de movimientos de stock con el saldo antes y después, el documento y el usuario.
export async function stockMovementsReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const p = new Params()
  const w = [`local_date(m.at) BETWEEN ${p.add(f.from)}::date AND ${p.add(f.to)}::date`]
  if (f.productId) w.push(`m.product_id = ${p.add(f.productId)}`)
  if (f.category) w.push(`pr.category = ${p.add(f.category)}`)
  if (f.method) w.push(`m.type = ${p.add(f.method)}`)
  if (f.userId) w.push(`m.user_id = ${p.add(f.userId)}`)
  if (f.q) { const q = p.add(`%${f.q}%`); w.push(`(pr.name ILIKE ${q} OR pr.code ILIKE ${q} OR m.reason ILIKE ${q})`) }
  const { rows } = await ctx.db.query(
    `SELECT m.id, m.at, pr.code, pr.name, m.type, m.qty, m.stock_before, m.stock_after, m.unit_cost, m.ref_type, m.ref_id, m.reason, u.name AS user_name
     FROM stock_movements m JOIN products pr ON pr.id = m.product_id LEFT JOIN users u ON u.id = m.user_id WHERE ${w.join(' AND ')} ORDER BY m.at DESC, m.id DESC LIMIT 20000`, p.vals)
  const out = rows.map((r) => ({ ...r, type: MOVE[r.type] ?? r.type, inbound: r.qty > 0 ? r.qty : 0, outbound: r.qty < 0 ? -r.qty : 0, doc: r.ref_type ? `${r.ref_type} #${r.ref_id}` : '' }))
  return { id: 'stock-movements', title: 'Movimientos de stock', subtitle: `Del ${f.from} al ${f.to}`, columns: [{ key: 'at', label: 'Fecha', type: 'datetime' }, { key: 'code', label: 'Código', type: 'text' }, { key: 'name', label: 'Producto', type: 'text' }, { key: 'type', label: 'Tipo', type: 'text' }, { key: 'inbound', label: 'Entrada', type: 'int' }, { key: 'outbound', label: 'Salida', type: 'int' },
    { key: 'stock_before', label: 'Stock antes', type: 'int' }, { key: 'stock_after', label: 'Stock después', type: 'int' }, { key: 'unit_cost', label: 'Costo unit.', type: 'money', sensitive: true }, { key: 'doc', label: 'Documento', type: 'text' }, { key: 'reason', label: 'Motivo', type: 'text' }, { key: 'user_name', label: 'Usuario', type: 'text' }],
  rows: out, totals: { at: `${out.length} movimientos`, ...sumBy(out, ['inbound', 'outbound']) } }
}

export async function priceChangesReport(ctx: Ctx): Promise<ReportResult> {
  const f = ctx.filters
  const p = new Params()
  const w = [`local_date(h.at) BETWEEN ${p.add(f.from)}::date AND ${p.add(f.to)}::date`]
  if (f.productId) w.push(`h.product_id = ${p.add(f.productId)}`)
  if (f.category) w.push(`pr.category = ${p.add(f.category)}`)
  if (f.q) { const q = p.add(`%${f.q}%`); w.push(`(pr.name ILIKE ${q} OR pr.code ILIKE ${q})`) }
  const { rows } = await ctx.db.query(
    `SELECT h.id, h.at, pr.code, pr.name, h.field, h.old_value, h.new_value, (h.new_value - COALESCE(h.old_value, 0)) AS diff, u.name AS user_name
     FROM price_history h JOIN products pr ON pr.id = h.product_id LEFT JOIN users u ON u.id = h.user_id WHERE ${w.join(' AND ')} ORDER BY h.at DESC, h.id DESC LIMIT 20000`, p.vals)
  const LBL: Record<string, string> = { cost: 'Costo', price: 'Precio de venta', wholesale_price: 'Precio mayorista' }
  return { id: 'price-changes', title: 'Cambios de precio y costo', subtitle: `Del ${f.from} al ${f.to}`, columns: [{ key: 'at', label: 'Fecha', type: 'datetime' }, { key: 'code', label: 'Código', type: 'text' }, { key: 'name', label: 'Producto', type: 'text' }, { key: 'field', label: 'Dato', type: 'text' }, { key: 'old_value', label: 'Antes', type: 'money' }, { key: 'new_value', label: 'Después', type: 'money' }, { key: 'diff', label: 'Diferencia', type: 'money' }, { key: 'user_name', label: 'Usuario', type: 'text' }],
    rows: rows.map((r) => ({ ...r, field: LBL[r.field] ?? r.field })), totals: { at: `${rows.length} cambios` } }
}
