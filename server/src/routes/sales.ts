import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { can, requirePerm, verifyPassword } from '../auth.js'
import { HttpError, withTx, type Db, type Tx } from '../db/client.js'
import { postReturn, postSale, reverse, saleTax } from '../accounting.js'
import { createInstallments, creditSaleDebt } from '../credit.js'
import { defaultAccount, estimateFee, needsSettlement } from '../finance.js'
import { checkReplenishment, createInvoice, getSetting, submitInvoice } from '../services.js'
import { moveStock } from '../stock.js'
import { effectivePrice, netCost, vatOf } from '../pricing.js'

const approvals = new Map<string, { userId: number; name: string; expires: number }>()
export function issueApproval(userId: number, name: string) {
  const token = randomBytes(16).toString('hex')
  approvals.set(token, { userId, name, expires: Date.now() + 5 * 60_000 })
  for (const [k, v] of approvals) if (v.expires < Date.now()) approvals.delete(k)
  return token
}
const MAX_LIMITED_DISCOUNT = 0.1 // cajeros/vendedores: hasta 10% por línea

const paymentInput = z.object({
  method: z.enum(['cash', 'card', 'qr', 'transfer', 'check', 'online', 'advance']),
  amount: z.number().int().positive(),
  // Datos propios del medio: tarjeta {type,processor,reference,last4}, QR {provider,reference,status},
  // transferencia {accountId,bank,reference}, cheque {number,bank,holder,date}
  details: z.record(z.string(), z.any()).default({}),
  reference: z.string().nullish(),
})

const saleBody = z.object({
  customerId: z.number().int().nullish(),
  items: z.array(z.object({
    productId: z.number().int(),
    qty: z.number().int().positive(),
    unitPrice: z.number().int().min(0).optional(),
    discount: z.number().int().min(0).default(0),
  })).min(1),
  discount: z.number().int().min(0).default(0),
  payments: z.array(paymentInput).default([]),
  onCredit: z.boolean().default(false),
  plan: z.object({ count: z.number().int().min(1).max(60).optional(), firstDueDays: z.number().int().min(0).max(365).optional(), intervalDays: z.number().int().min(1).max(365).optional() }).optional(),
  workOrderId: z.number().int().optional(),
  discountReason: z.string().trim().max(200).optional(),
  approvalToken: z.string().optional(),
  idempotencyKey: z.string().min(8).max(80).optional(),
})

// Valida y completa el detalle exigido por cada medio de cobro.
export function normalizePayment(p: z.infer<typeof paymentInput>) {
  const d: Record<string, any> = { ...p.details }
  if (p.method === 'card') {
    d.type = d.type === 'debit' ? 'debit' : 'credit'
  } else if (p.method === 'qr') {
    if (d.status && d.status !== 'confirmed') throw new HttpError(400, 'El pago por QR debe estar confirmado para registrar la venta')
    d.status = 'confirmed'
  } else if (p.method === 'check') {
    if (!d.number || !d.bank || !d.holder) throw new HttpError(400, 'El cheque necesita número, banco y titular')
    d.status = 'received'
    d.date ??= new Date().toISOString().slice(0, 10)
  }
  const reference = (p.reference ?? d.reference ?? d.number ?? null) as string | null
  return { method: p.method, amount: p.amount, details: d, reference: reference ? String(reference) : null }
}

