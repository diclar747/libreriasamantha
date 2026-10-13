import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePerm } from './auth.js'
import { HttpError, withTx, type Db, type Tx } from './db/client.js'
import { fulfillOrder, releaseReservation } from './orders.js'
import { flowFor, logOrder, notifyCustomer, stageOf, STAGE_TEXT } from './orderflow.js'
import { processSaleReturn } from './routes/sales.js'
import { getSetting, submitInvoice } from './services.js'

const dstr = (v: unknown) => (v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10))

export function decorateOrder(o: any, shop: any = {}) {
  const stage = stageOf(o)
  const now = Date.now()
  const prepH = Number(shop.prepHours ?? 24), delH = Number(shop.deliveryHours ?? 72)
  const late = (['confirmed', 'preparing'].includes(stage) && o.confirmed_at && now - new Date(o.confirmed_at).getTime() > prepH * 3600_000)
    || (stage === 'shipped' && o.dispatched_at && now - new Date(o.dispatched_at).getTime() > delH * 3600_000)
    || (['ready_pickup'].includes(stage) && o.ready_at && now - new Date(o.ready_at).getTime() > 7 * 86400_000)
  const { lookup_token: _t, ...rest } = o
  return { ...rest, stage, stage_label: STAGE_TEXT[stage].label, late: !!late, eta_date: dstr(o.eta_date) }
}

