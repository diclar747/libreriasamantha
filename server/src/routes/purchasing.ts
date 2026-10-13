import type { FastifyInstance } from 'fastify'
import PDFDocument from 'pdfkit'
import { z } from 'zod'
import { anyPerm, can, requirePerm } from '../auth.js'
import { HttpError, withTx, type Db, type Tx } from '../db/client.js'
import { getSetting } from '../services.js'
import { netCost } from '../pricing.js'
import {
  audit, createCreditNote, createPurchaseInvoice, createSupplierReturn, dstr, invoiceable, lineAmounts, pad, paySupplier, receiveGoods, refreshOrderStatus, voidPurchaseInvoice, voidReception,
} from '../purchasing.js'
import { supplierRoutes } from './suppliers.js'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida')
const today = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)

const orderLine = z.object({
  productId: z.number().int(), qty: z.number().int().positive('La cantidad debe ser mayor a cero'), unitCost: z.number().int().min(0, 'El costo no puede ser negativo'),
  discount: z.number().int().min(0).default(0), taxRate: z.union([z.literal(0), z.literal(5), z.literal(10)]).optional(),
  presentation: z.string().max(40).nullish(), unitsPerPresentation: z.number().int().positive().optional(), includesVat: z.boolean().optional(), note: z.string().max(200).nullish(),
})
const orderBody = z.object({
  supplierId: z.number().int(), items: z.array(orderLine).min(1, 'La orden necesita al menos un producto'),
  expectedDate: date.nullish(), orderDate: date.optional(), notes: z.string().max(1000).nullish(), receivingPlace: z.string().max(120).nullish(), reference: z.string().max(80).nullish(),
  extraCosts: z.number().int().min(0).default(0), extraCostsNote: z.string().max(200).nullish(), paymentCondition: z.enum(['cash', 'credit']).default('credit'),
  issue: z.boolean().optional(), invoiceNumber: z.string().nullish(), invoiceDate: z.string().nullish(), dueDate: z.string().nullish(),
})

