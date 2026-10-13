// Servicio de compras: órdenes → recepciones → facturas → cuentas por pagar → pagos, devoluciones y notas de crédito.
// Diseño contable: la recepción acredita 2.1.05 (mercadería recibida pendiente de facturar); la factura la cancela y genera la deuda.
import { HttpError, type Tx } from './db/client.js'
import { ACC, post, reverse } from './accounting.js'
import { defaultAccount, sessionCash } from './finance.js'
import { checkReplenishment } from './services.js'
import { moveStock } from './stock.js'
import { markupOf, netCost, priceFromMarkup, vatOf } from './pricing.js'

export const GRNI = '2.1.05'
export const SUPPLIER_RECEIVABLE = '1.1.09'

const today = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
export const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
export const dstr = (v: unknown) => (v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10))

export async function audit(tx: Tx, userId: number, action: string, entity: string, id: number, detail: unknown = {}) {
  await tx.query('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)', [userId, action, entity, id, JSON.stringify(detail)])
}

export const pad = (prefix: string, n: number | string) => `${prefix}-${String(n).padStart(6, '0')}`

// ---------------------------------------------------------------- Importes de una línea
export interface LineIn { qty: number; unitCost: number; discount?: number; taxRate: number; includesVat?: boolean }
export function lineAmounts(l: LineIn) {
  const gross = l.qty * l.unitCost - (l.discount ?? 0)
  if (gross < 0) throw new HttpError(400, 'El descuento supera el importe de la línea')
  if (l.includesVat) { const tax = vatOf(gross, l.taxRate); return { net: gross - tax, tax, total: gross } }
  const tax = Math.round((gross * l.taxRate) / 100)
  return { net: gross, tax, total: gross + tax }
}

// ---------------------------------------------------------------- Saldos
export async function refreshInvoice(tx: Tx, invoiceId: number) {
  const { rows } = await tx.query(
    `UPDATE purchase_invoices i SET paid = x.paid, credited = x.credited,
       status = CASE WHEN i.status = 'void' THEN 'void' WHEN x.paid + x.credited >= i.total THEN 'paid' ELSE 'open' END
     FROM (SELECT COALESCE(SUM(paid), 0) AS paid, COALESCE(SUM(credited), 0) AS credited FROM payables WHERE invoice_id = $1 AND status = 'open') x
     WHERE i.id = $1 RETURNING i.*`, [invoiceId])
  return rows[0]
}

// El saldo del proveedor = lo que se le debe − su saldo a favor.
export async function refreshSupplier(tx: Tx, supplierId: number) {
  const { rows } = await tx.query(
    `UPDATE suppliers s SET balance = COALESCE((SELECT SUM(amount - paid - credited) FROM payables WHERE supplier_id = s.id AND status = 'open'), 0) - s.credit_balance
     WHERE s.id = $1 RETURNING balance`, [supplierId])
  return Number(rows[0]?.balance ?? 0)
}

export async function refreshOrderStatus(tx: Tx, orderId: number) {
  const { rows: po } = await tx.query('SELECT status FROM purchase_orders WHERE id = $1', [orderId])
  if (!po[0] || !['issued', 'partial', 'received'].includes(po[0].status)) return po[0]?.status
  const { rows } = await tx.query('SELECT SUM(qty_received) AS got, bool_and(qty_received >= qty_ordered) AS done FROM purchase_items WHERE order_id = $1', [orderId])
  const status = rows[0].done ? 'received' : Number(rows[0].got) > 0 ? 'partial' : 'issued'
  if (status !== po[0].status) await tx.query('UPDATE purchase_orders SET status = $2 WHERE id = $1', [orderId, status])
  return status
}

// ---------------------------------------------------------------- Recepción
export interface ReceptionLine {
  orderItemId?: number | null
  productId?: number | null
  unitCost?: number | null // solo para productos que no estaban en la orden
  taxRate?: number | null
  qtyReceived: number
  qtyAccepted?: number
  qtyRejected?: number
  rejectReason?: string | null
  rejectResolution?: string | null
}

async function updateCostAndSuggest(tx: Tx, userId: number, p: any, addUnits: number, unitNetCost: number, source: string) {
  const oldNet = netCost(Number(p.cost), p.cost_includes_vat, p.tax_rate)
  const base = Math.max(Number(p.stock), 0)
  const newNet = base + addUnits > 0 ? Math.round((base * oldNet + addUnits * unitNetCost) / (base + addUnits)) : unitNetCost
  const newCost = p.cost_includes_vat ? Math.round(newNet * (1 + p.tax_rate / 100)) : newNet
  if (newCost === Number(p.cost)) return
  await tx.query('UPDATE products SET cost = $2, updated_at = now() WHERE id = $1', [p.id, newCost])
  await tx.query(`INSERT INTO price_history (product_id, field, old_value, new_value, user_id) VALUES ($1,'cost',$2,$3,$4)`, [p.id, p.cost, newCost, userId])
  // Sugerencia de precio: se mantiene el margen que tenía el producto (o el definido en su ficha).
  const price = Number(p.price)
  if (!price || p.kind !== 'product') return
  const markup = p.markup_pct != null ? Number(p.markup_pct) : Number(p.cost) > 0 ? markupOf(price, Number(p.cost), p.cost_includes_vat, p.tax_rate) : null
  if (markup == null) return
  const suggested = priceFromMarkup(newCost, markup, p.cost_includes_vat, p.tax_rate)
  if (suggested === price) return
  await tx.query(`UPDATE price_suggestions SET status = 'dismissed', decided_at = now() WHERE product_id = $1 AND status = 'pending'`, [p.id])
  await tx.query('INSERT INTO price_suggestions (product_id, cost_before, cost_after, price_before, price_suggested, source) VALUES ($1,$2,$3,$4,$5,$6)', [p.id, p.cost, newCost, price, suggested, source])
}

