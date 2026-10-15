import { sortCategories } from './categories.js'
import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { ACC, post, postSale } from './accounting.js'
import { requirePerm } from './auth.js'
import { quoteCity } from './delivery.js'
import { moveStock } from './stock.js'
import { netCost } from './pricing.js'
import { logOrder, notifyCustomer } from './orderflow.js'
import { HttpError, withTx, type Db, type Tx } from './db/client.js'
import { buildConfirmation, cardAvailable, createPayment, isMock, verifyConfirmation, type Confirmation } from './payments.js'
import { createWorkOrder } from './routes/workorders.js'
import { voidSale } from './routes/sales.js'
import { checkReplenishment, createInvoice, enqueue, getSetting, submitInvoice } from './services.js'
import { notify } from './notifications.js'
import { insertPayment } from './routes/sales.js'
import { availability, effectivePrice } from './pricing.js'

export const orderInput = z.object({
  customer: z.object({ name: z.string().min(2), phone: z.string().min(6), email: z.string().nullish(), ruc: z.string().nullish() }),
  items: z.array(z.object({ productId: z.number().int(), qty: z.number().int().positive().max(1000) })).min(1),
  delivery: z.object({ method: z.enum(['pickup', 'delivery']), zoneId: z.number().int().nullish(), cityId: z.number().int().nullish(), address: z.string().max(250).nullish(), reference: z.string().max(200).nullish(), zone: z.string().max(80).nullish(), neighborhood: z.string().max(80).nullish() }),
  paymentMethod: z.enum(['bancard', 'transfer', 'cod']).default('bancard'),
  idempotencyKey: z.string().max(80).optional(),
  recipient: z.object({ name: z.string().max(120).nullish(), phone: z.string().max(40).nullish() }).optional(),
  billing: z.object({ name: z.string().max(120).nullish(), ruc: z.string().max(30).nullish() }).optional(),
  couponCode: z.string().max(40).nullish(),
})
export type OrderInput = z.infer<typeof orderInput>