export function orderAdminRoutes2(app: FastifyInstance, db: Db) {
  const perm = (req: any) => requirePerm(req, 'orders.manage')

  app.get('/orders/counters', async (req) => {
    perm(req)
    const { rows } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status <> 'cancelled' AND confirmed_at IS NULL)::int AS pending,
         COUNT(*) FILTER (WHERE status <> 'cancelled' AND delivery_status = 'preparing')::int AS preparing,
         COUNT(*) FILTER (WHERE status <> 'cancelled' AND delivery_status IN ('ready','dispatched','incident'))::int AS to_deliver,
         COUNT(*) FILTER (WHERE payment_status = 'in_review')::int AS in_review,
         COUNT(*) FILTER (WHERE status = 'cancelled' AND payment_status = 'approved')::int AS refund_pending FROM orders`)
    const { rows: rq } = await db.query(`SELECT (SELECT COUNT(*) FROM order_returns WHERE status IN ('requested','approved','received'))::int AS returns, (SELECT COUNT(*) FROM orders WHERE cancel_requested_at IS NOT NULL AND status <> 'cancelled')::int AS cancel_requests`)
    const shop = await getSetting(db, 'shop')
    const { rows: open } = await db.query("SELECT * FROM orders WHERE status <> 'cancelled' AND delivery_status <> 'delivered'")
    return { ...rows[0], ...rq[0], late: open.filter((o) => decorateOrder(o, shop).late).length }
  })

  app.get('/orders', async (req) => {
    perm(req)
    const q = req.query as Record<string, string | undefined>
    const params: unknown[] = []
    const w: string[] = []
    const add = (v: unknown) => { params.push(v); return '$' + params.length }
    if (q.stage) {
      const m: Record<string, string> = { pending: `o.status <> 'cancelled' AND o.confirmed_at IS NULL`, confirmed: `o.status <> 'cancelled' AND o.confirmed_at IS NOT NULL AND o.delivery_status = 'pending'`, preparing: `o.status <> 'cancelled' AND o.delivery_status = 'preparing'`,
        ready: `o.status <> 'cancelled' AND o.delivery_status = 'ready'`, shipped: `o.status <> 'cancelled' AND o.delivery_status IN ('dispatched','incident')`, delivered: `o.delivery_status = 'delivered'`, cancelled: `o.status = 'cancelled'` }
      if (m[q.stage]) w.push(m[q.stage])
    }
    if (q.status) w.push(`o.status = ${add(q.status)}`)
    if (q.payment) w.push(`o.payment_status = ${add(q.payment)}`)
    if (q.delivery) w.push(`o.delivery_status = ${add(q.delivery)}`)
    if (q.method) w.push(`o.delivery_method = ${add(q.method)}`)
    if (q.payMethod) w.push(`o.payment_method = ${add(q.payMethod)}`)
    if (q.cityId) w.push(`o.city_id = ${add(Number(q.cityId))}`)
    if (q.assigned) w.push(`o.assigned_to = ${add(Number(q.assigned))}`)
    if (q.customerId) w.push(`o.customer_id = ${add(Number(q.customerId))}`)
    if (q.from) w.push(`local_date(o.created_at) >= ${add(q.from)}::date`)
    if (q.to) w.push(`local_date(o.created_at) <= ${add(q.to)}::date`)
    if (q.q) { const l = add(`%${q.q}%`); w.push(`(o.number ILIKE ${l} OR o.customer_name ILIKE ${l} OR o.phone ILIKE ${l} OR o.ruc ILIKE ${l} OR o.billing_ruc ILIKE ${l} OR o.email ILIKE ${l})`) }
    if (q.todo === '1') w.push(`(o.status <> 'cancelled' AND o.payment_status = 'approved' AND o.delivery_status IN ('pending','preparing','ready','dispatched','incident'))`)
    const where = w.length ? 'WHERE ' + w.join(' AND ') : ''
    const paged = q.page !== undefined
    const size = [15, 30, 50, 100].includes(Number(q.pageSize)) ? Number(q.pageSize) : 30
    const page = Math.max(1, Number(q.page) || 1)
    const { rows } = await db.query(
      `SELECT o.*, u.name AS assigned_name, (SELECT COALESCE(SUM(qty), 0)::int FROM order_items WHERE order_id = o.id) AS units,
         (SELECT COUNT(*) FROM payment_proofs pp WHERE pp.order_id = o.id AND pp.status = 'pending')::int AS pending_proofs,
         (SELECT COUNT(*) FROM order_returns r WHERE r.order_id = o.id AND r.status IN ('requested','approved','received'))::int AS open_returns
       FROM orders o LEFT JOIN users u ON u.id = o.assigned_to ${where} ORDER BY o.id DESC ${paged ? `LIMIT ${size} OFFSET ${(page - 1) * size}` : 'LIMIT 200'}`, params)
    const shop = await getSetting(db, 'shop')
    const items = rows.map((r) => decorateOrder(r, shop))
    if (q.late === '1') { const l = items.filter((i) => i.late); return paged ? { items: l, total: l.length, page: 1, pageSize: size, pages: 1 } : l }
    if (!paged) return items
    const { rows: tot } = await db.query(`SELECT COUNT(*)::int AS n FROM orders o ${where}`, params)
    return { items, total: tot[0].n, page, pageSize: size, pages: Math.max(1, Math.ceil(tot[0].n / size)) }
  })

  app.get('/orders/metrics', async (req) => {
    perm(req)
    const q = req.query as Record<string, string | undefined>
    const from = q.from ?? new Date(Date.now() - 3 * 3600_000 - 29 * 86400_000).toISOString().slice(0, 10)
    const to = q.to ?? new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS orders, COUNT(*) FILTER (WHERE payment_status IN ('approved','partially_refunded'))::int AS paid_orders,
         COALESCE(SUM(total) FILTER (WHERE payment_status IN ('approved','partially_refunded')), 0)::bigint AS sales, COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
         COUNT(*) FILTER (WHERE delivery_status = 'delivered')::int AS delivered,
         ROUND(AVG(EXTRACT(EPOCH FROM (ready_at - confirmed_at)) / 3600) FILTER (WHERE ready_at IS NOT NULL AND confirmed_at IS NOT NULL)::numeric, 1) AS avg_prep_hours,
         ROUND(AVG(EXTRACT(EPOCH FROM (delivered_at - dispatched_at)) / 3600) FILTER (WHERE delivered_at IS NOT NULL AND dispatched_at IS NOT NULL)::numeric, 1) AS avg_delivery_hours
       FROM orders WHERE local_date(created_at) BETWEEN $1::date AND $2::date`, [from, to])
    const { rows: byStage } = await db.query(`SELECT * FROM orders WHERE local_date(created_at) BETWEEN $1::date AND $2::date`, [from, to])
    const stages: Record<string, number> = {}
    for (const o of byStage) { const s = stageOf(o); stages[s] = (stages[s] ?? 0) + 1 }
    const shop = await getSetting(db, 'shop')
    const { rows: open } = await db.query(`SELECT * FROM orders WHERE status <> 'cancelled' AND delivery_status <> 'delivered'`)
    const { rows: rets } = await db.query(`SELECT COUNT(*)::int AS n FROM order_returns WHERE local_date(created_at) BETWEEN $1::date AND $2::date`, [from, to])
    return { from, to, ...rows[0], sales: Number(rows[0].sales), stages, late: open.filter((o) => decorateOrder(o, shop).late).length, returns: rets[0].n }
  })

  app.get('/orders/:id', async (req) => {
    perm(req)
    const id = Number((req.params as any).id)
    const { rows } = await db.query('SELECT o.*, u.name AS assigned_name FROM orders o LEFT JOIN users u ON u.id = o.assigned_to WHERE o.id = $1', [id])
    if (!rows[0]) throw new HttpError(404, 'Pedido no encontrado')
    const o = rows[0]
    const [items, attempts, proofs, history, notes, returns, invoices, deliveries, account] = await Promise.all([
      db.query('SELECT oi.*, p.image_url, p.code FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.id', [id]),
      db.query('SELECT id, provider, provider_ref, amount, status, created_at, confirmed_at FROM payment_attempts WHERE order_id = $1 ORDER BY id', [id]),
      db.query('SELECT id, status, amount_declared, reference, payer_note, review_reason, reviewed_at, created_at, account_id FROM payment_proofs WHERE order_id = $1 ORDER BY id DESC', [id]),
      db.query('SELECT h.*, u.name AS user_name, ca.first_name || \' \' || ca.last_name AS customer_name FROM order_history h LEFT JOIN users u ON u.id = h.user_id LEFT JOIN customer_accounts ca ON ca.id = h.account_id WHERE h.order_id = $1 ORDER BY h.id', [id]),
      db.query('SELECT n.*, u.name AS user_name FROM order_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.order_id = $1 ORDER BY n.id', [id]),
      db.query(`SELECT r.*, (SELECT json_agg(json_build_object('order_item_id', ri.order_item_id, 'qty', ri.qty, 'name', oi.name)) FROM order_return_items ri JOIN order_items oi ON oi.id = ri.order_item_id WHERE ri.return_id = r.id) AS items FROM order_returns r WHERE r.order_id = $1 ORDER BY r.id DESC`, [id]),
      db.query(`SELECT id, kind, number, status, total, cdc FROM invoices WHERE sale_id = $1 ORDER BY id`, [o.sale_id ?? 0]),
      db.query('SELECT * FROM delivery_attempts WHERE order_id = $1 ORDER BY id', [id]),
      o.account_id ? db.query('SELECT id, email, first_name, last_name, phone, whatsapp, document, email_verified, customer_id FROM customer_accounts WHERE id = $1', [o.account_id]) : Promise.resolve({ rows: [] as any[] }),
    ])
    const shop = await getSetting(db, 'shop')
    const d = decorateOrder(o, shop)
    return { ...d, items: items.rows, attempts: attempts.rows, proofs: proofs.rows, history: history.rows, notes: notes.rows, returns: returns.rows, invoices: invoices.rows, delivery_attempts: deliveries.rows, account: account.rows[0] ?? null,
      flow: flowFor(o.delivery_method).map((s) => ({ stage: s, label: STAGE_TEXT[s].label })) }
  })

  const loadLocked = async (tx: Tx, id: number) => {
    const { rows } = await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id])
    if (!rows[0]) throw new HttpError(404, 'Pedido no encontrado')
    return rows[0]
  }

  // Confirmar manualmente (pedidos contra entrega o revisiones del local). El pago prepago se confirma solo al aprobarse.
  app.post('/orders/:id/confirm', async (req) => {
    perm(req)
    const id = Number((req.params as any).id)
    const { note } = z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {})
    return withTx(db, async (tx) => {
      const o = await loadLocked(tx, id)
      if (o.status === 'cancelled') throw new HttpError(409, 'El pedido está cancelado')
      if (o.confirmed_at) throw new HttpError(409, 'El pedido ya está confirmado')
      if (o.payment_method !== 'cod' && o.payment_status !== 'approved') throw new HttpError(409, 'Un pedido prepago se confirma al validar el pago')
      await tx.query('UPDATE orders SET confirmed_at = now() WHERE id = $1', [id])
      await logOrder(tx, id, { kind: 'order', from: 'pending', to: 'confirmed', title: 'Pedido confirmado', note, userId: req.user!.id })
      await notifyCustomer(tx, o, { type: 'order_status', title: 'Pedido confirmado', body: STAGE_TEXT.confirmed.customer, dedupeKey: `confirmed:${id}` })
      return { stage: 'confirmed' }
    })
  })

  const deliveryBody = z.object({
    status: z.enum(['preparing', 'ready', 'dispatched', 'delivered', 'incident']),
    note: z.string().max(300).optional(), visibleNote: z.string().max(300).optional(),
    carrier: z.string().max(80).optional(), trackingNumber: z.string().max(80).optional(), trackingUrl: z.string().url().max(300).optional(),
    etaDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), dispatchedAt: z.string().optional(), deliveryCost: z.number().int().min(0).optional(),
    receivedBy: z.string().max(120).optional(), reason: z.string().max(300).optional(), rescheduleFor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  const NEXT: Record<string, string[]> = { pending: ['preparing'], preparing: ['ready', 'incident'], ready: ['dispatched', 'delivered', 'incident'], dispatched: ['delivered', 'incident'], incident: ['preparing', 'ready', 'dispatched', 'delivered'], delivered: [] }
  app.post('/orders/:id/delivery', async (req) => {
    perm(req)
    const id = Number((req.params as any).id)
    const b = deliveryBody.parse(req.body)
    const out = await withTx(db, async (tx) => {
      const o = await loadLocked(tx, id)
      if (o.status === 'cancelled') throw new HttpError(409, 'El pedido está cancelado')
      const cod = o.payment_method === 'cod'
      if (!cod && o.payment_status !== 'approved') throw new HttpError(409, 'Solo se prepara un pedido con pago aprobado')
      if (cod && !o.confirmed_at) throw new HttpError(409, 'Confirmá el pedido contra entrega antes de prepararlo')
      if (!NEXT[o.delivery_status]?.includes(b.status)) throw new HttpError(409, `No se puede pasar de ${o.delivery_status} a ${b.status}`)
      const pickup = o.delivery_method === 'pickup'
      if (b.status === 'dispatched' && pickup) throw new HttpError(409, 'Un retiro en local no se despacha')
      if (b.status === 'delivered' && !pickup && o.delivery_status === 'ready') throw new HttpError(409, 'Un delivery se despacha antes de entregarse')
      if (b.status === 'incident' && !(b.reason ?? b.note)?.trim()) throw new HttpError(400, 'Describí la incidencia')
      if (b.status === 'delivered' && !b.receivedBy?.trim()) throw new HttpError(400, pickup ? 'Indicá quién retiró' : 'Indicá quién recibió')
      if (b.status === 'dispatched' && o.delivery_status !== 'incident' && !b.etaDate && false) throw new HttpError(400, 'Falta la fecha estimada')
      const from = o.delivery_status
      let invoiceId: number | null = null
      // contra entrega: se cobra en la entrega, en la caja abierta de quien entrega
      if (b.status === 'delivered' && cod && o.payment_status !== 'approved') {
        const { rows: ses } = await tx.query(`SELECT id, account_id FROM cash_sessions WHERE user_id = $1 AND status = 'open'`, [req.user!.id])
        if (!ses[0]) throw new HttpError(409, 'Abrí tu caja para registrar el cobro contra entrega')
        const { rows: items } = await tx.query(`SELECT oi.*, p.cost, p.cost_includes_vat, p.tax_rate, p.price AS list_price FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.product_id`, [id])
        await tx.query('SELECT 1 FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE', [items.map((i) => i.product_id)])
        invoiceId = (await fulfillOrder(tx, o, items, { method: 'cash', userId: req.user!.id, sessionId: ses[0].id, sessionAccountId: ses[0].account_id, reference: 'Contra entrega' })).invoiceId
      }
      const sets = ['delivery_status = $2']
      const params: unknown[] = [id, b.status]
      const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`) }
      if (b.status === 'preparing') { sets.push('preparing_at = COALESCE(preparing_at, now())'); if (!o.assigned_to) set('assigned_to', req.user!.id) }
      if (b.status === 'ready') sets.push('ready_at = now()')
      if (b.status === 'dispatched') { set('dispatched_at', b.dispatchedAt ?? new Date().toISOString()); if (b.carrier) set('carrier', b.carrier); if (b.trackingNumber) set('tracking_number', b.trackingNumber); if (b.trackingUrl) set('tracking_url', b.trackingUrl); if (b.etaDate) set('eta_date', b.etaDate) }
      if (b.status === 'delivered') { sets.push(`status = 'completed'`, 'delivered_at = now()'); set('received_by', b.receivedBy); set('delivered_by', req.user!.id) }
      if (b.deliveryCost != null) set('delivery_cost', b.deliveryCost)
      if (b.visibleNote) set('customer_note', b.visibleNote)
      await tx.query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $1`, params)
      if (b.status === 'incident') await tx.query('INSERT INTO delivery_attempts (order_id, reason, user_id, rescheduled_for) VALUES ($1,$2,$3,$4)', [id, b.reason ?? b.note, req.user!.id, b.rescheduleFor ?? null])
      const title: Record<string, string> = { preparing: 'En preparación', ready: pickup ? 'Listo para retirar' : 'Listo para envío', dispatched: 'Enviado', delivered: pickup ? 'Retirado' : 'Entregado', incident: 'Incidencia de entrega' }
      await logOrder(tx, id, { kind: b.status === 'dispatched' ? 'shipment' : 'delivery', from, to: b.status, title: title[b.status], userId: req.user!.id, visible: true,
        note: b.status === 'incident' ? `${b.reason ?? b.note}${b.rescheduleFor ? ` · nuevo intento: ${b.rescheduleFor}` : ''}` : b.status === 'dispatched' ? [b.carrier && `Transporte: ${b.carrier}`, b.trackingNumber && `Seguimiento: ${b.trackingNumber}`, b.etaDate && `Llega aprox. el ${b.etaDate}`, b.visibleNote].filter(Boolean).join(' · ') || null : b.status === 'delivered' ? `${pickup ? 'Retiró' : 'Recibió'}: ${b.receivedBy}` : b.visibleNote ?? null })
      if (b.note && b.status !== 'incident') await tx.query('INSERT INTO order_notes (order_id, author_type, user_id, visible, note) VALUES ($1,$2,$3,false,$4)', [id, 'staff', req.user!.id, b.note])
      const copy: Record<string, [string, string, string]> = {
        preparing: ['order_status', 'En preparación', 'Estamos preparando tus productos.'],
        ready: ['order_status', pickup ? 'Listo para retirar' : 'Listo para envío', pickup ? 'Tu compra está disponible para retirar en el local.' : 'Tu pedido está preparado para despacharse.'],
        dispatched: ['delivery', 'Tu pedido va en camino', `Fue despachado${b.carrier ? ' con ' + b.carrier : ''}${b.etaDate ? ' y llega aproximadamente el ' + b.etaDate : ''}.`],
        delivered: ['delivery', pickup ? 'Compra retirada' : 'Pedido entregado', '¡Gracias por tu compra!'],
        incident: ['incident', 'Tuvimos un inconveniente con la entrega', `${b.reason ?? b.note}. Coordinamos un nuevo intento.`],
      }
      const [type, ttl, body] = copy[b.status]
      await notifyCustomer(tx, o, { type, title: ttl, body, dedupeKey: `ds:${id}:${b.status}:${o.delivery_status}:${b.status === 'incident' ? Date.now() : ''}` })
      return { delivery_status: b.status, invoiceId }
    })
    if (out.invoiceId) await submitInvoice(db, out.invoiceId)
    return out
  })

  // Cancelación (antes del despacho): libera la reserva. Si ya estaba pagado, el reembolso se registra aparte.
  async function cancelOrder(tx: Tx, o: any, userId: number | null, reason: string) {
    if (o.status === 'cancelled') throw new HttpError(409, 'El pedido ya está cancelado')
    if (['dispatched', 'delivered'].includes(o.delivery_status)) throw new HttpError(409, 'El pedido ya salió: gestioná una devolución')
    if (o.reservation_active) await releaseReservation(tx, o.id)
    await tx.query(`UPDATE orders SET status = 'cancelled', reservation_active = false, cancelled_at = now(), cancel_reason = $2, cancel_requested_at = NULL WHERE id = $1`, [o.id, reason])
    await logOrder(tx, o.id, { kind: 'order', from: o.status, to: 'cancelled', title: 'Pedido cancelado', note: reason, userId })
    await notifyCustomer(tx, o, { type: 'cancel', title: 'Pedido cancelado', body: `${reason}${o.payment_status === 'approved' ? ' Te devolveremos el importe pagado.' : ''}`, dedupeKey: `cancel:${o.id}` })
  }
  app.post('/orders/:id/cancel', async (req) => {
    perm(req)
    const id = Number((req.params as any).id)
    const { reason } = z.object({ reason: z.string().trim().min(3, 'Indicá el motivo') }).parse(req.body)
    await withTx(db, async (tx) => cancelOrder(tx, await loadLocked(tx, id), req.user!.id, reason))
    return { status: 'cancelled' }
  })
  app.post('/orders/:id/cancel-request/resolve', async (req) => {
    perm(req)
    const id = Number((req.params as any).id)
    const b = z.object({ approve: z.boolean(), response: z.string().trim().min(3) }).parse(req.body)
    await withTx(db, async (tx) => {
      const o = await loadLocked(tx, id)
      if (!o.cancel_requested_at) throw new HttpError(409, 'No hay una solicitud de cancelación')
      if (b.approve) await cancelOrder(tx, o, req.user!.id, `Cancelación solicitada por el cliente: ${o.cancel_request_reason}`)
      else {
        await tx.query('UPDATE orders SET cancel_requested_at = NULL WHERE id = $1', [id])
        await logOrder(tx, id, { kind: 'order', title: 'Cancelación no aceptada', note: b.response, userId: req.user!.id })
        await notifyCustomer(tx, o, { type: 'cancel', title: 'No pudimos cancelar tu pedido', body: b.response, dedupeKey: `cancel-no:${id}:${Date.now()}` })
      }
    })
    return { ok: true }
  })

  app.post('/orders/:id/assign', async (req) => {
    perm(req)
    const id = Number((req.params as any).id)
    const { userId } = z.object({ userId: z.number().int().nullable() }).parse(req.body)
    if (userId) { const { rows } = await db.query('SELECT 1 FROM users WHERE id = $1 AND active', [userId]); if (!rows[0]) throw new HttpError(404, 'Usuario inexistente') }
    await db.query('UPDATE orders SET assigned_to = $2 WHERE id = $1', [id, userId])
    await logOrder(db, id, { kind: 'note', title: userId ? 'Responsable asignado' : 'Responsable quitado', visible: false, userId: req.user!.id, note: userId ? `Usuario #${userId}` : null })
    return { ok: true }
  })
  app.get('/orders-staff', async (req) => { perm(req); return (await db.query('SELECT id, name, role FROM users WHERE active ORDER BY name')).rows })

  // Notas internas (solo personal) y mensajes visibles para el cliente
  app.post('/orders/:id/notes', async (req, reply) => {
    perm(req)
    const id = Number((req.params as any).id)
    const b = z.object({ note: z.string().trim().min(2).max(500), visible: z.boolean().default(false) }).parse(req.body)
    const o = (await db.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0]
    if (!o) throw new HttpError(404, 'Pedido no encontrado')
    await withTx(db, async (tx) => {
      await tx.query('INSERT INTO order_notes (order_id, author_type, user_id, visible, note) VALUES ($1,$2,$3,$4,$5)', [id, 'staff', req.user!.id, b.visible, b.note])
      if (b.visible) {
        await logOrder(tx, id, { kind: 'note', title: 'Mensaje del local', note: b.note, userId: req.user!.id })
        await notifyCustomer(tx, o, { type: 'order_status', title: 'Mensaje sobre tu pedido', body: b.note, dedupeKey: `msg:${id}:${Date.now()}` })
      }
    })
    return reply.code(201).send({ ok: true })
  })

  // ---------------------------------------------------------------- Devoluciones
  app.get('/order-returns', async (req) => {
    perm(req)
    const { status } = req.query as { status?: string }
    const { rows } = await db.query(
      `SELECT r.*, o.number AS order_number, o.customer_name, o.total AS order_total,
         (SELECT json_agg(json_build_object('name', oi.name, 'qty', ri.qty)) FROM order_return_items ri JOIN order_items oi ON oi.id = ri.order_item_id WHERE ri.return_id = r.id) AS items
       FROM order_returns r JOIN orders o ON o.id = r.order_id WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.id DESC LIMIT 200`, [status ?? null])
    return rows
  })
  const retStep = (path: string, from: string[], to: string, body: z.ZodTypeAny, fn: (tx: Tx, r: any, o: any, b: any, userId: number) => Promise<{ title: string; text: string; extra?: Record<string, unknown> } | void>) =>
    app.post(`/order-returns/:id/${path}`, async (req) => {
      perm(req)
      const id = Number((req.params as any).id)
      const b = body.parse(req.body ?? {})
      return withTx(db, async (tx) => {
        const { rows } = await tx.query('SELECT * FROM order_returns WHERE id = $1 FOR UPDATE', [id])
        const r = rows[0]
        if (!r) throw new HttpError(404, 'Devolución no encontrada')
        if (!from.includes(r.status)) throw new HttpError(409, `La devolución está en estado "${r.status}"`)
        const o = await loadLocked(tx, r.order_id)
        const res = (await fn(tx, r, o, b, req.user!.id)) ?? { title: 'Devolución actualizada', text: '' }
        await tx.query(`UPDATE order_returns SET status = $2, decided_by = $3, updated_at = now() WHERE id = $1`, [id, to, req.user!.id])
        await logOrder(tx, o.id, { kind: 'return', from: r.status, to, title: res.title, note: res.text || null, userId: req.user!.id })
        await notifyCustomer(tx, o, { type: 'returns', title: res.title, body: res.text || 'Actualizamos tu solicitud.', dedupeKey: `ret:${id}:${to}` })
        return { status: to, ...(res.extra ?? {}) }
      })
    })
  retStep('approve', ['requested'], 'approved', z.object({ response: z.string().max(300).optional(), instructions: z.string().trim().min(3, 'Indicá cómo devolver el producto').max(500) }), async (tx, r, _o, b) => {
    await tx.query('UPDATE order_returns SET admin_response = $2, instructions = $3 WHERE id = $1', [r.id, b.response ?? null, b.instructions])
    return { title: 'Devolución aprobada', text: `${b.response ? b.response + ' ' : ''}Cómo devolverlo: ${b.instructions}` }
  })
  retStep('reject', ['requested'], 'rejected', z.object({ response: z.string().trim().min(3, 'Indicá el motivo') }), async (tx, r, _o, b) => {
    await tx.query('UPDATE order_returns SET admin_response = $2 WHERE id = $1', [r.id, b.response])
    return { title: 'Devolución rechazada', text: b.response }
  })
  // La mercadería solo vuelve a stock vendible cuando se recibe y se verifica su estado
  retStep('receive', ['approved'], 'received', z.object({ restock: z.boolean(), condition: z.string().max(200).optional() }), async (tx, r, _o, b) => {
    await tx.query('UPDATE order_returns SET restock = $2 WHERE id = $1', [r.id, b.restock])
    return { title: 'Recibimos tu devolución', text: b.restock ? 'La mercadería llegó en buen estado. Registramos el reembolso a continuación.' : `La mercadería llegó con observaciones${b.condition ? ': ' + b.condition : ''}.` }
  })
}