export async function receiveGoods(tx: Tx, o: { orderId: number | null; supplierId: number; userId: number; lines: ReceptionLine[]; deliveryNote?: string | null; place?: string | null; notes?: string | null; allowSurplus: boolean; direct?: boolean }) {
  if (!o.lines.length) throw new HttpError(400, 'La recepción no tiene líneas')
  const { rows: seq } = await tx.query(`SELECT nextval('reception_seq') AS n`)
  const { rows: rc } = await tx.query(
    `INSERT INTO receptions (number, order_id, supplier_id, user_id, place, delivery_note, notes, authorized_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [pad('RC', seq[0].n), o.orderId, o.supplierId, o.userId, o.place ?? null, o.deliveryNote ?? null, o.notes ?? null, o.allowSurplus ? o.userId : null])
  const rec = rc[0]
  let value = 0
  const touched: number[] = []
  const items: any[] = []
  for (const l of o.lines) {
    if (!Number.isInteger(l.qtyReceived) || l.qtyReceived < 0) throw new HttpError(400, 'La cantidad recibida no es válida')
    const rejected = l.qtyRejected ?? 0
    const accepted = l.qtyAccepted ?? l.qtyReceived - rejected
    if (accepted < 0 || rejected < 0 || accepted + rejected !== l.qtyReceived) throw new HttpError(400, 'Aceptado + rechazado debe ser igual a lo recibido')
    if (rejected > 0 && !l.rejectReason?.trim()) throw new HttpError(400, 'Indicá el motivo del rechazo')
    if (l.qtyReceived === 0) continue
    let it: any = null
    let product: any
    let unitNet: number, taxRate: number, upp: number
    if (l.orderItemId) {
      const { rows } = await tx.query(
        `SELECT pi.*, po.status AS order_status FROM purchase_items pi JOIN purchase_orders po ON po.id = pi.order_id WHERE pi.id = $1 AND pi.order_id = $2 FOR UPDATE OF pi`, [l.orderItemId, o.orderId])
      it = rows[0]
      if (!it) throw new HttpError(400, 'La línea no pertenece a la orden')
      product = (await tx.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [it.product_id])).rows[0]
      taxRate = it.tax_rate
      upp = it.units_per_presentation
      unitNet = Math.round(Number(it.line_net) / it.qty_ordered)
    } else {
      if (!l.productId) throw new HttpError(400, 'Falta el producto')
      product = (await tx.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [l.productId])).rows[0]
      if (!product) throw new HttpError(404, `Producto ${l.productId} inexistente`)
      if (l.unitCost == null) throw new HttpError(400, `Indicá el costo de "${product.name}"`)
      taxRate = l.taxRate ?? product.tax_rate
      upp = product.units_per_purchase
      unitNet = l.unitCost
      if (o.orderId && !o.allowSurplus) throw new HttpError(403, `"${product.name}" no está en la orden: requiere autorización`)
    }
    if (product.kind !== 'product') throw new HttpError(400, `"${product.name}" es un servicio y no se recibe`)
    const pending = it ? it.qty_ordered - it.qty_received : 0
    const normal = it ? Math.min(accepted, Math.max(pending, 0)) : 0
    const surplus = it ? accepted - normal : 0
    if (surplus > 0 && !o.allowSurplus) throw new HttpError(409, `"${product.name}": se recibe más de lo pedido (faltan ${Math.max(pending, 0)}). Requiere autorización.`)
    const parts: { kind: string; qty: number }[] = []
    if (it) {
      if (normal > 0 || rejected > 0 || accepted === 0) parts.push({ kind: 'normal', qty: normal })
      if (surplus > 0) parts.push({ kind: 'surplus', qty: surplus })
    } else parts.push({ kind: o.orderId ? 'different' : 'normal', qty: accepted })
    let rejectedLeft = rejected
    for (const part of parts) {
      const rej = part.kind === 'normal' || !it ? rejectedLeft : 0
      if (part.kind === 'normal') rejectedLeft = 0
      const got = part.qty + rej
      const { rows: ri } = await tx.query(
        `INSERT INTO reception_items (reception_id, order_item_id, product_id, kind, qty_received, qty_accepted, qty_rejected, reject_reason, reject_resolution, units_per_presentation, unit_cost, tax_rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [rec.id, it?.id ?? null, product.id, part.kind, got, part.qty, rej, rej ? l.rejectReason ?? null : null, rej ? l.rejectResolution ?? 'pending' : null, upp, unitNet, taxRate])
      items.push(ri[0])
      if (part.qty > 0) {
        const units = part.qty * upp
        const unitCostSale = Math.round(unitNet / upp)
        await updateCostAndSuggest(tx, o.userId, product, units, unitCostSale, `Recepción ${rec.number}`)
        await moveStock(tx, { productId: product.id, delta: units, type: 'purchase', unitCost: unitCostSale, refType: 'reception', refId: rec.id, reason: `Recepción ${rec.number}`, userId: o.userId })
        product = (await tx.query('SELECT * FROM products WHERE id = $1', [product.id])).rows[0]
        value += Math.round(unitNet * part.qty)
        touched.push(product.id)
      }
      if (it && part.kind === 'normal' && part.qty > 0) await tx.query('UPDATE purchase_items SET qty_received = qty_received + $2 WHERE id = $1', [it.id, part.qty])
      if (it && rej) await tx.query('UPDATE purchase_items SET qty_rejected = qty_rejected + $2 WHERE id = $1', [it.id, rej])
    }
    await tx.query(
      `INSERT INTO product_suppliers (product_id, supplier_id, last_cost) VALUES ($1,$2,$3) ON CONFLICT (product_id, supplier_id) DO UPDATE SET last_cost = $3`,
      [product.id, o.supplierId, Math.round(unitNet / upp)])
  }
  if (!items.length) throw new HttpError(400, 'No hay cantidades para recibir')
  await post(tx, { description: `Recepción ${rec.number}`, refType: 'reception', refId: rec.id, userId: o.userId, lines: [{ code: ACC.inventory, debit: value }, { code: GRNI, credit: value }] })
  if (o.orderId) await refreshOrderStatus(tx, o.orderId)
  await checkReplenishment(tx, touched)
  await audit(tx, o.userId, 'reception.create', 'reception', rec.id, { number: rec.number, order: o.orderId, value })
  return { ...rec, items, value }
}