export async function insertPayment(tx: Tx, o: {
  kind: 'sale' | 'customer_payment' | 'refund' | 'return'
  saleId?: number | null; customerId?: number | null; sessionId?: number | null; sessionAccountId?: number | null; userId: number
  method: string; amount: number; details?: Record<string, any>; reference?: string | null
}) {
  const details = o.details ?? {}
  const account = o.method === 'cash' ? (o.sessionAccountId ?? (await defaultAccount(tx, 'cash')))
    : o.method === 'transfer' ? (details.accountId ? Number(details.accountId) : await defaultAccount(tx, 'bank')) : null
  const positive = o.kind === 'sale' || o.kind === 'customer_payment'
  const fee = positive && needsSettlement(o.method) ? await estimateFee(tx, o.method, details, o.amount) : 0
  const { rows } = await tx.query(
    `INSERT INTO payments (kind, sale_id, customer_id, session_id, method, amount, account_id, details, reference, fee, settlement_status, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [o.kind, o.saleId ?? null, o.customerId ?? null, o.sessionId ?? null, o.method, o.amount, account, JSON.stringify(details), o.reference ?? null,
      fee, needsSettlement(o.method) ? 'pending' : 'none', o.userId])
  return rows[0].id as number
}

export async function voidSale(db: Db, id: number, user: { id: number }, reason: string) {
  let creditNoteId: number | null = null
  const out = await withTx(db, async (tx) => {
    const { rows } = await tx.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [id])
    const s = rows[0]
    if (!s) throw new HttpError(404, 'Venta no encontrada')
    if (s.status === 'void') throw new HttpError(409, 'La venta ya está anulada')
    if (Number(s.returned_total) > 0) throw new HttpError(409, 'La venta tiene devoluciones registradas: ya no puede anularse')
    const session = await openSession(tx, user.id)
    const { rows: pays } = await tx.query(
      `SELECT method, account_id, SUM(amount) AS amount FROM payments WHERE sale_id = $1 AND kind = 'sale' GROUP BY method, account_id`, [id])
    if (pays.some((p) => p.method === 'cash') && !session) throw new HttpError(409, 'Abrí la caja para devolver el efectivo')
    const { rows: items } = await tx.query('SELECT si.*, p.kind FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = $1 ORDER BY si.product_id', [id])
    for (const it of items) {
      if (it.kind !== 'product') continue
      await moveStock(tx, { productId: it.product_id, delta: it.qty, type: 'void', unitCost: it.unit_cost, refType: 'sale', refId: id, reason, userId: user.id })
    }
    await checkReplenishment(tx, items.filter((i) => i.kind === 'product').map((i) => i.product_id))
    for (const p of pays) {
      await tx.query(
        `INSERT INTO payments (kind, sale_id, customer_id, session_id, method, amount, account_id, settlement_status, user_id)
         VALUES ('refund',$1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, s.customer_id, session?.id ?? null, p.method, -Number(p.amount), p.account_id, needsSettlement(p.method) ? 'pending' : 'none', user.id])
    }
    if (s.credit_amount > 0) {
      await tx.query('UPDATE customers SET balance = balance - $2 WHERE id = $1', [s.customer_id, s.credit_amount])
      await tx.query(`INSERT INTO customer_ledger (customer_id, type, amount, sale_id, note) VALUES ($1,'void',$2,$3,$4)`,
        [s.customer_id, -s.credit_amount, id, `Anulación ${s.number}`])
      await tx.query(`UPDATE installments SET status = 'void' WHERE sale_id = $1`, [id])
    }
    await tx.query(`UPDATE sales SET status = 'void', void_reason = $2, voided_by = $3 WHERE id = $1`, [id, reason, user.id])
    await reverse(tx, 'sale', id, `Anulación ${s.number}: ${reason}`, user.id)
    const { rows: inv } = await tx.query(`SELECT * FROM invoices WHERE sale_id = $1 AND kind = 'invoice'`, [id])
    if (inv[0]) {
      creditNoteId = await createInvoice(tx, {
        saleId: id, kind: 'credit_note', relatedId: inv[0].id, customerName: inv[0].customer_name, customerRuc: inv[0].customer_ruc,
        total: inv[0].total, tax10: inv[0].tax10, tax5: inv[0].tax5, exempt: inv[0].exempt,
      })
    }
    await tx.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'sale.void','sale',$2,$3)`,
      [user.id, id, JSON.stringify({ reason })])
    return { status: 'void' }
  })
  if (creditNoteId) await submitInvoice(db, creditNoteId)
  return out
}

async function openSession(tx: Tx | Db, userId: number) {
  const { rows } = await tx.query(`SELECT * FROM cash_sessions WHERE user_id = $1 AND status = 'open'`, [userId])
  return rows[0] as { id: number; opening_float: number; account_id: number | null } | undefined
}

const returnBody = z.object({
  items: z.array(z.object({ saleItemId: z.number().int(), qty: z.number().int().positive() })).min(1),
  reason: z.string().min(3),
  restock: z.boolean().default(true),
  refundMethod: z.enum(['cash', 'transfer', 'card', 'qr']).default('cash'),
  accountId: z.number().int().nullish(),
})

// Devolución de una venta (mostrador o tienda): la usan el POS y las devoluciones de pedidos en línea.
export async function processSaleReturn(db: Db, user: { id: number }, id: number, b: z.infer<typeof returnBody>) {
    let creditNoteId: number | null = null
    const result = await withTx(db, async (tx) => {
      const { rows } = await tx.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [id])
      const s = rows[0]
      if (!s) throw new HttpError(404, 'Venta no encontrada')
      if (s.status !== 'completed') throw new HttpError(409, 'Solo se devuelven ventas vigentes')
      const { rows: items } = await tx.query(
        `SELECT si.*, p.kind, COALESCE((SELECT SUM(ri.qty) FROM sale_return_items ri WHERE ri.sale_item_id = si.id), 0)::int AS returned_qty
         FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = $1 ORDER BY si.id`, [id])
      const byId = new Map(items.map((i) => [i.id as number, i]))
      const factor = Number(s.subtotal) > 0 ? Number(s.total) / Number(s.subtotal) : 1
      const picked = b.items.map((r) => {
        const it = byId.get(r.saleItemId)
        if (!it) throw new HttpError(400, 'La línea no pertenece a la venta')
        if (r.qty > it.qty - it.returned_qty) throw new HttpError(409, `Solo se pueden devolver ${it.qty - it.returned_qty} de "${it.name}"`)
        return { it, qty: r.qty, amount: Math.round((Number(it.total) / it.qty) * r.qty * factor) }
      })
      let R = picked.reduce((a, p) => a + p.amount, 0)
      const everyUnitBack = items.every((it) => it.qty - it.returned_qty - (picked.find((p) => p.it.id === it.id)?.qty ?? 0) === 0)
      if (everyUnitBack) { // la última devolución cierra exactamente el total (sin diferencias de redondeo)
        const adj = Number(s.total) - Number(s.returned_total) - R
        picked[picked.length - 1].amount += adj
        R += adj
      }
      if (R <= 0 || Number(s.returned_total) + R > Number(s.total)) throw new HttpError(409, 'El importe a devolver supera lo vendido')

      // 1) la deuda abierta de esa venta se reduce primero; 2) el resto se reembolsa
      const applied = s.credit_amount > 0 ? await creditSaleDebt(tx, id, R) : 0
      if (applied > 0) {
        await tx.query('UPDATE customers SET balance = balance - $2 WHERE id = $1', [s.customer_id, applied])
        await tx.query(`INSERT INTO customer_ledger (customer_id, type, amount, sale_id, note) VALUES ($1,'return',$2,$3,$4)`,
          [s.customer_id, -applied, id, `Devolución en ${s.number}`])
      }
      const refund = R - applied
      const session = await openSession(tx, user.id)
      if (refund > 0 && b.refundMethod === 'cash' && !session) throw new HttpError(409, 'Abrí la caja para devolver el efectivo')

      const { rows: seq } = await tx.query(`SELECT nextval('sale_return_seq') AS n`)
      const number = `D-${String(seq[0].n).padStart(6, '0')}`
      const { rows: ret } = await tx.query(
        `INSERT INTO sale_returns (number, sale_id, user_id, session_id, reason, restock, total, applied_to_debt, refunded, refund_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [number, id, user.id, session?.id ?? null, b.reason, b.restock, R, applied, refund, refund > 0 ? b.refundMethod : null])
      const returnId = ret[0].id as number
      for (const p of picked) {
        await tx.query('INSERT INTO sale_return_items (return_id, sale_item_id, product_id, qty, amount) VALUES ($1,$2,$3,$4,$5)', [returnId, p.it.id, p.it.product_id, p.qty, p.amount])
        if (b.restock && p.it.kind === 'product') {
          await moveStock(tx, { productId: p.it.product_id, delta: p.qty, type: 'return', unitCost: Number(p.it.unit_cost), refType: 'sale_return', refId: returnId, reason: b.reason, userId: user.id })
        }
      }
      if (refund > 0) {
        await insertPayment(tx, { kind: 'return', saleId: id, customerId: s.customer_id, sessionId: session?.id ?? null, sessionAccountId: session?.account_id, userId: user.id,
          method: b.refundMethod, amount: -refund, details: b.accountId ? { accountId: b.accountId } : {} })
      }
      await tx.query('UPDATE sales SET returned_total = returned_total + $2 WHERE id = $1', [id, R])
      await postReturn(tx, {
        returnId, number, userId: user.id, total: R, restock: b.restock,
        items: picked.map((p) => ({ amount: p.amount, tax_rate: p.it.tax_rate, qty: p.qty, cost: Number(p.it.unit_cost), kind: p.it.kind })),
        settle: { applied, refunds: refund > 0 ? [{ method: b.refundMethod, amount: refund }] : [] },
      })
      const { rows: inv } = await tx.query(`SELECT * FROM invoices WHERE sale_id = $1 AND kind = 'invoice'`, [id])
      if (inv[0]) {
        const t = saleTax(picked.map((p) => ({ total: p.amount, tax_rate: p.it.tax_rate })), 0)
        creditNoteId = await createInvoice(tx, { saleId: id, kind: 'credit_note', relatedId: inv[0].id, customerName: inv[0].customer_name, customerRuc: inv[0].customer_ruc, total: R, tax10: t.tax10, tax5: t.tax5, exempt: t.exempt })
      }
      await tx.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'sale.return','sale',$2,$3)`, [user.id, id, JSON.stringify({ number, total: R, restock: b.restock, reason: b.reason })])
      return { id: returnId, number, total: R, appliedToDebt: applied, refunded: refund }
    })
    if (creditNoteId) await submitInvoice(db, creditNoteId)
    return result
}

export function salesRoutes(app: FastifyInstance, db: Db) {
  // Un responsable autoriza un descuento fuera de límite o una venta bajo costo con su propia clave (vale 5 minutos).
  app.post('/sales/authorize', async (req) => {
    requirePerm(req, 'pos.sell')
    const b = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body)
    const { rows } = await db.query('SELECT id, name, role, password_hash FROM users WHERE username = $1 AND active', [b.username])
    if (!rows[0] || !verifyPassword(b.password, rows[0].password_hash) || !can(rows[0].role, 'discount.any')) throw new HttpError(403, 'Esa persona no puede autorizar descuentos o la clave es incorrecta')
    await db.query(`INSERT INTO audit_log (user_id, action, entity, detail) VALUES ($1,'sale.authorize','sale',$2)`, [rows[0].id, JSON.stringify({ requestedBy: req.user!.id })])
    return { token: issueApproval(rows[0].id, rows[0].name), approver: rows[0].name, expiresInSeconds: 300 }
  })
  app.post('/sales', async (req, reply) => {
    requirePerm(req, 'pos.sell')
    const b = saleBody.parse(req.body)
    const user = req.user!
    const existing = async () => b.idempotencyKey ? (await db.query('SELECT * FROM sales WHERE user_id = $1 AND idempotency_key = $2', [user.id, b.idempotencyKey])).rows[0] : undefined
    const dup = await existing()
    if (dup) return reply.code(200).send({ ...dup, duplicate: true })
    let created: { sale: any; invoiceId: number | null }
    try { created = await withTx(db, async (tx) => {
      const session = await openSession(tx, user.id)
      if (!session) throw new HttpError(409, 'Abrí la caja antes de vender')

      const approver = b.approvalToken ? approvals.get(b.approvalToken) : undefined
      if (b.approvalToken && (!approver || approver.expires < Date.now())) throw new HttpError(403, 'La autorización venció: pedila de nuevo')
      const mayDiscount = can(user.role, 'discount.any') || !!approver
      let usedApproval = false
      const wo = b.workOrderId ? (await tx.query('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [b.workOrderId])).rows[0] : null
      if (b.workOrderId && (!wo || wo.status !== 'ready')) throw new HttpError(409, 'La orden de trabajo no está lista para entregar')
      if (!wo && b.payments.some((p) => p.method === 'advance')) throw new HttpError(400, 'Anticipo sin orden de trabajo')
      const ids = [...new Set(b.items.map((i) => i.productId))].sort((a, c) => a - c)
      const { rows: prods } = await tx.query('SELECT * FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids])
      const byId = new Map(prods.map((p) => [p.id as number, p]))

      // Cantidades acumuladas por producto (la misma línea puede repetirse)
      const wanted = new Map<number, number>()
      let subtotal = 0
      const lines = b.items.map((it) => {
        const p = byId.get(it.productId)
        if (!p || !p.active) throw new HttpError(400, `Producto ${it.productId} no disponible`)
        const eff = effectivePrice(p, 'local')
        const price = it.unitPrice ?? eff.price
        if (price !== eff.price && !(wo && p.code === 'IMP-SERV' && price === Number(wo.price)) && !can(user.role, 'price.override')) throw new HttpError(403, 'No podés cambiar el precio')
        const gross = price * it.qty
        if (it.discount > gross) throw new HttpError(400, 'Descuento mayor al importe')
        if (it.discount > gross * MAX_LIMITED_DISCOUNT && !mayDiscount) {
          throw new HttpError(403, 'Descuento superior al 10% requiere autorización')
        }
        if (p.kind === 'product') wanted.set(p.id, (wanted.get(p.id) ?? 0) + it.qty)
        const total = gross - it.discount
        // Vender por debajo del costo (neto de IVA) solo con autorización.
        const unitNet = (total - vatOf(total, p.tax_rate)) / it.qty
        if (p.kind === 'product' && unitNet < netCost(Number(p.cost), p.cost_includes_vat, p.tax_rate) && Number(p.cost) > 0 && !mayDiscount) {
          throw new HttpError(403, `"${p.name}" quedaría por debajo del costo: requiere autorización`)
        }
        subtotal += total
        return { p, qty: it.qty, price, discount: it.discount, belowCost: p.kind === 'product' && Number(p.cost) > 0 && unitNet < netCost(Number(p.cost), p.cost_includes_vat, p.tax_rate), total, list: Number(p.price), promo: eff.onOffer && price === eff.price ? eff.label : null }
      })
      for (const [pid, qty] of wanted) {
        const p = byId.get(pid)!
        if (p.stock - p.reserved < qty) throw new HttpError(409, `Stock insuficiente de "${p.name}" (disponible ${p.stock - p.reserved})`)
      }
      if (b.discount > subtotal) throw new HttpError(400, 'Descuento mayor al total')
      if (b.discount > subtotal * MAX_LIMITED_DISCOUNT && !mayDiscount) {
        throw new HttpError(403, 'Descuento superior al 10% requiere autorización')
      }
      const total = subtotal - b.discount
      const needsAuth = b.discount > subtotal * MAX_LIMITED_DISCOUNT || lines.some((l) => l.discount > l.price * l.qty * MAX_LIMITED_DISCOUNT) || lines.some((l) => l.belowCost)
      if (needsAuth && !can(user.role, 'discount.any')) {
        if (!b.discountReason || b.discountReason.length < 3) throw new HttpError(400, 'Indicá el motivo del descuento autorizado')
        usedApproval = true
      }
      const discPct = subtotal + b.discount > 0 ? Math.round((b.discount / (subtotal + b.discount)) * 10000) / 100 : 0

      // Pagos combinados, vuelto y crédito (la venta a crédito es una condición: el saldo se cobra después, por cualquier medio)
      const given = b.payments.filter((p) => p.method !== 'advance').map(normalizePayment)
      if (wo && Number(wo.deposit) > 0) given.push({ method: 'advance', amount: Math.min(Number(wo.deposit), total), details: {}, reference: null })
      const tendered = given.reduce((s, p) => s + p.amount, 0)
      let credit = 0
      let change = 0
      const payments = given.map((p) => ({ ...p }))
      if (tendered < total) {
        if (!b.onCredit) throw new HttpError(400, 'El pago no cubre el total')
        credit = total - tendered
      } else if (tendered > total) {
        change = tendered - total
        const cash = payments.find((p) => p.method === 'cash')
        if (!cash || cash.amount < change) throw new HttpError(400, 'El exceso solo puede devolverse como vuelto en efectivo')
        cash.amount -= change
        cash.details = { ...cash.details, received: cash.amount + change, change }
      }
      const paid = tendered - change
      if (credit > 0) {
        if (!b.customerId) throw new HttpError(400, 'La venta a crédito requiere cliente')
        const { rows: c } = await tx.query('SELECT * FROM customers WHERE id = $1 AND active FOR UPDATE', [b.customerId])
        if (!c[0]) throw new HttpError(404, 'Cliente no encontrado')
        if (Number(c[0].balance) + credit > Number(c[0].credit_limit)) {
          throw new HttpError(409, `Supera el límite de crédito (${c[0].credit_limit}); saldo actual ${c[0].balance}`)
        }
      }

      const { rows: seq } = await tx.query(`SELECT nextval('sale_number_seq') AS n`)
      const number = `V-${String(seq[0].n).padStart(6, '0')}`
      const { rows: s } = await tx.query(
        `INSERT INTO sales (number, customer_id, user_id, session_id, subtotal, discount, total, paid, credit_amount, change_given, discount_kind, discount_pct, discount_reason, discount_approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [number, b.customerId ?? null, user.id, session.id, subtotal, b.discount, total, paid, credit, change, b.discount > 0 ? 'amount' : null, b.discount > 0 ? discPct : null, b.discountReason ?? null, usedApproval ? approver!.userId : null])
      if (b.idempotencyKey) await tx.query('UPDATE sales SET idempotency_key = $2 WHERE id = $1', [s[0].id, b.idempotencyKey])
      const saleId = s[0].id as number

      for (const l of lines) {
        await tx.query(
          `INSERT INTO sale_items (sale_id, product_id, name, qty, unit_price, unit_cost, discount, tax_rate, total, list_price, promo_label, discount_kind)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [saleId, l.p.id, l.p.name, l.qty, l.price, netCost(Number(l.p.cost), l.p.cost_includes_vat, l.p.tax_rate), l.discount, l.p.tax_rate, l.total, l.list, l.promo, l.discount > 0 ? 'manual' : l.promo ? 'offer' : null])
        if (l.discount > 0) await tx.query('UPDATE sale_items SET discount_pct = $2 WHERE sale_id = $1 AND product_id = $3', [saleId, Math.round((l.discount / (l.price * l.qty)) * 10000) / 100, l.p.id])
        if (l.p.kind === 'product') {
          await moveStock(tx, { productId: l.p.id, delta: -l.qty, type: 'sale', unitCost: Number(l.p.cost), refType: 'sale', refId: saleId, userId: user.id })
        }
      }
      for (const p of payments) {
        await insertPayment(tx, { kind: 'sale', saleId, customerId: b.customerId, sessionId: session.id, sessionAccountId: session.account_id, userId: user.id, ...p })
      }
      if (credit > 0) {
        await tx.query('UPDATE customers SET balance = balance + $2 WHERE id = $1', [b.customerId, credit])
        await tx.query(`INSERT INTO customer_ledger (customer_id, type, amount, sale_id, note) VALUES ($1,'charge',$2,$3,$4)`,
          [b.customerId, credit, saleId, `Venta ${number}`])
        await createInstallments(tx, { saleId, customerId: b.customerId!, amount: credit, plan: b.plan })
      }
      if (wo) await tx.query(`UPDATE work_orders SET status = 'delivered', sale_id = $2 WHERE id = $1`, [wo.id, saleId])
      const taxes = await postSale(tx, {
        saleId, number, userId: user.id, payments, credit, total, discount: b.discount,
        items: lines.map((l) => ({ total: l.total, tax_rate: l.p.tax_rate, qty: l.qty, cost: Number(l.p.cost), kind: l.p.kind })),
      })
      let invoiceId: number | null = null
      if ((await getSetting(tx, 'invoice')).enabled) {
        const { rows: cu } = b.customerId ? await tx.query('SELECT name, ruc FROM customers WHERE id = $1', [b.customerId]) : { rows: [] as any[] }
        invoiceId = await createInvoice(tx, {
          saleId, customerName: cu[0]?.name ?? 'Consumidor final', customerRuc: cu[0]?.ruc ?? null, total,
          tax10: taxes.tax10, tax5: taxes.tax5, exempt: taxes.exempt,
        })
      }
      await checkReplenishment(tx, [...wanted.keys()])
      return { sale: s[0], invoiceId }
    }) } catch (e: any) {
      // Dos envíos simultáneos de la misma venta: gana uno y el otro devuelve la venta ya registrada.
      if (e.code === '23505' && String(e.constraint ?? e.message).includes('sales_idem')) { const again = await existing(); if (again) return reply.code(200).send({ ...again, duplicate: true }) }
      throw e
    }
    const { sale, invoiceId } = created
    let invoice = null
    if (invoiceId) { await submitInvoice(db, invoiceId); invoice = (await db.query('SELECT id, kind, number, provider_number, status, cdc, error FROM invoices WHERE id = $1', [invoiceId])).rows[0] ?? null }
    return reply.code(201).send({ ...sale, invoice })
  })

  app.get('/sales', async (req) => {
    requirePerm(req, 'pos.sell')
    const { from, to, limit } = req.query as Record<string, string | undefined>
    const { rows } = await db.query(
      `SELECT s.*, c.name AS customer_name, u.name AS user_name,
         CASE WHEN s.returned_total = 0 THEN 'none' WHEN s.returned_total >= s.total THEN 'full' ELSE 'partial' END AS return_status
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id JOIN users u ON u.id = s.user_id
       WHERE ($1::timestamptz IS NULL OR s.created_at >= $1) AND ($2::timestamptz IS NULL OR s.created_at < $2)
       ORDER BY s.id DESC LIMIT $3`, [from ?? null, to ?? null, Math.min(Number(limit) || 50, 500)])
    return rows
  })

  app.get('/sales/:id', async (req) => {
    requirePerm(req, 'pos.sell')
    const id = Number((req.params as any).id)
    const { rows } = await db.query(
      `SELECT s.*, c.name AS customer_name, u.name AS user_name,
         CASE WHEN s.returned_total = 0 THEN 'none' WHEN s.returned_total >= s.total THEN 'full' ELSE 'partial' END AS return_status
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id JOIN users u ON u.id = s.user_id WHERE s.id = $1`, [id])
    if (!rows[0]) throw new HttpError(404, 'Venta no encontrada')
    const { rows: items } = await db.query(
      `SELECT si.*, COALESCE((SELECT SUM(ri.qty) FROM sale_return_items ri WHERE ri.sale_item_id = si.id), 0)::int AS returned_qty
       FROM sale_items si WHERE si.sale_id = $1 ORDER BY si.id`, [id])
    const { rows: payments } = await db.query('SELECT * FROM payments WHERE sale_id = $1 ORDER BY id', [id])
    const { rows: installments } = await db.query('SELECT * FROM installments WHERE sale_id = $1 ORDER BY number', [id])
    const { rows: returns } = await db.query(
      `SELECT r.*, u.name AS user_name FROM sale_returns r JOIN users u ON u.id = r.user_id WHERE r.sale_id = $1 ORDER BY r.id`, [id])
    const { rows: invoices } = await db.query(
      'SELECT id, kind, number, provider_number, status, cdc, error FROM invoices WHERE sale_id = $1 ORDER BY id', [id])
    return { ...rows[0], items, payments, installments, returns, invoices }
  })

  // Anulación: repone stock, devuelve el dinero cobrado y revierte el crédito. Requiere motivo.
  app.post('/sales/:id/void', async (req) => {
    requirePerm(req, 'sale.void')
    const id = Number((req.params as any).id)
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body)
    return voidSale(db, id, req.user!, reason)
  })

  // Devolución total o parcial: ajusta venta, cobro/deuda y stock (solo si la mercadería vuelve al local).
  app.post('/sales/:id/returns', async (req, reply) => {
    requirePerm(req, 'sale.return')
    const id = Number((req.params as any).id)
    const b = returnBody.parse(req.body)
    return reply.code(201).send(await processSaleReturn(db, req.user!, id, b))
  })

  // Ventas suspendidas y presupuestos
  app.get('/held', async (req) => {
    requirePerm(req, 'pos.sell')
    return (await db.query('SELECT * FROM held_sales ORDER BY id DESC LIMIT 50')).rows
  })
  app.post('/held', async (req, reply) => {
    requirePerm(req, 'pos.sell')
    const b = z.object({ kind: z.enum(['hold', 'quote']).default('hold'), label: z.string().nullish(), cart: z.any() }).parse(req.body)
    const { rows } = await db.query('INSERT INTO held_sales (kind, label, user_id, cart) VALUES ($1,$2,$3,$4) RETURNING *',
      [b.kind, b.label, req.user!.id, JSON.stringify(b.cart)])
    return reply.code(201).send(rows[0])
  })
  app.delete('/held/:id', async (req) => {
    requirePerm(req, 'pos.sell')
    await db.query('DELETE FROM held_sales WHERE id = $1', [Number((req.params as any).id)])
    return { ok: true }
  })
}