// Una orden solo es editable mientras es borrador; después se anula y se vuelve a emitir.
async function writeItems(tx: Tx, orderId: number, items: z.infer<typeof orderLine>[]) {
  let net = 0, tax = 0
  const seen = new Set<number>()
  for (const it of items) {
    if (seen.has(it.productId)) throw new HttpError(400, 'Hay un producto repetido en la orden: unificá las cantidades')
    seen.add(it.productId)
    const { rows } = await tx.query('SELECT * FROM products WHERE id = $1', [it.productId])
    const p = rows[0]
    if (!p) throw new HttpError(404, `Producto ${it.productId} inexistente`)
    if (!p.active) throw new HttpError(409, `"${p.name}" está inactivo`)
    if (p.kind !== 'product') throw new HttpError(400, `"${p.name}" es un servicio y no se compra`)
    const taxRate = it.taxRate ?? p.tax_rate
    const includesVat = it.includesVat ?? false
    const a = lineAmounts({ qty: it.qty, unitCost: it.unitCost, discount: it.discount, taxRate, includesVat })
    net += a.net; tax += a.tax
    await tx.query(
      `INSERT INTO purchase_items (order_id, product_id, qty_ordered, unit_cost, presentation, units_per_presentation, discount, tax_rate, cost_includes_vat, line_net, line_tax, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [orderId, p.id, it.qty, it.unitCost, it.presentation ?? p.purchase_unit, it.unitsPerPresentation ?? p.units_per_purchase, it.discount, taxRate, includesVat, a.net, a.tax, it.note ?? null])
  }
  return { net, tax }
}

async function orderDetail(db: Db | Tx, id: number, costs = true) {
  const { rows } = await db.query('SELECT po.*, s.name AS supplier_name, s.ruc AS supplier_ruc, s.whatsapp AS supplier_whatsapp, s.email AS supplier_email FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1', [id])
  if (!rows[0]) throw new HttpError(404, 'Orden no encontrada')
  const { rows: items } = await db.query(
    `SELECT pi.*, p.name, p.code, p.sale_unit, p.barcode, p.isbn,
       (pi.qty_ordered - pi.qty_received) AS qty_pending,
       COALESCE((SELECT SUM(ii.qty) FROM purchase_invoice_items ii JOIN purchase_invoices i ON i.id = ii.invoice_id WHERE ii.order_item_id = pi.id AND i.status <> 'void'), 0)::int AS qty_invoiced
     FROM purchase_items pi JOIN products p ON p.id = pi.product_id WHERE pi.order_id = $1 ORDER BY pi.id`, [id])
  const [receptions, invoices, payments, returns, files, events] = await Promise.all([
    db.query(`SELECT r.id, r.number, r.received_at, r.status, r.delivery_note, u.name AS user_name FROM receptions r LEFT JOIN users u ON u.id = r.user_id WHERE r.order_id = $1 ORDER BY r.id`, [id]),
    db.query(`SELECT i.id, i.number, i.doc_number, i.doc_date, i.total, i.paid, i.credited, i.status FROM purchase_invoices i JOIN purchase_invoice_orders o ON o.invoice_id = i.id WHERE o.order_id = $1 ORDER BY i.id`, [id]),
    db.query(`SELECT DISTINCT sp.id, sp.at, sp.amount, sp.method, sp.reference, sp.voided FROM supplier_payments sp
              LEFT JOIN supplier_payment_allocations a ON a.payment_id = sp.id LEFT JOIN payables pb ON pb.id = a.payable_id LEFT JOIN purchase_invoice_orders o ON o.invoice_id = pb.invoice_id
              WHERE sp.order_id = $1 OR o.order_id = $1 ORDER BY sp.id`, [id]),
    db.query(`SELECT id, number, created_at, total, credit_status, reason FROM supplier_returns WHERE order_id = $1 ORDER BY id`, [id]),
    db.query(`SELECT id, filename, mime, size, note, created_at FROM attachments WHERE owner_type = 'purchase_order' AND owner_id = $1 ORDER BY id`, [id]),
    db.query(`SELECT a.action, a.detail, a.at, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity = 'purchase_order' AND a.entity_id = $1 ORDER BY a.id`, [id]),
  ])
  const receivedValue = items.reduce((a, i) => a + Math.round((Number(i.line_net) / i.qty_ordered) * i.qty_received), 0)
  const invoiced = invoices.rows.filter((i) => i.status !== 'void').reduce((a, i) => a + Number(i.total), 0)
  const paid = payments.rows.filter((p) => !p.voided).reduce((a, p) => a + Number(p.amount), 0)
  const strip = (r: any) => (costs ? r : Object.fromEntries(Object.entries(r).filter(([k]) => !['unit_cost', 'line_net', 'line_tax', 'discount'].includes(k))))
  return {
    ...rows[0], items: items.map(strip), receptions: receptions.rows, invoices: invoices.rows, payments: payments.rows, returns: returns.rows, attachments: files.rows, events: events.rows,
    received_value: receivedValue, invoiced, paid, returned: returns.rows.reduce((a, r) => a + Number(r.total), 0), pending: invoiced - paid,
    progress: { ordered: items.reduce((a, i) => a + i.qty_ordered, 0), received: items.reduce((a, i) => a + i.qty_received, 0), rejected: items.reduce((a, i) => a + i.qty_rejected, 0), invoiced: items.reduce((a, i) => a + i.qty_invoiced, 0) },
  }
}

export function purchasingRoutes(app: FastifyInstance, db: Db) {
  supplierRoutes(app, db)
  const seeOrders = (req: any) => anyPerm(req, ['purchases.view', 'purchases.write'])
  const mayApprove = (req: any) => can(req.user!.role, 'purchases.approve')
  const orderEvent = (tx: Tx, req: any, id: number, action: string, detail: unknown = {}) => audit(tx, req.user!.id, action, 'purchase_order', id, detail)

  // ------------------------------------------------------------ Órdenes de compra
  app.get('/purchases', async (req) => {
    seeOrders(req)
    const q = req.query as Record<string, string | undefined>
    const params: unknown[] = []
    const w: string[] = []
    const add = (v: unknown) => { params.push(v); return '$' + params.length }
    if (q.status) w.push(`po.status = ANY(${add(q.status.split(','))})`)
    if (q.supplierId) w.push(`po.supplier_id = ${add(Number(q.supplierId))}`)
    if (q.from) w.push(`po.order_date >= ${add(q.from)}::date`)
    if (q.to) w.push(`po.order_date <= ${add(q.to)}::date`)
    if (q.q) { const l = add(`%${q.q}%`); w.push(`(po.number ILIKE ${l} OR s.name ILIKE ${l} OR po.reference ILIKE ${l} OR EXISTS (SELECT 1 FROM purchase_items x JOIN products p ON p.id = x.product_id WHERE x.order_id = po.id AND p.name ILIKE ${l}))`) }
    if (q.open === '1') w.push(`po.status IN ('issued','partial')`)
    const paged = q.page !== undefined
    const size = [15, 30, 50, 100].includes(Number(q.pageSize)) ? Number(q.pageSize) : 30
    const page = Math.max(1, Number(q.page) || 1)
    const where = w.length ? 'WHERE ' + w.join(' AND ') : ''
    const { rows } = await db.query(
      `SELECT po.*, s.name AS supplier_name,
         COALESCE((SELECT SUM(ROUND(pi.line_net::numeric / pi.qty_ordered * pi.qty_received)) FROM purchase_items pi WHERE pi.order_id = po.id), 0) AS received_value,
         COALESCE((SELECT SUM(i.total) FROM purchase_invoices i JOIN purchase_invoice_orders o ON o.invoice_id = i.id WHERE o.order_id = po.id AND i.status <> 'void'), 0) AS invoiced,
         COALESCE((SELECT SUM(pi.qty_received)::numeric / NULLIF(SUM(pi.qty_ordered), 0) FROM purchase_items pi WHERE pi.order_id = po.id), 0) AS received_ratio,
         COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp WHERE sp.order_id = po.id AND NOT sp.voided), 0) AS paid
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id ${where} ORDER BY po.id DESC ${paged ? `LIMIT ${size} OFFSET ${(page - 1) * size}` : 'LIMIT 300'}`, params)
    if (!paged) return rows
    const { rows: tot } = await db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(po.total), 0) AS total FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id ${where}`, params)
    return { items: rows, total: tot[0].n, amount: Number(tot[0].total), page, pageSize: size, pages: Math.max(1, Math.ceil(tot[0].n / size)) }
  })

  app.get('/purchases/:id', async (req) => {
    seeOrders(req)
    return orderDetail(db, Number((req.params as any).id), can(req.user!.role, 'costs.view'))
  })

  app.post('/purchases', async (req, reply) => {
    requirePerm(req, 'purchases.write')
    const b = orderBody.parse(req.body)
    const order = await withTx(db, async (tx) => {
      const { rows: sup } = await tx.query('SELECT active FROM suppliers WHERE id = $1', [b.supplierId])
      if (!sup[0]) throw new HttpError(404, 'Proveedor no encontrado')
      if (!sup[0].active) throw new HttpError(409, 'El proveedor está inactivo')
      if (b.expectedDate && b.expectedDate < (b.orderDate ?? today())) throw new HttpError(400, 'La fecha de entrega no puede ser anterior a la fecha de la orden')
      if (b.issue && !mayApprove(req)) throw new HttpError(403, 'No tenés permiso para emitir sin aprobación')
      const { rows: seq } = await tx.query(`SELECT nextval('purchase_order_seq') AS n`)
      const { rows } = await tx.query(
        `INSERT INTO purchase_orders (number, supplier_id, status, notes, user_id, payment_condition, invoice_number, invoice_date, due_date, order_date, expected_date, receiving_place, reference, extra_costs, extra_costs_note)
         VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,COALESCE($9::date, current_date),$10,$11,$12,$13,$14) RETURNING *`,
        [pad('OC', seq[0].n), b.supplierId, b.notes ?? null, req.user!.id, b.paymentCondition, b.invoiceNumber ?? null, b.invoiceDate ?? null, b.dueDate ?? null, b.orderDate ?? null, b.expectedDate ?? null, b.receivingPlace ?? null, b.reference ?? null, b.extraCosts, b.extraCostsNote ?? null])
      const t = await writeItems(tx, rows[0].id, b.items)
      await tx.query('UPDATE purchase_orders SET net = $2, tax = $3, total = $4 WHERE id = $1', [rows[0].id, t.net, t.tax, t.net + t.tax + b.extraCosts])
      await orderEvent(tx, req, rows[0].id, 'purchase_order.create', { number: rows[0].number })
      if (b.issue) {
        await tx.query(`UPDATE purchase_orders SET status = 'issued', approved_by = $2, approved_at = now(), issued_at = now() WHERE id = $1`, [rows[0].id, req.user!.id])
        await orderEvent(tx, req, rows[0].id, 'purchase_order.issue')
      }
      return (await tx.query('SELECT * FROM purchase_orders WHERE id = $1', [rows[0].id])).rows[0]
    })
    return reply.code(201).send(order)
  })

  app.put('/purchases/:id', async (req) => {
    requirePerm(req, 'purchases.write')
    const id = Number((req.params as any).id)
    const b = orderBody.parse(req.body)
    return withTx(db, async (tx) => {
      const { rows } = await tx.query('SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [id])
      if (!rows[0]) throw new HttpError(404, 'Orden no encontrada')
      if (rows[0].status !== 'draft') throw new HttpError(409, 'Solo se edita una orden en borrador. Anulala y creá otra si ya se emitió.')
      await tx.query('DELETE FROM purchase_items WHERE order_id = $1', [id])
      const t = await writeItems(tx, id, b.items)
      await tx.query(
        `UPDATE purchase_orders SET supplier_id = $2, notes = $3, expected_date = $4, receiving_place = $5, reference = $6, extra_costs = $7, extra_costs_note = $8, net = $9, tax = $10, total = $11 WHERE id = $1`,
        [id, b.supplierId, b.notes ?? null, b.expectedDate ?? null, b.receivingPlace ?? null, b.reference ?? null, b.extraCosts, b.extraCostsNote ?? null, t.net, t.tax, t.net + t.tax + b.extraCosts])
      await orderEvent(tx, req, id, 'purchase_order.update')
      return orderDetail(tx, id)
    })
  })

  const transition = (path: string, from: string[], to: string, action: string, opts: { approve?: boolean; reason?: boolean; extra?: (req: any) => string } = {}) =>
    app.post(`/purchases/:id/${path}`, async (req) => {
      requirePerm(req, opts.approve ? 'purchases.approve' : 'purchases.write')
      const id = Number((req.params as any).id)
      const body = z.object({ reason: opts.reason ? z.string().trim().min(3, 'Indicá el motivo') : z.string().optional() }).parse(req.body ?? {})
      return withTx(db, async (tx) => {
        const { rows } = await tx.query('SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE', [id])
        if (!rows[0]) throw new HttpError(404, 'Orden no encontrada')
        if (!from.includes(rows[0].status)) throw new HttpError(409, `No se puede pasar de "${rows[0].status}" a "${to}"`)
        const sets = [`status = '${to}'`]
        if (to === 'pending_approval') sets.push('submitted_at = now()')
        if (to === 'approved') sets.push(`approved_by = ${req.user!.id}`, 'approved_at = now()')
        if (to === 'issued') sets.push('issued_at = now()', `approved_by = COALESCE(approved_by, ${req.user!.id})`, 'approved_at = COALESCE(approved_at, now())')
        if (to === 'cancelled') sets.push(`cancel_reason = $2`)
        if (to === 'closed_short') sets.push('close_note = $2', 'closed_at = now()')
        await tx.query(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = $1`, to === 'cancelled' || to === 'closed_short' ? [id, body.reason] : [id])
        await orderEvent(tx, req, id, `purchase_order.${action}`, { reason: body.reason })
        return { status: to }
      })
    })
  transition('submit', ['draft'], 'pending_approval', 'submit')
  transition('approve', ['pending_approval', 'draft'], 'approved', 'approve', { approve: true })
  transition('reject', ['pending_approval'], 'draft', 'reject', { approve: true, reason: true })
  transition('issue', ['approved'], 'issued', 'issue', { approve: true })
  transition('close', ['partial'], 'closed_short', 'close_short', { reason: true })
  app.post('/purchases/:id/cancel', async (req) => {
    requirePerm(req, 'purchases.write')
    const id = Number((req.params as any).id)
    const { reason } = z.object({ reason: z.string().trim().min(3, 'Indicá el motivo de la anulación') }).parse(req.body ?? {})
    return withTx(db, async (tx) => {
      const { rows } = await tx.query('SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE', [id])
      if (!rows[0]) throw new HttpError(404, 'Orden no encontrada')
      if (['received', 'closed_short', 'cancelled', 'partial'].includes(rows[0].status)) throw new HttpError(409, 'Solo se anulan órdenes que todavía no recibieron mercadería (si es parcial, cerrala)')
      const { rows: rc } = await tx.query(`SELECT 1 FROM receptions WHERE order_id = $1 AND status = 'posted' LIMIT 1`, [id])
      if (rc[0]) throw new HttpError(409, 'La orden tiene recepciones registradas')
      await tx.query(`UPDATE purchase_orders SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [id, reason])
      await orderEvent(tx, req, id, 'purchase_order.cancel', { reason })
      return { status: 'cancelled' }
    })
  })

  app.get('/purchases/:id/pdf', async (req, reply) => {
    seeOrders(req)
    const o = await orderDetail(db, Number((req.params as any).id), can(req.user!.role, 'costs.view'))
    const shop = await getSetting(db, 'shop')
    const doc = new PDFDocument({ size: 'A4', margin: 40 })
    const chunks: Buffer[] = []
    doc.on('data', (c) => chunks.push(c))
    const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))))
    const gs = (n: number) => 'Gs. ' + Math.round(Number(n)).toLocaleString('es-PY')
    doc.fontSize(16).text(shop.name ?? 'Librería Samantha', { continued: false }).fontSize(9).fillColor('#555').text(shop.address ?? '').fillColor('#000')
    doc.moveDown().fontSize(14).text(`Orden de compra ${o.number}`).fontSize(10)
    doc.text(`Proveedor: ${o.supplier_name}${o.supplier_ruc ? ' · RUC ' + o.supplier_ruc : ''}`).text(`Fecha: ${dstr(o.order_date)}   Entrega prevista: ${dstr(o.expected_date) ?? '—'}   Estado: ${o.status}`)
    if (o.receiving_place) doc.text(`Lugar de recepción: ${o.receiving_place}`)
    doc.moveDown(0.5)
    const y0 = doc.y
    doc.font('Helvetica-Bold').text('Producto', 40, y0, { width: 230 }).text('Cant.', 275, y0, { width: 40, align: 'right' }).text('Costo', 320, y0, { width: 80, align: 'right' }).text('Total', 405, y0, { width: 90, align: 'right' }).font('Helvetica')
    doc.moveTo(40, doc.y + 2).lineTo(495, doc.y + 2).stroke()
    doc.moveDown(0.4)
    for (const i of o.items as any[]) {
      const y = doc.y
      doc.text(`${i.name} (${i.presentation ?? 'unidad'} x${i.units_per_presentation})`, 40, y, { width: 230 }).text(String(i.qty_ordered), 275, y, { width: 40, align: 'right' })
      if (i.unit_cost != null) doc.text(gs(i.unit_cost), 320, y, { width: 80, align: 'right' }).text(gs(Number(i.line_net) + Number(i.line_tax)), 405, y, { width: 90, align: 'right' })
      doc.moveDown(0.3)
    }
    if (o.net != null && can(req.user!.role, 'costs.view')) {
      doc.moveDown().text(`Subtotal: ${gs(o.net)}   IVA: ${gs(o.tax)}   Costos adicionales: ${gs(o.extra_costs)}`, { align: 'right' }).font('Helvetica-Bold').text(`Total: ${gs(o.total)}`, { align: 'right' }).font('Helvetica')
    }
    if (o.notes) doc.moveDown().fontSize(9).text('Observaciones: ' + o.notes)
    doc.end()
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${o.number}.pdf"`).send(await done)
  })

  // ------------------------------------------------------------ Recepciones
  const recBody = z.object({
    items: z.array(z.object({
      orderItemId: z.number().int().nullish(), productId: z.number().int().nullish(), unitCost: z.number().int().min(0).nullish(), taxRate: z.number().int().nullish(),
      qtyReceived: z.number().int().min(0), qtyAccepted: z.number().int().min(0).optional(), qtyRejected: z.number().int().min(0).optional(),
      rejectReason: z.string().nullish(), rejectResolution: z.enum(['return', 'credit', 'replace', 'pending']).nullish(),
    })).min(1), deliveryNote: z.string().max(60).nullish(), place: z.string().max(120).nullish(), notes: z.string().max(500).nullish(), authorizeExtra: z.boolean().optional(),
  })
  app.post('/purchases/:id/receptions', async (req, reply) => {
    requirePerm(req, 'purchases.receive')
    const id = Number((req.params as any).id)
    const b = recBody.parse(req.body)
    if (b.authorizeExtra && !mayApprove(req)) throw new HttpError(403, 'Recibir de más o productos distintos requiere autorización de un responsable')
    const out = await withTx(db, async (tx) => {
      const { rows } = await tx.query('SELECT supplier_id, status FROM purchase_orders WHERE id = $1 FOR UPDATE', [id])
      if (!rows[0]) throw new HttpError(404, 'Orden no encontrada')
      if (!['issued', 'partial'].includes(rows[0].status)) throw new HttpError(409, rows[0].status === 'received' ? 'La orden ya fue recibida por completo' : `No se puede recibir una orden en estado "${rows[0].status}"`)
      return receiveGoods(tx, { orderId: id, supplierId: rows[0].supplier_id, userId: req.user!.id, lines: b.items.map((i) => ({ ...i, qtyAccepted: i.qtyAccepted, qtyRejected: i.qtyRejected })), deliveryNote: b.deliveryNote, place: b.place, notes: b.notes, allowSurplus: !!b.authorizeExtra })
    })
    const status = (await db.query('SELECT status FROM purchase_orders WHERE id = $1', [id])).rows[0].status
    return reply.code(201).send({ ...out, status })
  })
  // Compatibilidad: recepción simple por ítem (todo lo recibido se acepta).
  app.post('/purchases/:id/receive', async (req) => {
    requirePerm(req, 'purchases.receive')
    const id = Number((req.params as any).id)
    const b = z.object({ items: z.array(z.object({ itemId: z.number().int(), qty: z.number().int().positive() })).min(1), invoiceNumber: z.string().nullish() }).parse(req.body)
    await withTx(db, async (tx) => {
      const { rows } = await tx.query('SELECT supplier_id, status FROM purchase_orders WHERE id = $1 FOR UPDATE', [id])
      if (!rows[0]) throw new HttpError(404, 'Orden no encontrada')
      if (!['issued', 'partial'].includes(rows[0].status)) throw new HttpError(409, `La orden está ${rows[0].status}`)
      await receiveGoods(tx, { orderId: id, supplierId: rows[0].supplier_id, userId: req.user!.id, lines: b.items.map((i) => ({ orderItemId: i.itemId, qtyReceived: i.qty })), allowSurplus: false })
    })
    return { status: (await db.query('SELECT status FROM purchase_orders WHERE id = $1', [id])).rows[0].status }
  })

  app.get('/receptions', async (req) => {
    seeOrders(req)
    const q = req.query as Record<string, string | undefined>
    const params: unknown[] = []
    const w: string[] = []
    if (q.supplierId) { params.push(Number(q.supplierId)); w.push(`r.supplier_id = $${params.length}`) }
    if (q.orderId) { params.push(Number(q.orderId)); w.push(`r.order_id = $${params.length}`) }
    if (q.from) { params.push(q.from); w.push(`local_date(r.received_at) >= $${params.length}::date`) }
    if (q.to) { params.push(q.to); w.push(`local_date(r.received_at) <= $${params.length}::date`) }
    const { rows } = await db.query(
      `SELECT r.*, s.name AS supplier_name, po.number AS order_number, u.name AS user_name,
         (SELECT COALESCE(SUM(qty_accepted), 0) FROM reception_items WHERE reception_id = r.id)::int AS accepted, (SELECT COALESCE(SUM(qty_rejected), 0) FROM reception_items WHERE reception_id = r.id)::int AS rejected
       FROM receptions r JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN purchase_orders po ON po.id = r.order_id LEFT JOIN users u ON u.id = r.user_id
       ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY r.id DESC LIMIT 300`, params)
    return rows
  })
  app.get('/receptions/:id', async (req) => {
    seeOrders(req)
    const id = Number((req.params as any).id)
    const { rows } = await db.query(`SELECT r.*, s.name AS supplier_name, po.number AS order_number FROM receptions r JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN purchase_orders po ON po.id = r.order_id WHERE r.id = $1`, [id])
    if (!rows[0]) throw new HttpError(404, 'Recepción no encontrada')
    const { rows: items } = await db.query(`SELECT ri.*, p.name, p.code FROM reception_items ri JOIN products p ON p.id = ri.product_id WHERE ri.reception_id = $1 ORDER BY ri.id`, [id])
    return { ...rows[0], items, invoiceable: items.map((i) => ({ id: i.id, qty: invoiceable(i) })) }
  })
  app.post('/receptions/:id/void', async (req) => {
    requirePerm(req, 'purchases.approve')
    const { reason } = z.object({ reason: z.string().trim().min(3, 'Indicá el motivo') }).parse(req.body)
    await withTx(db, (tx) => voidReception(tx, req.user!.id, Number((req.params as any).id), reason))
    return { ok: true }
  })
  // Mercadería recibida y todavía sin facturar de un proveedor (para armar una factura que cubre varias órdenes).
  app.get('/suppliers/:id/uninvoiced', async (req) => {
    seeOrders(req)
    const id = Number((req.params as any).id)
    const { rows } = await db.query(
      `SELECT ri.id AS reception_item_id, r.id AS reception_id, r.number AS reception_number, r.delivery_note, po.id AS order_id, po.number AS order_number, p.id AS product_id, p.name, ri.qty_accepted, ri.invoiced_qty,
         ri.unit_cost, ri.tax_rate, ri.units_per_presentation, (ri.qty_accepted - ri.invoiced_qty - (ri.returned_qty - ri.returned_inv_qty)) AS pending
       FROM reception_items ri JOIN receptions r ON r.id = ri.reception_id AND r.status = 'posted' JOIN products p ON p.id = ri.product_id LEFT JOIN purchase_orders po ON po.id = r.order_id
       WHERE r.supplier_id = $1 AND ri.qty_accepted - ri.invoiced_qty - (ri.returned_qty - ri.returned_inv_qty) > 0 ORDER BY r.id, ri.id`, [id])
    return rows
  })

  // ------------------------------------------------------------ Facturas de compra
  const invBody = z.object({
    supplierId: z.number().int(), docType: z.enum(['invoice', 'receipt']).default('invoice'), docNumber: z.string().trim().min(1, 'Falta el número de factura').max(40), timbrado: z.string().nullish(),
    docDate: date, paymentCondition: z.enum(['cash', 'credit']).default('credit'), dueDate: date.nullish(), installments: z.array(z.object({ dueDate: date, amount: z.number().int().positive() })).optional(),
    lines: z.array(z.object({ receptionItemId: z.number().int(), qty: z.number().int().positive().optional(), unitCost: z.number().int().min(0).optional(), discount: z.number().int().min(0).optional(), taxRate: z.number().int().optional(), includesVat: z.boolean().optional() })).default([]),
    receptionIds: z.array(z.number().int()).optional(), extraCosts: z.number().int().min(0).default(0), notes: z.string().max(500).nullish(),
    directLines: z.array(z.object({ productId: z.number().int(), qty: z.number().int().positive(), unitCost: z.number().int().min(0), discount: z.number().int().min(0).default(0), taxRate: z.number().int().optional(), includesVat: z.boolean().optional() })).optional(),
    payNow: z.object({ method: z.enum(['cash', 'transfer', 'card', 'check']), accountId: z.number().int().nullish(), reference: z.string().nullish() }).optional(),
  })
  app.post('/purchase-invoices', async (req, reply) => {
    anyPerm(req, ['purchases.write', 'purchases.invoice'])
    const b = invBody.parse(req.body)
    const out = await withTx(db, async (tx) => {
      let lines = b.lines
      let direct = false
      if (b.receptionIds?.length) {
        const { rows } = await tx.query(`SELECT ri.* FROM reception_items ri JOIN receptions r ON r.id = ri.reception_id WHERE r.id = ANY($1) AND r.status = 'posted' AND r.supplier_id = $2 ORDER BY ri.id`, [b.receptionIds, b.supplierId])
        lines = [...lines, ...rows.filter((r) => invoiceable(r) > 0).map((r) => ({ receptionItemId: r.id as number }))]
      }
      if (b.directLines?.length) {
        // Compra directa sin orden: entra al stock y se factura en el mismo acto.
        direct = true
        const recLines = b.directLines.map((d) => ({
          productId: d.productId, qtyReceived: d.qty, taxRate: d.taxRate,
          unitCost: (() => { const a = lineAmounts({ qty: d.qty, unitCost: d.unitCost, discount: d.discount, taxRate: d.taxRate ?? 10, includesVat: d.includesVat }); return Math.round(a.net / d.qty) })(),
        }))
        for (const r of recLines) if (r.taxRate == null) r.taxRate = (await tx.query('SELECT tax_rate FROM products WHERE id = $1', [r.productId])).rows[0]?.tax_rate
        const rec = await receiveGoods(tx, { orderId: null, supplierId: b.supplierId, userId: req.user!.id, lines: recLines, allowSurplus: true, direct: true, notes: 'Compra directa' })
        lines = [...lines, ...rec.items.map((i: any) => ({ receptionItemId: i.id as number }))]
      }
      if (!lines.length) throw new HttpError(400, 'No hay mercadería recibida pendiente de facturar para cargar en la factura')
      const inv = await createPurchaseInvoice(tx, req.user!.id, { ...b, lines, direct })
      if (b.payNow) await paySupplier(tx, req.user!, b.supplierId, { amount: Number(inv.total), ...b.payNow, allocations: (await tx.query('SELECT id, amount FROM payables WHERE invoice_id = $1', [inv.id])).rows.map((p) => ({ payableId: p.id, amount: Number(p.amount) })) })
      return (await tx.query('SELECT * FROM purchase_invoices WHERE id = $1', [inv.id])).rows[0]
    })
    return reply.code(201).send(out)
  })

  app.get('/purchase-invoices', async (req) => {
    anyPerm(req, ['purchases.view', 'purchases.write', 'purchases.invoice'])
    const q = req.query as Record<string, string | undefined>
    const params: unknown[] = []
    const w: string[] = []
    const add = (v: unknown) => { params.push(v); return '$' + params.length }
    if (q.supplierId) w.push(`i.supplier_id = ${add(Number(q.supplierId))}`)
    if (q.status) w.push(`i.status = ${add(q.status)}`)
    if (q.from) w.push(`i.doc_date >= ${add(q.from)}::date`)
    if (q.to) w.push(`i.doc_date <= ${add(q.to)}::date`)
    if (q.q) { const l = add(`%${q.q}%`); w.push(`(i.doc_number ILIKE ${l} OR i.number ILIKE ${l} OR s.name ILIKE ${l})`) }
    const { rows } = await db.query(
      `SELECT i.*, s.name AS supplier_name, (i.total - i.paid - i.credited) AS pending,
         (SELECT string_agg(DISTINCT po.number, ', ') FROM purchase_invoice_orders o JOIN purchase_orders po ON po.id = o.order_id WHERE o.invoice_id = i.id) AS orders,
         (SELECT MIN(due_date) FROM payables WHERE invoice_id = i.id AND status = 'open' AND amount - paid - credited > 0) AS next_due
       FROM purchase_invoices i JOIN suppliers s ON s.id = i.supplier_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY i.doc_date DESC, i.id DESC LIMIT 300`, params)
    return rows
  })
  app.get('/purchase-invoices/:id', async (req) => {
    anyPerm(req, ['purchases.view', 'purchases.write', 'purchases.invoice'])
    const id = Number((req.params as any).id)
    const { rows } = await db.query('SELECT i.*, s.name AS supplier_name, s.ruc AS supplier_ruc FROM purchase_invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = $1', [id])
    if (!rows[0]) throw new HttpError(404, 'Factura no encontrada')
    const [items, payables, orders, payments, notes, files] = await Promise.all([
      db.query('SELECT * FROM purchase_invoice_items WHERE invoice_id = $1 ORDER BY id', [id]),
      db.query('SELECT *, (amount - paid - credited) AS pending FROM payables WHERE invoice_id = $1 ORDER BY number', [id]),
      db.query('SELECT po.id, po.number FROM purchase_invoice_orders o JOIN purchase_orders po ON po.id = o.order_id WHERE o.invoice_id = $1', [id]),
      db.query(`SELECT sp.id, sp.at, a.amount, sp.method, sp.reference, sp.voided FROM supplier_payment_allocations a JOIN supplier_payments sp ON sp.id = a.payment_id JOIN payables pb ON pb.id = a.payable_id WHERE pb.invoice_id = $1 ORDER BY sp.id`, [id]),
      db.query(`SELECT id, number, doc_number, amount, resolution FROM supplier_credit_notes WHERE invoice_id = $1 AND status <> 'void'`, [id]),
      db.query(`SELECT id, filename, mime, size, note, created_at FROM attachments WHERE owner_type = 'purchase_invoice' AND owner_id = $1 ORDER BY id`, [id]),
    ])
    return { ...rows[0], pending: Number(rows[0].total) - Number(rows[0].paid) - Number(rows[0].credited), items: items.rows, payables: payables.rows, orders: orders.rows, payments: payments.rows, credit_notes: notes.rows, attachments: files.rows }
  })
  app.post('/purchase-invoices/:id/void', async (req) => {
    requirePerm(req, 'purchases.approve')
    const { reason } = z.object({ reason: z.string().trim().min(3, 'Indicá el motivo') }).parse(req.body)
    await withTx(db, (tx) => voidPurchaseInvoice(tx, req.user!.id, Number((req.params as any).id), reason))
    return { ok: true }
  })

  // ------------------------------------------------------------ Devoluciones y notas de crédito
  app.get('/supplier-returns', async (req) => {
    seeOrders(req)
    const { rows } = await db.query(
      `SELECT r.*, s.name AS supplier_name, po.number AS order_number, u.name AS user_name FROM supplier_returns r JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN purchase_orders po ON po.id = r.order_id LEFT JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 300`)
    return rows
  })
  app.post('/supplier-returns', async (req, reply) => {
    requirePerm(req, 'purchases.write')
    const b = z.object({ supplierId: z.number().int(), reason: z.string().trim().min(3, 'Indicá el motivo'), orderId: z.number().int().nullish(),
      lines: z.array(z.object({ receptionItemId: z.number().int(), qty: z.number().int().positive(), condition: z.string().max(60).nullish() })).min(1) }).parse(req.body)
    return reply.code(201).send(await withTx(db, (tx) => createSupplierReturn(tx, req.user!.id, b)))
  })
  app.get('/supplier-credit-notes', async (req) => {
    seeOrders(req)
    const { rows } = await db.query(`SELECT n.*, s.name AS supplier_name, i.doc_number AS invoice_doc, r.number AS return_number FROM supplier_credit_notes n JOIN suppliers s ON s.id = n.supplier_id LEFT JOIN purchase_invoices i ON i.id = n.invoice_id LEFT JOIN supplier_returns r ON r.id = n.return_id ORDER BY n.id DESC LIMIT 300`)
    return rows
  })
  app.post('/supplier-credit-notes', async (req, reply) => {
    anyPerm(req, ['purchases.write', 'purchases.invoice', 'suppliers.pay'])
    const b = z.object({ supplierId: z.number().int(), returnId: z.number().int().nullish(), invoiceId: z.number().int().nullish(), docNumber: z.string().trim().min(1, 'Falta el número de la nota'), docDate: date,
      net: z.number().int().positive(), vat: z.number().int().min(0).default(0), resolution: z.enum(['applied', 'credit_balance', 'refund']), refundMethod: z.enum(['cash', 'transfer']).nullish(),
      refundAccountId: z.number().int().nullish(), reference: z.string().nullish(), notes: z.string().max(500).nullish() }).parse(req.body)
    return reply.code(201).send(await withTx(db, (tx) => createCreditNote(tx, req.user!, b)))
  })

  void netCost; void refreshOrderStatus
}