// ---------------------------------------------------------------- Pedido + reserva de stock
export async function createOrder(db: Db, rawInput: z.input<typeof orderInput>, channel: 'web' | 'whatsapp' = 'web', opts: { accountId?: number } = {}) {
  const input = orderInput.parse(rawInput)
  const shop = await getSetting(db, 'shop')
  if (input.paymentMethod === 'bancard' && !cardAvailable()) throw new HttpError(409, 'El pago con tarjeta todavía no está habilitado. Elegí transferencia bancaria o pago contra entrega.')
  if (input.paymentMethod === 'cod' && !shop.codEnabled) throw new HttpError(400, 'El pago contra entrega no está habilitado')
  if (input.paymentMethod === 'cod' && input.delivery.method !== 'delivery') throw new HttpError(400, 'El pago contra entrega es solo para delivery')
  // Un reintento (doble clic, reenvío) devuelve el mismo pedido en vez de crear otro.
  const existing = async () => {
    if (!input.idempotencyKey) return null
    const { rows } = await db.query('SELECT * FROM orders WHERE idempotency_key = $1 AND account_id IS NOT DISTINCT FROM $2', [input.idempotencyKey, opts.accountId ?? null])
    return rows[0] ? { order: rows[0], payment: input.paymentMethod === 'bancard' && rows[0].payment_status === 'pending' ? await startPayment(db, rows[0].id) : null, duplicate: true as const } : null
  }
  const dup = await existing()
  if (dup) return dup
  let created: any
  try { created = await withTx(db, async (tx) => {
    let fee = 0
    let deliveryCost = 0
    let city: Awaited<ReturnType<typeof quoteCity>> | null = null
    if (input.delivery.method === 'delivery') {
      if (!input.delivery.address?.trim()) throw new HttpError(400, 'El delivery requiere la dirección de entrega')
      if (input.delivery.cityId) {
        city = await quoteCity(tx, input.delivery.cityId, input.delivery.zone)
        if (!city.covered) throw new HttpError(409, `Por ahora no hacemos entregas en ${city.city}. Podés elegir otra ciudad o retirar en el local.`)
        fee = city.fee
      } else if (input.delivery.zoneId) {
        const { rows } = await tx.query('SELECT fee, cost FROM delivery_zones WHERE id = $1 AND active', [input.delivery.zoneId])
        if (!rows[0]) throw new HttpError(400, 'Zona de entrega inválida')
        fee = Number(rows[0].fee)
        deliveryCost = Number(rows[0].cost)
      } else throw new HttpError(400, 'Elegí la ciudad de entrega')
    }
    const merged = new Map<number, number>()
    for (const i of input.items) merged.set(i.productId, (merged.get(i.productId) ?? 0) + i.qty)
    const ids = [...merged.keys()].sort((a, b) => a - b)
    const { rows: prods } = await tx.query(
      `SELECT * FROM products WHERE id = ANY($1) AND active AND online_visible AND kind = 'product' ORDER BY id FOR UPDATE`, [ids])
    if (prods.length !== ids.length) throw new HttpError(400, 'Hay productos no disponibles para la venta en línea')
    let subtotal = 0
    for (const p of prods) {
      const qty = merged.get(p.id)!
      if (p.stock - p.reserved < qty) throw new HttpError(409, `Sin stock suficiente de "${p.name}" (disponible ${p.stock - p.reserved})`)
      subtotal += effectivePrice(p, 'online').price * qty
    }
    let discount = 0
    let couponCode: string | null = null
    if (input.couponCode) {
      const c = await couponFor(tx, input.couponCode, subtotal, true)
      discount = c.discount
      couponCode = c.code
      await tx.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [c.id])
    }
    // El costo de entrega lo fija el servidor con la tarifa vigente y el importe real de la compra (no el navegador).
    if (city && input.delivery.cityId) { city = await quoteCity(tx, input.delivery.cityId, input.delivery.zone, subtotal - discount); fee = city.fee }
    for (const p of prods) await tx.query('UPDATE products SET reserved = reserved + $2 WHERE id = $1', [p.id, merged.get(p.id)])

    const { rows: seq } = await tx.query(`SELECT nextval('order_number_seq') AS n`)
    const number = `P-${String(seq[0].n).padStart(6, '0')}`
    const token = randomBytes(8).toString('hex')
    const { rows } = await tx.query(
      `INSERT INTO orders (number, channel, customer_name, phone, email, ruc, delivery_method, address, zone_id, delivery_fee, subtotal, total,
         reserve_expires_at, reservation_active, lookup_token, discount, coupon_code, delivery_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() + make_interval(mins => $13), true, $14, $15, $16, $17) RETURNING *`,
      [number, channel, input.customer.name, input.customer.phone, input.customer.email ?? null, input.customer.ruc ?? null,
        input.delivery.method, input.delivery.address ?? null, input.delivery.zoneId ?? null, fee, subtotal, subtotal - discount + fee, input.paymentMethod !== 'bancard' ? Number(shop.transferReserveHours ?? 24) * 60 : shop.reserveMinutes ?? 30, token, discount, couponCode, deliveryCost])
    await tx.query(
      `UPDATE orders SET city_id = $2, city_name = $3, department = $4, address_reference = $5, tariff_source = $6, payment_method = $7, billing_name = $8, billing_ruc = $9,
         account_id = $10, customer_id = $11, recipient_name = $12, recipient_phone = $13, neighborhood = $14, idempotency_key = $15, delivery_base_fee = $16, delivery_free_reason = $17 WHERE id = $1`,
      [rows[0].id, city?.cityId ?? null, city?.city ?? null, city?.department ?? null, input.delivery.reference ?? null, city ? city.source : input.delivery.zoneId ? 'zone' : null, input.paymentMethod, input.billing?.name ?? null, input.billing?.ruc ?? null,
        opts.accountId ?? null, opts.accountId ? (await tx.query('SELECT customer_id FROM customer_accounts WHERE id = $1', [opts.accountId])).rows[0]?.customer_id ?? null : null,
        input.recipient?.name ?? null, input.recipient?.phone ?? null, input.delivery.neighborhood ?? null, input.idempotencyKey ?? null, input.delivery.method === 'delivery' ? (city ? city.baseFee : fee) : null, city?.freeReason ?? null])
    await logOrder(tx, rows[0].id, { kind: 'order', to: 'pending', title: 'Pedido recibido', note: input.paymentMethod === 'transfer' ? 'Pago por transferencia: esperando el comprobante' : input.paymentMethod === 'cod' ? 'Pago contra entrega: pendiente de revisión' : undefined, accountId: opts.accountId })
    for (const p of prods) {
      await tx.query('INSERT INTO order_items (order_id, product_id, name, qty, unit_price) VALUES ($1,$2,$3,$4,$5)', [rows[0].id, p.id, p.name, merged.get(p.id), effectivePrice(p, 'online').price])
    }
    return (await tx.query('SELECT * FROM orders WHERE id = $1', [rows[0].id])).rows[0]
  }) } catch (e: any) {
    // Dos envíos simultáneos con la misma clave: gana uno y el otro recibe ese mismo pedido (nunca se crea uno doble).
    if (e?.code === '23505' && String(e?.constraint ?? '').includes('orders_idem')) { const d = await existing(); if (d) return d }
    throw e
  }
  const payment = input.paymentMethod === 'bancard' ? await startPayment(db, created.id) : null
  await withTx(db, (tx) => notifyCustomer(tx, created, { type: 'order_received', title: 'Recibimos tu pedido', body: 'Está pendiente de revisión.', dedupeKey: `recv:${created.id}` })).catch(() => {})
  await notify(db, { type: 'order_new', title: `Pedido nuevo ${created.number}`, body: `${created.customer_name} · Gs. ${Number(created.total).toLocaleString('es-PY')} · esperando el pago`, link: '/orders', dedupeKey: `order-new:${created.id}` }).catch(() => {})
  return { order: created, payment, duplicate: false as const }
}