export async function voidReception(tx: Tx, userId: number, id: number, reason: string) {
  const { rows } = await tx.query('SELECT * FROM receptions WHERE id = $1 FOR UPDATE', [id])
  const rec = rows[0]
  if (!rec) throw new HttpError(404, 'Recepción no encontrada')
  if (rec.status === 'void') throw new HttpError(409, 'La recepción ya está anulada')
  const { rows: items } = await tx.query('SELECT * FROM reception_items WHERE reception_id = $1 FOR UPDATE', [id])
  if (items.some((i) => i.invoiced_qty > 0 || i.returned_qty > 0)) throw new HttpError(409, 'La recepción tiene facturas o devoluciones: anulá esos documentos primero')
  for (const i of items) {
    if (i.qty_accepted > 0) await moveStock(tx, { productId: i.product_id, delta: -i.qty_accepted * i.units_per_presentation, type: 'adjustment', refType: 'reception', refId: id, reason: `Anulación de ${rec.number}: ${reason}`, userId })
    if (i.order_item_id) {
      if (i.kind === 'normal') await tx.query('UPDATE purchase_items SET qty_received = qty_received - $2 WHERE id = $1', [i.order_item_id, i.qty_accepted])
      if (i.qty_rejected) await tx.query('UPDATE purchase_items SET qty_rejected = qty_rejected - $2 WHERE id = $1', [i.order_item_id, i.qty_rejected])
    }
  }
  await reverse(tx, 'reception', id, `Anulación de ${rec.number}: ${reason}`, userId)
  await tx.query(`UPDATE receptions SET status = 'void', void_reason = $2 WHERE id = $1`, [id, reason])
  if (rec.order_id) await refreshOrderStatus(tx, rec.order_id)
  await checkReplenishment(tx, items.map((i) => i.product_id))
  await audit(tx, userId, 'reception.void', 'reception', id, { reason })
}

// ---------------------------------------------------------------- Factura de compra
export interface InvoiceLine {
  receptionItemId: number
  qty?: number // en presentaciones; por defecto todo lo pendiente de facturar
  unitCost?: number // si difiere del recibido
  discount?: number
  taxRate?: number
  includesVat?: boolean
}
export interface InvoiceIn {
  supplierId: number
  docType: 'invoice' | 'receipt'
  docNumber: string
  timbrado?: string | null
  docDate: string
  paymentCondition: 'cash' | 'credit'
  installments?: { dueDate: string; amount: number }[]
  dueDate?: string | null
  lines: InvoiceLine[]
  extraCosts?: number
  notes?: string | null
  direct?: boolean
}

export const invoiceable = (i: any) => i.qty_accepted - i.invoiced_qty - (i.returned_qty - i.returned_inv_qty)

