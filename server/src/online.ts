import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePerm } from './auth.js'
import { deliveryConfig, promoActive, quoteCity } from './delivery.js'
import { HttpError, withTx, type Db } from './db/client.js'
import { notify } from './notifications.js'
import { logOrder, notifyCustomer } from './orderflow.js'
import { fulfillOrder } from './orders.js'
import { isMock } from './payments.js'
import { createInvoice, enqueue, getSetting, submitInvoice } from './services.js'

const publicAccount = 'id, name, bank_name, account_number, holder, holder_document, account_type, alias, instructions, is_demo'

// ---------------------------------------------------------------- Público: ciudades, tarifas, medios de pago y comprobantes
export function onlineShopRoutes(app: FastifyInstance, db: Db) {
  // Ciudades con delivery: TODAS las del catálogo (con la tarifa general) salvo las que el local desactivó.
  app.get('/cities', async (req) => {
    const { q, department } = req.query as Record<string, string | undefined>
    const cfg = await deliveryConfig(db)
    if (!cfg.enabled) return []
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.department, COALESCE(r.price, $3::bigint) AS fee, COALESCE(r.eta, $4::text) AS eta, COALESCE(r.free_mode, 'global') AS free_mode
       FROM geo_cities c LEFT JOIN delivery_rates r ON r.city_id = c.id
       WHERE c.active AND COALESCE(r.covered, true) AND ($1::text IS NULL OR c.name ILIKE $1) AND ($2::text IS NULL OR c.department = $2)
       ORDER BY c.department = 'Capital' DESC, c.department, c.name LIMIT 400`,
      [q ? `%${q}%` : null, department ?? null, cfg.baseFee, cfg.defaultEta])
    return rows.map((r) => ({ id: r.id, name: r.name, department: r.department, covered: true, fee: Number(r.fee), eta: r.eta, freeMode: r.free_mode }))
  })
  app.get('/delivery/info', async () => {
    const c = await deliveryConfig(db)
    return { enabled: c.enabled, baseFee: c.baseFee, freeFrom: promoActive(c) ? c.freeFrom : null, promoEnd: promoActive(c) ? c.promoEnd : null, defaultEta: c.defaultEta }
  })
  // Cotización para el checkout: el cliente solo pide el costo; el importe real lo vuelve a calcular el servidor al crear el pedido.
  app.get('/delivery/quote', async (req) => {
    const { cityId, zone, subtotal } = req.query as Record<string, string | undefined>
    if (!cityId) throw new HttpError(400, 'Falta la ciudad')
    const sub = subtotal !== undefined && subtotal !== '' && Number.isFinite(Number(subtotal)) ? Math.max(0, Math.round(Number(subtotal))) : undefined
    const c = await quoteCity(db, Number(cityId), zone, sub)
    return { cityId: c.cityId, city: c.city, department: c.department, covered: c.covered, fee: c.covered ? c.fee : null, baseFee: c.covered ? c.baseFee : null, free: c.freeReason !== null, freeReason: c.freeReason, freeFrom: c.freeFrom, missingForFree: c.missingForFree, eta: c.eta, notes: c.notes, specialZones: c.specialZones }
  })
  app.get('/payment-options', async () => {
    const { rows } = await db.query(`SELECT ${publicAccount} FROM money_accounts WHERE kind = 'bank' AND active AND online_enabled ORDER BY id`)
    const shop = await getSetting(db, 'shop')
    return { card: { enabled: true, demo: isMock() }, cod: { enabled: !!shop.codEnabled }, transfer: { enabled: rows.length > 0, accounts: rows, reserveHours: Number(shop.transferReserveHours ?? 24) } }
  })

  // El cliente sube el comprobante de su transferencia; el pedido queda "en revisión" con el stock reservado.
  app.post('/orders/:number/proof', async (req, reply) => {
    const b = z.object({
      token: z.string(), accountId: z.number().int().nullish(), amount: z.number().int().positive().nullish(), reference: z.string().max(80).nullish(), note: z.string().max(300).nullish(),
      filename: z.string().min(1).max(160), mime: z.string(), dataBase64: z.string().min(8),
    }).parse(req.body)
    if (!/^(image\/(png|jpe?g|webp)|application\/pdf)$/.test(b.mime)) throw new HttpError(400, 'Subí una imagen (PNG, JPG, WEBP) o un PDF')
    const data = Buffer.from(b.dataBase64.replace(/^data:[^,]+,/, ''), 'base64')
    if (data.length > 5 * 1024 * 1024) throw new HttpError(413, 'El archivo supera los 5 MB')
    if (data.length < 100) throw new HttpError(400, 'El archivo está vacío o dañado')
    const out = await withTx(db, async (tx) => {
      const { rows } = await tx.query('SELECT * FROM orders WHERE number = $1 FOR UPDATE', [(req.params as any).number])
      const o = rows[0]
      if (!o || o.lookup_token !== b.token) throw new HttpError(404, 'Pedido no encontrado')
      if (o.payment_method !== 'transfer') throw new HttpError(409, 'Este pedido se paga con tarjeta')
      if (o.status === 'cancelled') throw new HttpError(409, 'El pedido venció o fue cancelado. Hacé uno nuevo.')
      if (['approved', 'refunded', 'partially_refunded'].includes(o.payment_status)) throw new HttpError(409, 'El pago de este pedido ya fue confirmado')
      if (o.payment_status === 'in_review') throw new HttpError(409, 'Ya tenemos tu comprobante en revisión')
      if (b.accountId) {
        const { rows: a } = await tx.query(`SELECT 1 FROM money_accounts WHERE id = $1 AND kind = 'bank' AND active AND online_enabled`, [b.accountId])
        if (!a[0]) throw new HttpError(400, 'Cuenta de destino inválida')
      }
      const { rows: pr } = await tx.query(
        `INSERT INTO payment_proofs (order_id, account_id, amount_declared, reference, payer_note) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [o.id, b.accountId ?? null, b.amount ?? null, b.reference ?? null, b.note ?? null])
      const { rows: att } = await tx.query(
        `INSERT INTO attachments (owner_type, owner_id, filename, mime, size, data, note) VALUES ('payment_proof',$1,$2,$3,$4,$5,$6) RETURNING id`, [pr[0].id, b.filename, b.mime, data.length, data, 'Comprobante del cliente'])
      await tx.query('UPDATE payment_proofs SET attachment_id = $2 WHERE id = $1', [pr[0].id, att[0].id])
      await tx.query(`UPDATE orders SET payment_status = 'in_review' WHERE id = $1`, [o.id])
      await logOrder(tx, o.id, { kind: 'payment', from: o.payment_status, to: 'in_review', title: 'Comprobante recibido', note: 'Lo estamos revisando', accountId: o.account_id })
      await notifyCustomer(tx, o, { type: 'payment', title: 'Recibimos tu comprobante', body: 'Lo revisamos y te avisamos cuando confirmemos el pago.', dedupeKey: `proof:${pr[0].id}` })
      return { proofId: pr[0].id as number, order: o }
    })
    await notify(db, { type: 'proof_review', title: `Comprobante para revisar: ${out.order.number}`, body: `${out.order.customer_name} · Gs. ${Number(out.order.total).toLocaleString('es-PY')} · transferencia`, link: '/orders?tab=proofs', dedupeKey: `proof:${out.proofId}` }).catch(() => {})
    return reply.code(201).send({ status: 'in_review', message: 'Recibimos tu comprobante. Lo revisamos y te avisamos por WhatsApp.' })
  })
}