// Valida un cupón contra el subtotal y calcula el descuento.
export async function couponFor(q: Db | Tx, code: string, subtotal: number, lock = false) {
  const { rows } = await q.query(
    `SELECT * FROM coupons WHERE upper(code) = upper($1) ${lock ? 'FOR UPDATE' : ''}`, [code.trim()])
  const c = rows[0]
  if (!c || !c.active) throw new HttpError(400, 'El cupón no existe o no está activo')
  if (c.valid_to && String(c.valid_to.toISOString?.().slice(0, 10) ?? c.valid_to) < new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)) throw new HttpError(400, 'El cupón está vencido')
  if (c.max_uses !== null && c.used_count >= c.max_uses) throw new HttpError(400, 'El cupón ya alcanzó su límite de usos')
  if (subtotal < Number(c.min_total)) throw new HttpError(400, `El cupón requiere una compra mínima de Gs. ${Number(c.min_total).toLocaleString('es-PY')}`)
  const discount = Math.min(c.kind === 'percent' ? Math.round((subtotal * Number(c.value)) / 100) : Number(c.value), subtotal)
  return { id: c.id as number, code: c.code as string, discount, kind: c.kind as string, value: Number(c.value) }
}

export async function startPayment(db: Db, orderId: number) {
  const { rows } = await db.query('SELECT * FROM orders WHERE id = $1', [orderId])
  const o = rows[0]
  if (!cardAvailable()) throw new HttpError(409, 'El pago con tarjeta todavía no está habilitado')
  const p = await createPayment({ orderNumber: o.number, amount: Number(o.total) })
  await db.query('INSERT INTO payment_attempts (order_id, provider, provider_ref, amount) VALUES ($1,$2,$3,$4)', [orderId, p.provider, p.ref, o.total])
  return p
}

export async function releaseExpiredReservations(db: Db) {
  const { rows } = await db.query(
    `SELECT id FROM orders WHERE reservation_active AND reserve_expires_at < now() AND payment_status IN ('pending','rejected')`)
  for (const r of rows) {
    await withTx(db, async (tx) => {
      const { rows: o } = await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [r.id])
      if (!o[0]?.reservation_active || o[0].payment_status === 'approved') return
      await releaseReservation(tx, r.id)
      await tx.query(`UPDATE orders SET status = 'cancelled', reservation_active = false WHERE id = $1`, [r.id])
    })
  }
  return rows.length
}

export async function releaseReservation(tx: Tx, orderId: number) {
  const { rows: items } = await tx.query('SELECT product_id, qty FROM order_items WHERE order_id = $1 ORDER BY product_id', [orderId])
  for (const i of items) await tx.query('UPDATE products SET reserved = GREATEST(reserved - $2, 0) WHERE id = $1', [i.product_id, i.qty])
}