export async function createPurchaseInvoice(tx: Tx, userId: number, b: InvoiceIn) {
  const { rows: sup } = await tx.query('SELECT * FROM suppliers WHERE id = $1 FOR UPDATE', [b.supplierId])
  if (!sup[0]) throw new HttpError(404, 'Proveedor no encontrado')
  if (!sup[0].active) throw new HttpError(409, 'El proveedor está inactivo')
  if (b.docType === 'invoice' && !/^\d{3}-\d{3}-\d{7}$/.test(b.docNumber)) throw new HttpError(400, 'El número de factura debe tener el formato 001-001-0000001')
  if (b.timbrado && !/^\d{8}$/.test(b.timbrado)) throw new HttpError(400, 'El timbrado debe tener 8 dígitos')
  if (b.docDate > today()) throw new HttpError(400, 'La fecha de la factura no puede ser futura')
  const dup = await tx.query(`SELECT id, number FROM purchase_invoices WHERE supplier_id = $1 AND doc_type = $2 AND lower(doc_number) = lower($3) AND status <> 'void'`, [b.supplierId, b.docType, b.docNumber])
  if (dup.rows[0]) throw new HttpError(409, `Esa factura ya fue cargada para este proveedor (${dup.rows[0].number})`)
  if (!b.lines.length) throw new HttpError(400, 'La factura no tiene líneas')

  let grni = 0, variance = 0, net = 0, tax = 0
  const calc: any[] = []
  const orders = new Set<number>()
  for (const l of b.lines) {
    const { rows } = await tx.query(
      `SELECT ri.*, r.supplier_id, r.status AS rec_status, r.order_id, p.name FROM reception_items ri JOIN receptions r ON r.id = ri.reception_id JOIN products p ON p.id = ri.product_id WHERE ri.id = $1 FOR UPDATE OF ri`, [l.receptionItemId])
    const ri = rows[0]
    if (!ri || ri.supplier_id !== b.supplierId) throw new HttpError(400, 'La línea no corresponde a una recepción de este proveedor')
    if (ri.rec_status === 'void') throw new HttpError(409, 'La recepción está anulada')
    const avail = invoiceable(ri)
    const qty = l.qty ?? avail
    if (qty <= 0) throw new HttpError(409, `"${ri.name}" no tiene cantidades pendientes de facturar`)
    if (qty > avail) throw new HttpError(409, `"${ri.name}": no se puede facturar más de lo recibido (pendiente de facturar ${avail})`)
    const unit = l.unitCost ?? Number(ri.unit_cost)
    const taxRate = l.taxRate ?? ri.tax_rate
    const a = lineAmounts({ qty, unitCost: unit, discount: l.discount, taxRate, includesVat: l.includesVat })
    const valuation = Math.round(Number(ri.unit_cost) * qty)
    grni += valuation
    variance += a.net - valuation
    net += a.net; tax += a.tax
    if (ri.order_id) orders.add(ri.order_id)
    calc.push({ ri, qty, unit, taxRate, discount: l.discount ?? 0, ...a })
  }
  const extra = b.extraCosts ?? 0
  const total = net + tax + extra

  let schedule: { dueDate: string; amount: number }[]
  if (b.paymentCondition === 'cash') schedule = [{ dueDate: b.docDate, amount: total }]
  else if (b.installments?.length) {
    const sum = b.installments.reduce((a, x) => a + x.amount, 0)
    if (sum !== total) throw new HttpError(400, `Las cuotas suman ${sum} y la factura es de ${total}`)
    if (b.installments.some((x) => x.amount <= 0 || x.dueDate < b.docDate)) throw new HttpError(400, 'Las cuotas deben ser positivas y vencer desde la fecha de la factura')
    schedule = b.installments
  } else schedule = [{ dueDate: b.dueDate ?? addDays(b.docDate, Number(sup[0].payment_days ?? 30)), amount: total }]
  if (b.paymentCondition === 'credit' && schedule.some((s) => s.dueDate < b.docDate)) throw new HttpError(400, 'El vencimiento no puede ser anterior a la fecha de la factura')

  const { rows: seq } = await tx.query(`SELECT nextval('purchase_invoice_seq') AS n`)
  let inv: any
  try {
    inv = (await tx.query(
      `INSERT INTO purchase_invoices (number, supplier_id, doc_type, doc_number, timbrado, doc_date, payment_condition, subtotal, extra_costs, tax_total, total, notes, user_id, direct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [pad('FC', seq[0].n), b.supplierId, b.docType, b.docNumber, b.timbrado ?? null, b.docDate, b.paymentCondition, net, extra, tax, total, b.notes ?? null, userId, !!b.direct])).rows[0]
  } catch (e: any) {
    if (e.code === '23505') throw new HttpError(409, 'Esa factura ya fue cargada para este proveedor')
    throw e
  }
  for (const c of calc) {
    await tx.query(
      `INSERT INTO purchase_invoice_items (invoice_id, product_id, description, qty, units_per_presentation, unit_cost, discount, tax_rate, net, tax, total, order_item_id, reception_item_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [inv.id, c.ri.product_id, c.ri.name, c.qty, c.ri.units_per_presentation, c.unit, c.discount, c.taxRate, c.net, c.tax, c.total, c.ri.order_item_id, c.ri.id])
    await tx.query('UPDATE reception_items SET invoiced_qty = invoiced_qty + $2 WHERE id = $1', [c.ri.id, c.qty])
  }
  for (const oid of orders) await tx.query('INSERT INTO purchase_invoice_orders (invoice_id, order_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [inv.id, oid])
  let n = 1
  for (const s of schedule) await tx.query('INSERT INTO payables (invoice_id, supplier_id, number, due_date, amount) VALUES ($1,$2,$3,$4,$5)', [inv.id, b.supplierId, n++, s.dueDate, s.amount])
  await post(tx, { description: `Factura de compra ${b.docNumber} — ${sup[0].name}`, refType: 'purchase_invoice', refId: inv.id, userId, date: b.docDate,
    lines: [
      { code: GRNI, debit: grni },
      { code: ACC.inventory, debit: variance > 0 ? variance : 0, credit: variance < 0 ? -variance : 0 },
      { code: ACC.vatCredit, debit: tax },
      { code: ACC.expenses, debit: extra },
      { code: ACC.payable, credit: total },
    ] })
  await refreshSupplier(tx, b.supplierId)
  await audit(tx, userId, 'purchase_invoice.create', 'purchase_invoice', inv.id, { number: inv.number, doc: b.docNumber, total })
  return { ...inv, orderIds: [...orders] }
}

export async function voidPurchaseInvoice(tx: Tx, userId: number, id: number, reason: string) {
  const { rows } = await tx.query('SELECT * FROM purchase_invoices WHERE id = $1 FOR UPDATE', [id])
  const inv = rows[0]
  if (!inv) throw new HttpError(404, 'Factura no encontrada')
  if (inv.status === 'void') throw new HttpError(409, 'La factura ya está anulada')
  const { rows: pay } = await tx.query(`SELECT COALESCE(SUM(paid + credited), 0) AS n FROM payables WHERE invoice_id = $1 AND status = 'open'`, [id])
  if (Number(pay[0].n) > 0) throw new HttpError(409, 'La factura tiene pagos o notas de crédito aplicados: anulá esos documentos primero')
  const { rows: cn } = await tx.query(`SELECT 1 FROM supplier_credit_notes WHERE invoice_id = $1 AND status <> 'void' LIMIT 1`, [id])
  if (cn[0]) throw new HttpError(409, 'La factura tiene notas de crédito: anulalas primero')
  const { rows: items } = await tx.query('SELECT * FROM purchase_invoice_items WHERE invoice_id = $1', [id])
  for (const i of items) if (i.reception_item_id) await tx.query('UPDATE reception_items SET invoiced_qty = invoiced_qty - $2 WHERE id = $1', [i.reception_item_id, i.qty])
  await tx.query(`UPDATE payables SET status = 'void' WHERE invoice_id = $1`, [id])
  await reverse(tx, 'purchase_invoice', id, `Anulación de factura de compra ${inv.doc_number}: ${reason}`, userId)
  await tx.query(`UPDATE purchase_invoices SET status = 'void', void_reason = $2, voided_at = now(), voided_by = $3 WHERE id = $1`, [id, reason, userId])
  await refreshSupplier(tx, inv.supplier_id)
  await audit(tx, userId, 'purchase_invoice.void', 'purchase_invoice', id, { reason })
}

// ---------------------------------------------------------------- Pagos a proveedores
export interface PayIn {
  amount: number
  method: 'cash' | 'transfer' | 'card' | 'check'
  accountId?: number | null
  reference?: string | null
  note?: string | null
  paidOn?: string | null
  allocations?: { payableId: number; amount: number }[]
  orderId?: number | null
  useCredit?: number
  advance?: boolean
}

export async function paySupplier(tx: Tx, user: { id: number }, supplierId: number, p: PayIn) {
  const { rows: sup } = await tx.query('SELECT * FROM suppliers WHERE id = $1 FOR UPDATE', [supplierId])
  if (!sup[0]) throw new HttpError(404, 'Proveedor no encontrado')
  const credit = p.useCredit ?? 0
  if (credit < 0 || p.amount < 0 || p.amount + credit <= 0) throw new HttpError(400, 'El importe del pago debe ser mayor a cero')
  if (credit > Number(sup[0].credit_balance)) throw new HttpError(409, `El saldo a favor del proveedor es de ${sup[0].credit_balance}`)
  if (p.paidOn && p.paidOn > today()) throw new HttpError(400, 'La fecha de pago no puede ser futura')

  const { rows: open } = await tx.query(
    `SELECT pb.*, i.doc_number FROM payables pb JOIN purchase_invoices i ON i.id = pb.invoice_id
     WHERE pb.supplier_id = $1 AND pb.status = 'open' AND pb.amount - pb.paid - pb.credited > 0
       AND ($2::int IS NULL OR pb.invoice_id IN (SELECT invoice_id FROM purchase_invoice_orders WHERE order_id = $2))
     ORDER BY pb.due_date, pb.id FOR UPDATE OF pb`, [supplierId, p.orderId ?? null])
  const rem = (x: any) => Number(x.amount) - Number(x.paid) - Number(x.credited)
  const totalPay = p.amount + credit
  let alloc: { payable: any; amount: number }[] = []
  if (p.allocations?.length) {
    const sum = p.allocations.reduce((a, x) => a + x.amount, 0)
    if (sum > totalPay) throw new HttpError(400, 'Lo aplicado a facturas supera el importe del pago')
    for (const a of p.allocations) {
      const pb = open.find((x) => x.id === a.payableId)
      if (!pb) throw new HttpError(400, 'La cuota no existe, está pagada o es de otro proveedor')
      if (a.amount <= 0 || a.amount > rem(pb)) throw new HttpError(400, `La cuota de la factura ${pb.doc_number} tiene saldo ${rem(pb)}`)
      alloc.push({ payable: pb, amount: a.amount })
    }
  } else {
    let left = totalPay
    for (const pb of open) { if (left <= 0) break; const x = Math.min(left, rem(pb)); alloc.push({ payable: pb, amount: x }); left -= x }
  }
  const applied = alloc.reduce((a, x) => a + x.amount, 0)
  const advance = totalPay - applied
  if (advance > 0 && !p.advance) throw new HttpError(400, applied === 0 ? 'El proveedor no tiene deudas pendientes' : 'El pago supera la deuda con el proveedor')

  let sessionId: number | null = null
  let accountId = p.accountId ?? null
  if (p.amount > 0) {
    if (p.method === 'cash') {
      const { rows: ss } = await tx.query(`SELECT id, account_id FROM cash_sessions WHERE user_id = $1 AND status = 'open'`, [user.id])
      if (!ss[0]) throw new HttpError(409, 'Abrí la caja para pagar en efectivo')
      const c = await sessionCash(tx, ss[0].id)
      if (c && p.amount > c.expected) throw new HttpError(409, `No hay tanto efectivo en la caja (esperado ${c.expected})`)
      sessionId = ss[0].id
      accountId = ss[0].account_id ?? (await defaultAccount(tx, 'cash'))
    } else accountId = accountId ?? (await defaultAccount(tx, 'bank'))
  }
  const method = p.amount > 0 ? p.method : 'credit'
  const { rows: sp } = await tx.query(
    `INSERT INTO supplier_payments (supplier_id, amount, method, note, user_id, order_id, account_id, session_id, reference, credit_applied, advance_amount, paid_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::date, current_date)) RETURNING id`,
    [supplierId, p.amount > 0 ? p.amount : credit, method, p.note ?? null, user.id, p.orderId ?? null, accountId, sessionId, p.reference ?? null, credit, advance, p.paidOn ?? null])
  const touched = new Set<number>()
  for (const a of alloc) {
    await tx.query('UPDATE payables SET paid = paid + $2 WHERE id = $1', [a.payable.id, a.amount])
    await tx.query('INSERT INTO supplier_payment_allocations (payment_id, payable_id, amount) VALUES ($1,$2,$3)', [sp[0].id, a.payable.id, a.amount])
    touched.add(a.payable.invoice_id)
  }
  for (const id of touched) await refreshInvoice(tx, id)
  await tx.query('UPDATE suppliers SET credit_balance = credit_balance - $2 + $3 WHERE id = $1', [supplierId, credit, advance])
  if (p.amount > 0) {
    await post(tx, { description: p.orderId ? `Pago de la orden de compra #${p.orderId}` : `Pago a proveedor ${sup[0].name}`, refType: 'supplier_payment', refId: sp[0].id, userId: user.id, date: p.paidOn ?? undefined,
      lines: [{ code: ACC.payable, debit: p.amount }, { code: p.method === 'cash' ? ACC.cash : ACC.bank, credit: p.amount }] })
  }
  await refreshSupplier(tx, supplierId)
  await audit(tx, user.id, 'supplier_payment.create', 'supplier_payment', sp[0].id, { supplierId, amount: p.amount, credit, advance })
  return { id: sp[0].id as number, applied, advance, credit }
}

export async function voidSupplierPayment(tx: Tx, userId: number, id: number, reason: string) {
  const { rows } = await tx.query('SELECT * FROM supplier_payments WHERE id = $1 FOR UPDATE', [id])
  const sp = rows[0]
  if (!sp) throw new HttpError(404, 'Pago no encontrado')
  if (sp.voided) throw new HttpError(409, 'El pago ya está anulado')
  const { rows: al } = await tx.query('SELECT * FROM supplier_payment_allocations WHERE payment_id = $1', [id])
  const invoices = new Set<number>()
  for (const a of al) {
    const { rows: pb } = await tx.query('UPDATE payables SET paid = paid - $2 WHERE id = $1 RETURNING invoice_id', [a.payable_id, a.amount])
    invoices.add(pb[0].invoice_id)
  }
  for (const i of invoices) await refreshInvoice(tx, i)
  await tx.query('UPDATE suppliers SET credit_balance = credit_balance + $2 - $3 WHERE id = $1', [sp.supplier_id, sp.credit_applied, sp.advance_amount])
  await reverse(tx, 'supplier_payment', id, `Anulación de pago a proveedor: ${reason}`, userId)
  await tx.query(`UPDATE supplier_payments SET voided = true, voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1`, [id, userId, reason])
  await refreshSupplier(tx, sp.supplier_id)
  await audit(tx, userId, 'supplier_payment.void', 'supplier_payment', id, { reason })
}

// ---------------------------------------------------------------- Devoluciones a proveedor
export interface ReturnLine { receptionItemId: number; qty: number; condition?: string | null }

export async function createSupplierReturn(tx: Tx, userId: number, o: { supplierId: number; lines: ReturnLine[]; reason: string; orderId?: number | null }) {
  if (!o.lines.length) throw new HttpError(400, 'La devolución no tiene líneas')
  const { rows: seq } = await tx.query(`SELECT nextval('supplier_return_seq') AS n`)
  const { rows: ret } = await tx.query(`INSERT INTO supplier_returns (number, supplier_id, order_id, reason, total, user_id) VALUES ($1,$2,$3,$4,0,$5) RETURNING *`, [pad('DV', seq[0].n), o.supplierId, o.orderId ?? null, o.reason, userId])
  let total = 0, invoiced = 0, uninvoiced = 0
  const touched: number[] = []
  for (const l of o.lines) {
    const { rows } = await tx.query(
      `SELECT ri.*, r.supplier_id, r.order_id, r.id AS rec_id, p.name FROM reception_items ri JOIN receptions r ON r.id = ri.reception_id JOIN products p ON p.id = ri.product_id WHERE ri.id = $1 AND r.status = 'posted' FOR UPDATE OF ri`, [l.receptionItemId])
    const ri = rows[0]
    if (!ri || ri.supplier_id !== o.supplierId) throw new HttpError(400, 'La línea no corresponde a una recepción de este proveedor')
    if (l.qty <= 0) throw new HttpError(400, 'La cantidad a devolver debe ser mayor a cero')
    if (l.qty > ri.qty_accepted - ri.returned_qty) throw new HttpError(409, `De "${ri.name}" solo se pueden devolver ${ri.qty_accepted - ri.returned_qty}`)
    const fromUninv = Math.min(l.qty, Math.max(invoiceable(ri), 0))
    const fromInv = l.qty - fromUninv
    const val = Math.round(Number(ri.unit_cost) * l.qty)
    const valUninv = Math.round(Number(ri.unit_cost) * fromUninv)
    uninvoiced += valUninv; invoiced += val - valUninv; total += val
    await moveStock(tx, { productId: ri.product_id, delta: -l.qty * ri.units_per_presentation, type: 'supplier_return', refType: 'supplier_return', refId: ret[0].id, reason: `Devolución ${ret[0].number}: ${o.reason}`, userId, unitCost: Math.round(Number(ri.unit_cost) / ri.units_per_presentation) })
    await tx.query('UPDATE reception_items SET returned_qty = returned_qty + $2, returned_inv_qty = returned_inv_qty + $3 WHERE id = $1', [ri.id, l.qty, fromInv])
    await tx.query(`INSERT INTO supplier_return_items (return_id, product_id, qty, unit_cost, reception_item_id, invoiced_qty, condition) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ret[0].id, ri.product_id, l.qty, Math.round(Number(ri.unit_cost)), ri.id, fromInv, l.condition ?? null])
    touched.push(ri.product_id)
    if (ri.order_id && !o.orderId) await tx.query('UPDATE supplier_returns SET order_id = $2 WHERE id = $1', [ret[0].id, ri.order_id])
  }
  await tx.query(`UPDATE supplier_returns SET total = $2, invoiced_value = $3, credit_status = $4 WHERE id = $1`, [ret[0].id, total, invoiced, invoiced > 0 ? 'pending' : 'none'])
  await post(tx, { description: `Devolución a proveedor ${ret[0].number}: ${o.reason}`, refType: 'supplier_return', refId: ret[0].id, userId,
    lines: [{ code: GRNI, debit: uninvoiced }, { code: SUPPLIER_RECEIVABLE, debit: invoiced }, { code: ACC.inventory, credit: total }] })
  await checkReplenishment(tx, touched)
  await audit(tx, userId, 'supplier_return.create', 'supplier_return', ret[0].id, { number: ret[0].number, total, invoiced })
  return { ...(await tx.query('SELECT * FROM supplier_returns WHERE id = $1', [ret[0].id])).rows[0] }
}

// ---------------------------------------------------------------- Notas de crédito del proveedor
export interface CreditNoteIn {
  supplierId: number
  returnId?: number | null
  invoiceId?: number | null
  docNumber: string
  docDate: string
  net: number
  vat: number
  resolution: 'applied' | 'credit_balance' | 'refund'
  refundMethod?: 'cash' | 'transfer' | null
  refundAccountId?: number | null
  reference?: string | null
  notes?: string | null
}

export async function createCreditNote(tx: Tx, user: { id: number }, b: CreditNoteIn) {
  const amount = b.net + b.vat
  if (b.net <= 0 || b.vat < 0) throw new HttpError(400, 'El importe de la nota de crédito no es válido')
  const { rows: sup } = await tx.query('SELECT * FROM suppliers WHERE id = $1 FOR UPDATE', [b.supplierId])
  if (!sup[0]) throw new HttpError(404, 'Proveedor no encontrado')
  const dup = await tx.query(`SELECT number FROM supplier_credit_notes WHERE supplier_id = $1 AND lower(doc_number) = lower($2) AND status <> 'void'`, [b.supplierId, b.docNumber])
  if (dup.rows[0]) throw new HttpError(409, `Esa nota de crédito ya fue cargada (${dup.rows[0].number})`)
  let ret: any = null
  if (b.returnId) {
    ret = (await tx.query('SELECT * FROM supplier_returns WHERE id = $1 FOR UPDATE', [b.returnId])).rows[0]
    if (!ret || ret.supplier_id !== b.supplierId) throw new HttpError(400, 'La devolución no corresponde a este proveedor')
    if (b.net > Number(ret.invoiced_value) - Number(ret.credited)) throw new HttpError(409, `La devolución solo admite crédito por ${Number(ret.invoiced_value) - Number(ret.credited)} sin IVA`)
  }
  let sessionId: number | null = null
  let accountId = b.refundAccountId ?? null
  if (b.resolution === 'refund') {
    if (!b.refundMethod) throw new HttpError(400, 'Indicá cómo te devuelven el dinero')
    if (b.refundMethod === 'cash') {
      const { rows: ss } = await tx.query(`SELECT id, account_id FROM cash_sessions WHERE user_id = $1 AND status = 'open'`, [user.id])
      if (!ss[0]) throw new HttpError(409, 'Abrí la caja para registrar el ingreso en efectivo')
      sessionId = ss[0].id
      accountId = ss[0].account_id ?? (await defaultAccount(tx, 'cash'))
    } else accountId = accountId ?? (await defaultAccount(tx, 'bank'))
  }
  const { rows: seq } = await tx.query(`SELECT nextval('credit_note_seq') AS n`)
  const { rows: cn } = await tx.query(
    `INSERT INTO supplier_credit_notes (number, supplier_id, return_id, invoice_id, doc_number, doc_date, amount, vat, net, resolution, refund_method, refund_account_id, session_id, reference, notes, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [pad('NC', seq[0].n), b.supplierId, b.returnId ?? null, b.invoiceId ?? null, b.docNumber, b.docDate, amount, b.vat, b.net, b.resolution, b.refundMethod ?? null, accountId, sessionId, b.reference ?? null, b.notes ?? null, user.id])
  let toPayables = 0
  if (b.resolution === 'refund') {
    // el dinero vuelve a caja/banco; no toca la deuda
  } else {
    const { rows: open } = await tx.query(
      `SELECT * FROM payables WHERE supplier_id = $1 AND status = 'open' AND amount - paid - credited > 0 AND ($2::int IS NULL OR invoice_id = $2) ORDER BY due_date, id FOR UPDATE`, [b.supplierId, b.invoiceId ?? null])
    let left = b.resolution === 'applied' ? amount : 0
    const touched = new Set<number>()
    for (const pb of open) {
      if (left <= 0) break
      const x = Math.min(left, Number(pb.amount) - Number(pb.paid) - Number(pb.credited))
      await tx.query('UPDATE payables SET credited = credited + $2 WHERE id = $1', [pb.id, x])
      touched.add(pb.invoice_id); left -= x; toPayables += x
    }
    for (const i of touched) await refreshInvoice(tx, i)
    const toCredit = amount - toPayables
    if (toCredit > 0) await tx.query('UPDATE suppliers SET credit_balance = credit_balance + $2 WHERE id = $1', [b.supplierId, toCredit])
  }
  if (ret) await tx.query(`UPDATE supplier_returns SET credited = credited + $2, credit_status = CASE WHEN credited + $2 >= invoiced_value THEN 'credited' ELSE 'partial' END WHERE id = $1`, [ret.id, b.net])
  const debit = b.resolution === 'refund' ? (b.refundMethod === 'cash' ? ACC.cash : ACC.bank) : ACC.payable
  // La nota cancela el crédito pendiente de la devolución (1.1.09); la diferencia contra el costo recibido va a ajustes.
  const receivableUsed = ret ? Math.min(b.net, Number(ret.invoiced_value) - Number(ret.credited)) : 0
  await post(tx, { description: `Nota de crédito ${b.docNumber} — ${sup[0].name}`, refType: 'supplier_credit_note', refId: cn[0].id, userId: user.id, date: b.docDate,
    lines: [
      { code: debit, debit: amount },
      { code: SUPPLIER_RECEIVABLE, credit: receivableUsed },
      { code: GRNI, credit: b.net - receivableUsed },
      { code: ACC.vatCredit, credit: b.vat },
    ] })
  await refreshSupplier(tx, b.supplierId)
  await audit(tx, user.id, 'credit_note.create', 'supplier_credit_note', cn[0].id, { number: cn[0].number, amount, resolution: b.resolution })
  return cn[0]
}

export const dueState = (due: string | Date, outstanding: number, asOf = today()) => {
  const d = dstr(due)!
  if (outstanding <= 0) return 'paid'
  return d < asOf ? 'overdue' : d <= addDays(asOf, 7) ? 'due_soon' : 'current'
}