// ---------------------------------------------------------------- Administración: tarifas por ciudad, comprobantes y panel de pedidos
export function onlineAdminRoutes(app: FastifyInstance, db: Db) {
  // ---- Revisión de comprobantes de transferencia
  app.get('/payment-proofs', async (req) => {
    requirePerm(req, 'orders.manage')
    const { status } = req.query as { status?: string }
    const { rows } = await db.query(
      `SELECT pp.*, o.number AS order_number, o.customer_name, o.phone, o.total, o.payment_status, ma.name AS account_name, u.name AS reviewed_by_name
       FROM payment_proofs pp JOIN orders o ON o.id = pp.order_id LEFT JOIN money_accounts ma ON ma.id = pp.account_id LEFT JOIN users u ON u.id = pp.reviewed_by
       WHERE ($1::text IS NULL OR pp.status = $1) ORDER BY (pp.status = 'pending') DESC, pp.id DESC LIMIT 200`, [status ?? null])
    return rows
  })
  app.get('/payment-proofs/:id/file', async (req, reply) => {
    requirePerm(req, 'orders.manage')
    const { rows } = await db.query('SELECT a.filename, a.mime, a.data FROM payment_proofs pp JOIN attachments a ON a.id = pp.attachment_id WHERE pp.id = $1', [Number((req.params as any).id)])
    if (!rows[0]) throw new HttpError(404, 'Comprobante no encontrado')
    return reply.header('content-type', rows[0].mime).header('content-disposition', `inline; filename="${encodeURIComponent(rows[0].filename)}"`).send(rows[0].data)
  })
  app.post('/payment-proofs/:id/approve', async (req) => {
    requirePerm(req, 'orders.manage')
    const id = Number((req.params as any).id)
    const b = z.object({ amountReceived: z.number().int().positive().optional(), reference: z.string().max(80).optional(), accountId: z.number().int().optional() }).parse(req.body ?? {})
    const out = await withTx(db, async (tx) => {
      const { rows: pr } = await tx.query(`SELECT * FROM payment_proofs WHERE id = $1 FOR UPDATE`, [id])
      const proof = pr[0]
      if (!proof) throw new HttpError(404, 'Comprobante no encontrado')
      if (proof.status !== 'pending') throw new HttpError(409, 'El comprobante ya fue revisado')
      const { rows: ord } = await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [proof.order_id])
      const order = ord[0]
      if (['approved', 'refunded'].includes(order.payment_status)) throw new HttpError(409, 'El pedido ya tiene un pago aprobado')
      if (order.status === 'cancelled') throw new HttpError(409, 'El pedido está cancelado')
      const received = b.amountReceived ?? Number(order.total)
      if (received !== Number(order.total)) throw new HttpError(409, `El importe recibido (${received}) no coincide con el total del pedido (${Number(order.total)}). Rechazá el comprobante y pedí que complete la diferencia.`)
      const accountId = b.accountId ?? proof.account_id
      if (!accountId) throw new HttpError(400, 'Indicá en qué cuenta se recibió la transferencia')
      const { rows: acc } = await tx.query(`SELECT 1 FROM money_accounts WHERE id = $1 AND kind = 'bank' AND active`, [accountId])
      if (!acc[0]) throw new HttpError(400, 'La cuenta bancaria no es válida')
      const { rows: items } = await tx.query(
        `SELECT oi.*, p.cost, p.cost_includes_vat, p.tax_rate, p.price AS list_price FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.product_id`, [order.id])
      await tx.query('SELECT 1 FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE', [items.map((i) => i.product_id)])
      if (!order.reservation_active) {
        const { rows: fresh } = await tx.query('SELECT id, stock - reserved AS available FROM products WHERE id = ANY($1)', [items.map((i) => i.product_id)])
        if (!items.every((i) => (fresh.find((f) => f.id === i.product_id)?.available ?? 0) >= i.qty)) throw new HttpError(409, 'La reserva venció y ya no hay stock suficiente: contactá al cliente para ofrecer alternativa o reembolso')
      }
      const ref = b.reference ?? proof.reference ?? null
      const { invoiceId } = await fulfillOrder(tx, order, items, { method: 'transfer', reference: ref, accountId, details: { bank: true, proofId: id }, userId: req.user!.id })
      await tx.query(`UPDATE payment_proofs SET status = 'approved', reviewed_by = $2, reviewed_at = now(), reference = COALESCE($3, reference), account_id = $4 WHERE id = $1`, [id, req.user!.id, ref, accountId])
      await tx.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'order.proof_approved','order',$2,$3)`, [req.user!.id, order.id, JSON.stringify({ proofId: id, amount: received })])
      return { invoiceId, orderId: order.id, number: order.number }
    })
    if (out.invoiceId) await submitInvoice(db, out.invoiceId)
    return { ok: true, orderId: out.orderId }
  })
  app.post('/payment-proofs/:id/reject', async (req) => {
    requirePerm(req, 'orders.manage')
    const id = Number((req.params as any).id)
    const { reason } = z.object({ reason: z.string().trim().min(3, 'Indicá el motivo del rechazo') }).parse(req.body)
    await withTx(db, async (tx) => {
      const { rows: pr } = await tx.query(`SELECT * FROM payment_proofs WHERE id = $1 FOR UPDATE`, [id])
      if (!pr[0]) throw new HttpError(404, 'Comprobante no encontrado')
      if (pr[0].status !== 'pending') throw new HttpError(409, 'El comprobante ya fue revisado')
      const { rows: ord } = await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [pr[0].order_id])
      await tx.query(`UPDATE payment_proofs SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_reason = $3 WHERE id = $1`, [id, req.user!.id, reason])
      await tx.query(`UPDATE orders SET payment_status = 'rejected' WHERE id = $1 AND payment_status = 'in_review'`, [ord[0].id])
      await logOrder(tx, ord[0].id, { kind: 'payment', from: 'in_review', to: 'rejected', title: 'Comprobante rechazado', note: reason, userId: req.user!.id })
      await notifyCustomer(tx, ord[0], { type: 'payment', title: 'No pudimos validar tu comprobante', body: `${reason}. Podés subir uno nuevo.`, dedupeKey: `proof-no:${id}` })
      await enqueue(tx, { phone: ord[0].phone, dedupeKey: `proof-rej:${id}`, body: `No pudimos validar tu comprobante del pedido ${ord[0].number}: ${reason}. Podés subir uno nuevo desde el seguimiento del pedido (tu stock sigue reservado por un tiempo).` })
      await tx.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'order.proof_rejected','order',$2,$3)`, [req.user!.id, ord[0].id, JSON.stringify({ proofId: id, reason })])
    })
    return { ok: true }
  })
  void createInvoice
}