// Cumplimiento: se consume el stock, se crea la venta, el asiento y la factura. Lo usan Bancard y las transferencias aprobadas.
export async function fulfillOrder(tx: Tx, order: any, items: any[], pay: { method: 'online' | 'transfer' | 'cash'; reference?: string | null; details?: Record<string, any>; accountId?: number | null; userId?: number | null; sessionId?: number | null; sessionAccountId?: number | null; keepStage?: boolean }) {
  const { rows: web } = await tx.query(`SELECT id FROM users WHERE username = 'web'`)
  const { rows: ship } = await tx.query(`SELECT id, name, tax_rate FROM products WHERE code = 'ENVIO'`)
  const { rows: seq } = await tx.query(`SELECT nextval('sale_number_seq') AS n`)
  const number = `V-${String(seq[0].n).padStart(6, '0')}`
  const total = Number(order.total)
  const { rows: s } = await tx.query(
    `INSERT INTO sales (number, user_id, channel, subtotal, discount, total, paid, customer_id) VALUES ($1,$2,'web',$3,$4,$5,$5,$6) RETURNING id`, [number, pay.userId ?? web[0].id, total + Number(order.discount), Number(order.discount), total, order.customer_id ?? null])
  const saleId = s[0].id as number
  for (const i of items) {
    const cost = netCost(Number(i.cost), i.cost_includes_vat, i.tax_rate)
    await tx.query(
      `INSERT INTO sale_items (sale_id, product_id, name, qty, unit_price, unit_cost, tax_rate, total, list_price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [saleId, i.product_id, i.name, i.qty, i.unit_price, cost, i.tax_rate, Number(i.unit_price) * i.qty, i.list_price ?? i.unit_price])
    if (order.reservation_active) await tx.query('UPDATE products SET reserved = GREATEST(reserved - $2, 0) WHERE id = $1', [i.product_id, i.qty])
    await moveStock(tx, { productId: i.product_id, delta: -i.qty, type: 'online_sale', unitCost: cost, refType: 'sale', refId: saleId, reason: `Pedido web ${order.number}`, allowNegative: true })
    i.cost = cost
  }
  if (Number(order.delivery_fee) > 0) {
    await tx.query(`INSERT INTO sale_items (sale_id, product_id, name, qty, unit_price, unit_cost, tax_rate, total) VALUES ($1,$2,$3,1,$4,0,$5,$4)`,
      [saleId, ship[0].id, ship[0].name, order.delivery_fee, ship[0].tax_rate])
  }
  const payId = await insertPayment(tx, { kind: 'sale', saleId, userId: pay.userId ?? web[0].id, sessionId: pay.sessionId ?? null, sessionAccountId: pay.sessionAccountId ?? null, method: pay.method, amount: total, reference: pay.reference ?? null, details: { ...(pay.details ?? {}), ...(pay.accountId ? { accountId: pay.accountId } : {}) } })
  const saleItems = [
    ...items.map((i) => ({ total: Number(i.unit_price) * i.qty, tax_rate: i.tax_rate, qty: i.qty, cost: Number(i.cost), kind: 'product' })),
    ...(Number(order.delivery_fee) > 0 ? [{ total: Number(order.delivery_fee), tax_rate: ship[0].tax_rate, qty: 1, cost: 0, kind: 'service' }] : []),
  ]
  const taxes = await postSale(tx, { saleId, number, payments: [{ method: pay.method, amount: total }], credit: 0, total, items: saleItems, discount: Number(order.discount) })
  let invoiceId: number | null = null
  if ((await getSetting(tx, 'invoice')).enabled) {
    invoiceId = await createInvoice(tx, { saleId, customerName: order.billing_name || order.customer_name, customerRuc: order.billing_ruc || order.ruc, total, tax10: taxes.tax10, tax5: taxes.tax5, exempt: taxes.exempt })
  }
  const wasConfirmed = !!order.confirmed_at
  await tx.query(`UPDATE orders SET payment_status = 'approved', status = 'confirmed', reservation_active = false, sale_id = $2, exception = NULL, paid_amount = total, confirmed_at = COALESCE(confirmed_at, now()) WHERE id = $1`, [order.id, saleId])
  await logOrder(tx, order.id, { kind: 'payment', from: order.payment_status, to: 'approved', title: 'Pago confirmado', note: `Importe ${total.toLocaleString('es-PY')}`, userId: pay.userId ?? null })
  if (!wasConfirmed) await logOrder(tx, order.id, { kind: 'order', from: 'pending', to: 'confirmed', title: 'Pedido confirmado', userId: pay.userId ?? null })
  await notifyCustomer(tx, order, { type: 'payment', title: 'Pago confirmado', body: `Recibimos tu pago de Gs. ${total.toLocaleString('es-PY')}. Tu pedido está confirmado.`, dedupeKey: `paid:${order.id}` })
  await checkReplenishment(tx, items.map((i) => i.product_id))
  await enqueue(tx, { phone: order.phone, dedupeKey: `paid:${order.id}`,
    body: `¡Pago confirmado! Tu pedido ${order.number} por Gs. ${total.toLocaleString('es-PY')} está en preparación. Seguimiento: ${order.lookup_token}` })
  return { saleId, invoiceId, payId }
}

// ---------------------------------------------------------------- Confirmación de pago (idempotente)
export async function processConfirmation(db: Db, c: Confirmation) {
  const o = c.operation
  const approved = o.response === 'S'
  const out = await withTx(db, async (tx) => {
    const { rows: at } = await tx.query('SELECT * FROM payment_attempts WHERE provider_ref = $1 FOR UPDATE', [o.shop_process_id])
    const attempt = at[0]
    if (!attempt) throw new HttpError(404, 'Pago desconocido')
    if (attempt.status !== 'pending') return { duplicate: true, orderId: attempt.order_id }
    if (Number(o.amount) !== Number(attempt.amount)) throw new HttpError(400, 'El importe no coincide con el pedido')
    await tx.query(`UPDATE payment_attempts SET status = $2, confirmed_at = now(), raw = $3 WHERE id = $1`, [attempt.id, approved ? 'approved' : 'rejected', JSON.stringify(c)])
    const { rows: ord } = await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [attempt.order_id])
    const order = ord[0]
    if (!approved) {
      await tx.query(`UPDATE orders SET payment_status = 'rejected' WHERE id = $1 AND payment_status = 'pending'`, [order.id])
      return { duplicate: false, orderId: order.id, invoiceId: null }
    }
    if (order.payment_status === 'approved') return { duplicate: true, orderId: order.id } // otro intento ya cobró
    const { rows: items } = await tx.query(
      `SELECT oi.*, p.cost, p.cost_includes_vat, p.tax_rate, p.stock, p.reserved FROM order_items oi JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1 ORDER BY oi.product_id`, [order.id])
    await tx.query('SELECT 1 FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE', [items.map((i) => i.product_id)])
    const shop = await getSetting(tx, 'shop')

    // Pago tardío: la reserva ya venció; hay que revisar disponibilidad antes de cumplir.
    let covered = order.reservation_active
    if (!covered) {
      const { rows: fresh } = await tx.query('SELECT id, stock - reserved AS available FROM products WHERE id = ANY($1)', [items.map((i) => i.product_id)])
      covered = items.every((i) => (fresh.find((f) => f.id === i.product_id)?.available ?? 0) >= i.qty)
    }
    if (!covered) {
      await tx.query(
        `UPDATE orders SET payment_status = 'approved', status = 'cancelled', exception = $2 WHERE id = $1`,
        [order.id, 'Pago aprobado después de vencer la reserva y sin stock disponible: reembolsar o reponer'])
      await post(tx, { description: `Pago sin cumplir ${order.number}`, refType: 'order_exception', refId: order.id,
        lines: [{ code: ACC.cards, debit: Number(order.total) }, { code: ACC.advances, credit: Number(order.total) }] })
      await enqueue(tx, { audience: 'manager', phone: shop.managerPhone || null, dedupeKey: `exc:${order.id}`,
        body: `⚠️ Pedido ${order.number}: se recibió el pago pero ya no hay stock. Requiere reembolso o reposición.` })
      await enqueue(tx, { phone: order.phone, dedupeKey: `exc-c:${order.id}`,
        body: `Recibimos tu pago del pedido ${order.number} pero el stock se agotó mientras tanto. Te vamos a contactar para ofrecerte alternativa o reembolso.` })
      return { duplicate: false, orderId: order.id, invoiceId: null }
    }

    const { invoiceId, payId } = await fulfillOrder(tx, order, items, { method: 'online', reference: o.shop_process_id, details: { provider: 'bancard', processId: o.shop_process_id } })
    const { rows: pf } = await tx.query('SELECT fee FROM payments WHERE id = $1', [payId])
    await tx.query('UPDATE payment_attempts SET fee = $2 WHERE id = $1', [attempt.id, pf[0].fee])
    return { duplicate: false, orderId: order.id, invoiceId }
  })
  if ('invoiceId' in out && out.invoiceId) await submitInvoice(db, out.invoiceId)
  if (!out.duplicate && approved) {
    const { rows } = await db.query('SELECT number, customer_name, total, exception, delivery_method FROM orders WHERE id = $1', [out.orderId])
    const o = rows[0]
    if (o?.exception) await notify(db, { type: 'order_exception', title: `Pago sin stock: ${o.number}`, body: `${o.customer_name} pagó pero ya no hay stock. Hay que reembolsar o reponer.`, link: '/orders', dedupeKey: `order-exc:${out.orderId}` }).catch(() => {})
    else if (o) await notify(db, { type: 'order_paid', title: `Pedido pagado ${o.number}`, body: `${o.customer_name} · Gs. ${Number(o.total).toLocaleString('es-PY')} · ${o.delivery_method === 'pickup' ? 'retira en el local' : 'delivery'}. A preparar.`, link: '/orders', dedupeKey: `order-paid:${out.orderId}` }).catch(() => {})
  }
  return out
}

// ---------------------------------------------------------------- Rutas públicas de la tienda
const publicProduct = `id, name, short_description, description, category, subcategory, brand, author, publisher, edition, language, price, image_url, code, tax_rate,
  offer_enabled, offer_price, offer_pct, offer_start, offer_end, offer_channel, offer_label, stock, reserved, min_stock,
  (SELECT COALESCE(json_agg(i.id ORDER BY i.position, i.id), '[]') FROM product_images i WHERE i.product_id = products.id) AS image_ids`

// Vista pública: precio vigente (oferta si corresponde) y disponibilidad, nunca cantidades de stock.
export function shopView(r: any) {
  const e = effectivePrice(r, 'online')
  const { stock, reserved, min_stock, offer_enabled, offer_price, offer_pct, offer_start, offer_end, offer_channel, offer_label, image_ids, ...rest } = r
  return { ...rest, price: e.price, list_price: e.onOffer ? e.list : null, on_offer: e.onOffer, offer_label: e.label, saving_pct: e.savingPct,
    availability: availability(stock, reserved, min_stock), images: (image_ids as number[]).map((id) => `/api/shop/img/${id}?s=full`) }
}

export function shopRoutes(app: FastifyInstance, db: Db) {
  app.get('/info', async () => ({ ...(await getSetting(db, 'shop')), managerPhone: undefined }))
  app.get('/categories', async () => sortCategories((await db.query(`SELECT category, COUNT(*)::int AS count FROM products WHERE active AND online_visible AND kind = 'product' GROUP BY 1`)).rows, (r: any) => r.category))
  app.get('/products', async (req) => {
    const { q, category } = req.query as Record<string, string | undefined>
    const { rows } = await db.query(
      `SELECT ${publicProduct} FROM products WHERE active AND online_visible AND kind = 'product'
       AND ($1::text IS NULL OR name ILIKE $1 OR author ILIKE $1 OR brand ILIKE $1 OR isbn = $2) AND ($3::text IS NULL OR category = $3)
       ORDER BY name LIMIT 100`, [q ? `%${q}%` : null, q || null, category || null])
    return rows.map(shopView)
  })
  app.get('/products/:id', async (req) => {
    const { rows } = await db.query(`SELECT ${publicProduct} FROM products WHERE id = $1 AND active AND online_visible AND kind = 'product'`, [Number((req.params as any).id)])
    if (!rows[0]) throw new HttpError(404, 'Producto no encontrado')
    const { rows: related } = await db.query(
      `SELECT ${publicProduct} FROM products WHERE active AND online_visible AND category = $1 AND id <> $2 ORDER BY random() LIMIT 4`, [rows[0].category, rows[0].id])
    return { ...shopView(rows[0]), related: related.map(shopView) }
  })
  app.get('/zones', async () => (await db.query('SELECT id, name, fee FROM delivery_zones WHERE active ORDER BY name')).rows)
  app.post('/coupons/validate', async (req) => {
    const b = z.object({ code: z.string().min(1), subtotal: z.number().int().min(0) }).parse(req.body)
    const c = await couponFor(db, b.code, b.subtotal)
    return { code: c.code, discount: c.discount }
  })
  app.get('/school-lists', async () => (await db.query('SELECT * FROM school_lists WHERE active ORDER BY school, grade')).rows)
  app.get('/school-lists/:id', async (req) => {
    const id = Number((req.params as any).id)
    const { rows: l } = await db.query('SELECT * FROM school_lists WHERE id = $1 AND active', [id])
    if (!l[0]) throw new HttpError(404, 'Lista no encontrada')
    const { rows: items } = await db.query(
      `SELECT i.qty, ${publicProduct.replace(/\bid\b/, 'p.id').replace('products.id', 'p.id')} FROM school_list_items i JOIN products p ON p.id = i.product_id WHERE i.list_id = $1 ORDER BY p.name`, [id])
    return { ...l[0], items: items.map((r) => ({ ...shopView(r), qty: r.qty })) }
  })

  app.post('/orders', async (req, reply) => reply.code(201).send(await createOrder(db, orderInput.parse(req.body))))
  app.get('/orders/:number', async (req) => {
    const { token } = req.query as { token?: string }
    const { rows } = await db.query('SELECT * FROM orders WHERE number = $1', [(req.params as any).number])
    if (!rows[0] || rows[0].lookup_token !== token) throw new HttpError(404, 'Pedido no encontrado')
    const o = rows[0]
    const { rows: items } = await db.query('SELECT name, qty, unit_price FROM order_items WHERE order_id = $1 ORDER BY id', [o.id])
    const { rows: att } = await db.query(`SELECT provider_ref FROM payment_attempts WHERE order_id = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1`, [o.id])
    return {
      number: o.number, status: o.status, payment_status: o.payment_status, delivery_status: o.delivery_status, delivery_method: o.delivery_method, payment_method: o.payment_method, city: o.city_name, address: o.address,
      transfer_accounts: o.payment_method === 'transfer' && !['approved', 'refunded'].includes(o.payment_status) && o.status !== 'cancelled'
        ? (await db.query(`SELECT id, name, bank_name, account_number, holder, holder_document, account_type, alias, instructions, is_demo FROM money_accounts WHERE kind = 'bank' AND active AND online_enabled ORDER BY id`)).rows : [],
      proof_rejected_reason: o.payment_status === 'rejected' && o.payment_method === 'transfer' ? (await db.query(`SELECT review_reason FROM payment_proofs WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [o.id])).rows[0]?.review_reason ?? null : null,
      total: Number(o.total), delivery_fee: Number(o.delivery_fee), reserve_expires_at: o.reserve_expires_at, exception: o.exception ? 'En revisión por el local' : null,
      items, pending_payment_ref: att[0]?.provider_ref ?? null,
    }
  })
  app.post('/orders/:number/retry-payment', async (req) => {
    const { token } = req.body as { token?: string }
    const { rows } = await db.query('SELECT * FROM orders WHERE number = $1', [(req.params as any).number])
    const o = rows[0]
    if (!o || o.lookup_token !== token) throw new HttpError(404, 'Pedido no encontrado')
    if (!o.reservation_active || o.payment_status === 'approved') throw new HttpError(409, 'El pedido ya no admite un nuevo pago')
    return startPayment(db, o.id)
  })

  // Datos para la pantalla de pago (en producción lo reemplaza el checkout de Bancard)
  app.get('/pay/:ref', async (req) => {
    const { rows } = await db.query(
      `SELECT pa.provider_ref, pa.amount, pa.status, o.number FROM payment_attempts pa JOIN orders o ON o.id = pa.order_id WHERE pa.provider_ref = $1`, [(req.params as any).ref])
    if (!rows[0]) throw new HttpError(404, 'Pago no encontrado')
    return { ...rows[0], mock: isMock() }
  })
  app.post('/pay/:ref/simulate', async (req) => {
    if (!isMock() || !cardAvailable()) throw new HttpError(404, 'No disponible')
    const { approved } = z.object({ approved: z.boolean() }).parse(req.body)
    const { rows } = await db.query('SELECT amount FROM payment_attempts WHERE provider_ref = $1', [(req.params as any).ref])
    if (!rows[0]) throw new HttpError(404, 'Pago no encontrado')
    return processConfirmation(db, buildConfirmation((req.params as any).ref, Number(rows[0].amount), approved))
  })
}