// El reembolso mueve dinero y stock con la transacción de la venta: se ejecuta con el pool, antes de marcar la devolución como reembolsada.
export function orderRefundRoutes(app: FastifyInstance, db: Db) {
  app.post('/order-returns/:id/process-refund', async (req) => {
    requirePerm(req, 'orders.manage'); requirePerm(req, 'sale.return')
    const id = Number((req.params as any).id)
    const b = z.object({ method: z.enum(['cash', 'transfer', 'card', 'qr']).default('transfer'), accountId: z.number().int().nullish() }).parse(req.body ?? {})
    const { rows } = await db.query('SELECT r.*, o.sale_id, o.id AS oid FROM order_returns r JOIN orders o ON o.id = r.order_id WHERE r.id = $1', [id])
    const r = rows[0]
    if (!r) throw new HttpError(404, 'Devolución no encontrada')
    if (r.status !== 'received') throw new HttpError(409, 'Primero hay que recibir y verificar la mercadería')
    if (!r.sale_id) throw new HttpError(409, 'El pedido no tiene una venta asociada')
    const { rows: items } = await db.query(`SELECT ri.qty, si.id AS sale_item_id FROM order_return_items ri JOIN order_items oi ON oi.id = ri.order_item_id JOIN sale_items si ON si.sale_id = $2 AND si.product_id = oi.product_id WHERE ri.return_id = $1`, [id, r.sale_id])
    const res = await processSaleReturn(db, req.user!, r.sale_id, { items: items.map((i) => ({ saleItemId: i.sale_item_id, qty: i.qty })), reason: `Devolución de pedido en línea: ${r.reason}`, restock: !!r.restock, refundMethod: b.method, accountId: b.accountId })
    await withTx(db, async (tx) => {
      const o = await loadOrder(tx, r.oid)
      const refunded = Number(o.refunded_amount) + Number(res.total)
      await tx.query(`UPDATE order_returns SET status = 'refunded', refund_amount = $2, updated_at = now(), decided_by = $3 WHERE id = $1`, [id, res.total, req.user!.id])
      await tx.query(`UPDATE orders SET refunded_amount = $2, payment_status = CASE WHEN $2 >= total THEN 'refunded' ELSE 'partially_refunded' END WHERE id = $1`, [o.id, refunded])
      await logOrder(tx, o.id, { kind: 'payment', from: o.payment_status, to: refunded >= Number(o.total) ? 'refunded' : 'partially_refunded', title: 'Reembolso registrado', note: `Gs. ${Number(res.total).toLocaleString('es-PY')}`, userId: req.user!.id })
      await notifyCustomer(tx, o, { type: 'returns', title: 'Reembolso realizado', body: `Devolvimos Gs. ${Number(res.total).toLocaleString('es-PY')} por los productos devueltos.`, dedupeKey: `ref:${id}` })
    })
    return { refunded: res.total }
  })
}
async function loadOrder(tx: Tx, id: number) { return (await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id])).rows[0] }