export function webhookRoutes(app: FastifyInstance, db: Db) {
  // Webhook de confirmación de Bancard: solo cuenta si el token coincide.
  app.post('/bancard', async (req, reply) => {
    const c = req.body as Confirmation
    if (!verifyConfirmation(c)) return reply.code(403).send({ error: 'Token inválido' })
    await processConfirmation(db, c)
    return { status: 'success' }
  })
}

// ---------------------------------------------------------------- Administración de pedidos
export function orderAdminRoutes(app: FastifyInstance, db: Db) {
  // Reembolso: anula la venta (stock, asiento, nota de crédito) o devuelve el pago de un pedido sin cumplir.
  app.post('/orders/:id/refund', async (req) => {
    requirePerm(req, 'sale.void')
    const id = Number((req.params as any).id)
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body)
    const { rows } = await db.query('SELECT * FROM orders WHERE id = $1', [id])
    const o = rows[0]
    if (!o) throw new HttpError(404, 'Pedido no encontrado')
    if (o.payment_status !== 'approved') throw new HttpError(409, 'El pedido no tiene un pago aprobado')
    if (o.sale_id) await voidSale(db, o.sale_id, req.user!, reason)
    else {
      await withTx(db, (tx) => post(tx, { description: `Reembolso ${o.number}`, refType: 'order_refund', refId: id, userId: req.user!.id,
        lines: [{ code: ACC.advances, debit: Number(o.total) }, { code: ACC.cards, credit: Number(o.total) }] }))
    }
    await db.query(`UPDATE orders SET payment_status = 'refunded', status = 'cancelled', exception = NULL, refunded_amount = total, cancelled_at = COALESCE(cancelled_at, now()), cancel_reason = COALESCE(cancel_reason, $2) WHERE id = $1`, [id, reason])
    await withTx(db, async (tx) => {
      await logOrder(tx, id, { kind: 'payment', from: 'approved', to: 'refunded', title: 'Pago reembolsado', note: reason, userId: req.user!.id })
      await notifyCustomer(tx, o, { type: 'returns', title: 'Reembolso realizado', body: 'Devolvimos el importe de tu pedido.', dedupeKey: `refund:${id}` })
    })
    return { payment_status: 'refunded' }
  })

  app.get('/delivery-zones', async (req) => {
    requirePerm(req, 'orders.manage')
    return (await db.query('SELECT * FROM delivery_zones ORDER BY name')).rows
  })
  app.post('/delivery-zones', async (req, reply) => {
    requirePerm(req, 'settings.write')
    const b = z.object({ name: z.string().min(2), fee: z.number().int().min(0), cost: z.number().int().min(0).default(0) }).parse(req.body)
    return reply.code(201).send((await db.query('INSERT INTO delivery_zones (name, fee, cost) VALUES ($1,$2,$3) RETURNING *', [b.name, b.fee, b.cost])).rows[0])
  })
  app.put('/delivery-zones/:id', async (req) => {
    requirePerm(req, 'settings.write')
    const b = z.object({ fee: z.number().int().min(0).optional(), cost: z.number().int().min(0).optional(), active: z.boolean().optional(), name: z.string().min(2).optional() }).parse(req.body)
    const { rows } = await db.query('UPDATE delivery_zones SET fee = COALESCE($2, fee), cost = COALESCE($3, cost), active = COALESCE($4, active), name = COALESCE($5, name) WHERE id = $1 RETURNING *',
      [Number((req.params as any).id), b.fee ?? null, b.cost ?? null, b.active ?? null, b.name ?? null])
    if (!rows[0]) throw new HttpError(404, 'Zona inexistente')
    return rows[0]
  })
  app.get('/coupons', async (req) => {
    requirePerm(req, 'orders.manage')
    return (await db.query('SELECT * FROM coupons ORDER BY active DESC, id DESC')).rows
  })
  app.post('/coupons', async (req, reply) => {
    requirePerm(req, 'settings.write')
    const b = z.object({ code: z.string().min(3).max(30), kind: z.enum(['percent', 'amount']), value: z.number().int().positive(), minTotal: z.number().int().min(0).default(0), maxUses: z.number().int().positive().nullish(), validTo: z.string().nullish() }).parse(req.body)
    if (b.kind === 'percent' && b.value > 100) throw new HttpError(400, 'Un porcentaje no puede superar 100')
    try {
      return reply.code(201).send((await db.query('INSERT INTO coupons (code, kind, value, min_total, max_uses, valid_to) VALUES (upper($1),$2,$3,$4,$5,$6) RETURNING *', [b.code, b.kind, b.value, b.minTotal, b.maxUses ?? null, b.validTo ?? null])).rows[0])
    } catch (e: any) { if (e.code === '23505') throw new HttpError(409, 'Ya existe un cupón con ese código'); throw e }
  })
  app.put('/coupons/:id', async (req) => {
    requirePerm(req, 'settings.write')
    const { active } = z.object({ active: z.boolean() }).parse(req.body)
    const { rows } = await db.query('UPDATE coupons SET active = $2 WHERE id = $1 RETURNING *', [Number((req.params as any).id), active])
    if (!rows[0]) throw new HttpError(404, 'Cupón inexistente')
    return rows[0]
  })
  app.post('/school-lists', async (req, reply) => {
    requirePerm(req, 'products.write')
    const b = z.object({ school: z.string().min(2), grade: z.string().min(1), year: z.number().int().default(2026),
      items: z.array(z.object({ productId: z.number().int(), qty: z.number().int().positive() })).min(1) }).parse(req.body)
    const list = await withTx(db, async (tx) => {
      const { rows } = await tx.query('INSERT INTO school_lists (school, grade, year) VALUES ($1,$2,$3) RETURNING *', [b.school, b.grade, b.year])
      for (const i of b.items) await tx.query('INSERT INTO school_list_items (list_id, product_id, qty) VALUES ($1,$2,$3)', [rows[0].id, i.productId, i.qty])
      return rows[0]
    })
    return reply.code(201).send(list)
  })
}

// Solicitud de impresión desde la web o WhatsApp: queda como presupuesto para que el encargado lo confirme antes de cobrar.
export const printRequestInput = z.object({
  customerName: z.string().min(2), phone: z.string().min(6), description: z.string().min(3),
  copies: z.number().int().positive().max(5000), pages: z.number().int().positive().max(5000), color: z.boolean().default(false),
  paper: z.string().default('A4'), finishing: z.string().nullish(), fileName: z.string().nullish(),
})
export function printRequestRoutes(app: FastifyInstance, db: Db) {
  app.post('/print-requests', async (req, reply) => {
    const b = printRequestInput.parse(req.body)
    const wo = await createWorkOrder(db, { ...b, source: 'web' })
    await notify(db, { type: 'print_request', title: `Solicitud de impresión ${wo.number}`, body: `${b.customerName}: ${b.description} (${b.copies} copias)`, link: '/workorders', dedupeKey: `wo-new-n:${wo.id}` }).catch(() => {})
    await withTx(db, (tx) => enqueue(tx, { audience: 'manager', dedupeKey: `wo-new:${wo.id}`, body: `Nueva solicitud de impresión ${wo.number}: ${b.description} (${b.copies} copias). Presupuesto estimado Gs. ${Number(wo.price).toLocaleString('es-PY')}.` }))
    return reply.code(201).send({ number: wo.number, estimatedPrice: Number(wo.price), status: wo.status })
  })
}
