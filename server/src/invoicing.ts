// Módulo de Facturación electrónica: lista y detalle de todos los comprobantes, cancelación (evento SIFEN),
// notas de crédito y de débito con motivo, corrección del receptor y re-facturación.
//
// Reglas de SIFEN que respeta (verificadas en la documentación de OñeTema, api_docs.html):
//  - Cancelación: solo documentos APROBADOS y dentro de las 48 h; motivo ≥ 5 caracteres (cancelar_api.php).
//  - Pasadas las 48 h, una factura se deja sin efecto con NOTA DE CRÉDITO por el total (motivo 1).
//  - NC/ND: mismo index.php con TIPO_DOCUMENTO, MOTIVO 1–8 (tabla E401) y FACTURA_CDC de la factura original.
//  - Un envío rechazado no consume la numeración del proveedor.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePerm } from './auth.js'
import { HttpError, withTx, type Db } from './db/client.js'
import { ACC, methodAccount, post, postReturn, saleTax } from './accounting.js'
import { creditSaleDebt } from './credit.js'
import { fetchKude } from './oietema.js'
import { getSecret } from './secrets.js'
import { CANCEL_HOURS, cancelAtProvider, cancelDeadline, createInvoice, getSetting, submitInvoice } from './services.js'
import { activeInvoice, checkVoidable, insertPayment, openSession, processSaleReturn, voidSale } from './routes/sales.js'

export const MOTIVES: Record<number, string> = {
  1: 'Devolución y ajuste de precios', 2: 'Devolución', 3: 'Descuento', 4: 'Bonificación', 5: 'Crédito incobrable',
  6: 'Recupero de costo', 7: 'Recupero de gasto', 8: 'Ajuste de precio',
}
const KIND_LABEL: Record<string, string> = { invoice: 'Factura', credit_note: 'Nota de crédito', debit_note: 'Nota de débito' }

// Datos calculados que la pantalla necesita para decidir qué acciones mostrar.
function decorate(inv: any) {
  const deadline = inv.status === 'approved' ? cancelDeadline(inv) : null
  const msLeft = deadline ? deadline - Date.now() : 0
  return {
    ...inv,
    kind_label: KIND_LABEL[inv.kind] ?? inv.kind,
    motive_label: inv.motive ? MOTIVES[inv.motive] ?? null : null,
    cancel_deadline: deadline ? new Date(deadline).toISOString() : null,
    cancel_hours_left: deadline && msLeft > 0 ? Math.floor(msLeft / 3600_000) : 0,
    // Una factura con notas de crédito/débito vigentes ya no se cancela (se ajusta con notas).
    cancel_window_open: inv.kind === 'invoice' && !!deadline && msLeft > 0 && !inv.has_notes,
  }
}

const SELECT = `
  SELECT i.*, s.number AS sale_number, s.status AS sale_status, s.channel AS sale_channel,
    r.number AS related_number, r.provider_number AS related_provider_number,
    cu.name AS created_by_name, cx.name AS cancelled_by_name,
    EXISTS (SELECT 1 FROM invoices n WHERE n.related_invoice_id = i.id AND n.status IN ('approved','pending')) AS has_notes
  FROM invoices i
  LEFT JOIN sales s ON s.id = i.sale_id
  LEFT JOIN invoices r ON r.id = i.related_invoice_id
  LEFT JOIN users cu ON cu.id = i.created_by
  LEFT JOIN users cx ON cx.id = i.cancelled_by`

function filters(q: Record<string, string | undefined>) {
  const where: string[] = [], args: unknown[] = []
  const add = (v: unknown) => { args.push(v); return `$${args.length}` }
  // Fechas en hora de Paraguay: "desde/hasta" son días completos.
  if (q.from) where.push(`(i.created_at AT TIME ZONE 'America/Asuncion')::date >= ${add(q.from)}::date`)
  if (q.to) where.push(`(i.created_at AT TIME ZONE 'America/Asuncion')::date <= ${add(q.to)}::date`)
  if (q.kind) where.push(`i.kind = ${add(q.kind)}`)
  if (q.status) where.push(`i.status = ${add(q.status)}`)
  if (q.q) {
    const term = q.q.trim().toLowerCase()
    const p = add('%' + term + '%')
    // El CDC contiene el RUC del EMISOR (la librería): se compara solo con un fragmento largo, si no un RUC traería todo.
    const cdc = term.replace(/\D/g, '').length >= 20 ? ` OR COALESCE(i.cdc,'') LIKE ${add('%' + term.replace(/\D/g, '') + '%')}` : ''
    where.push(`(lower(i.number) LIKE ${p} OR lower(COALESCE(i.provider_number,'')) LIKE ${p} OR lower(i.customer_name) LIKE ${p}
      OR lower(COALESCE(i.customer_ruc,'')) LIKE ${p} OR lower(COALESCE(s.number,'')) LIKE ${p}${cdc})`)
  }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', args }
}

async function loadInvoice(db: Db, id: number) {
  const { rows } = await db.query(`${SELECT} WHERE i.id = $1`, [id])
  if (!rows[0]) throw new HttpError(404, 'Comprobante no encontrado')
  return rows[0]
}

// La factura sobre la que se opera debe ser la vigente y estar aprobada.
async function approvedInvoice(db: Db, id: number) {
  const inv = await loadInvoice(db, id)
  if (inv.kind !== 'invoice') throw new HttpError(409, 'Esta acción se hace sobre la factura original, no sobre una nota')
  if (inv.status !== 'approved' || !inv.cdc) throw new HttpError(409, 'La factura no está aprobada por SET')
  if (!inv.sale_id) throw new HttpError(409, 'La factura no está asociada a una venta')
  return inv
}

const user = (req: any) => req.user as { id: number }

// Emite un documento (NC/ND por importe) y exige que SET lo apruebe ANTES de mover dinero.
// Si no se aprueba, el borrador se marca cancelado (la numeración del proveedor no se consume) y se informa el motivo.
async function emitOrFail(db: Db, id: number) {
  await submitInvoice(db, id)
  const { rows } = await db.query('SELECT * FROM invoices WHERE id = $1', [id])
  const d = rows[0]
  if (d.status === 'approved') return d
  await db.query(`UPDATE invoices SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1`,
    [id, `No aprobada por SET: ${d.error ?? 'sin detalle'}`])
  throw new HttpError(422, `SET no aprobó la ${KIND_LABEL[d.kind].toLowerCase()}: ${d.error ?? 'sin detalle'}. No se movió dinero.`)
}

const refundMethods = z.enum(['cash', 'transfer', 'card', 'qr'])

const creditBody = z.discriminatedUnion('mode', [
  // Devolución de mercadería (ítems): stock, dinero y NC con solo lo devuelto.
  z.object({
    mode: z.literal('items'), motive: z.number().int().min(1).max(5).default(2), reason: z.string().trim().min(3),
    items: z.array(z.object({ saleItemId: z.number().int(), qty: z.number().int().positive() })).min(1),
    restock: z.boolean().default(true), refundMethod: refundMethods.default('cash'), accountId: z.number().int().nullish(),
  }),
  // Descuento, bonificación o crédito incobrable: por importe, sin mercadería.
  z.object({
    mode: z.literal('amount'), motive: z.number().int().min(1).max(5), reason: z.string().trim().min(3),
    concept: z.string().trim().min(3).max(120), amount: z.number().int().positive(), taxRate: z.union([z.literal(0), z.literal(5), z.literal(10)]),
    refundMethod: z.union([refundMethods, z.literal('none')]), accountId: z.number().int().nullish(),
  }),
])

const debitBody = z.object({
  motive: z.number().int().min(1).max(8).default(8), reason: z.string().trim().min(3),
  concept: z.string().trim().min(3).max(120), amount: z.number().int().positive(), taxRate: z.union([z.literal(0), z.literal(5), z.literal(10)]),
  settle: z.enum(['collect', 'account']), method: z.enum(['cash', 'transfer', 'card', 'qr']).default('cash'), accountId: z.number().int().nullish(),
})

export function invoicingRoutes(app: FastifyInstance, db: Db) {
  // ------------------------------------------------------------ Lista y resumen
  app.get('/invoices', async (req) => {
    requirePerm(req, 'invoices.view')
    const q = req.query as Record<string, string | undefined>
    const f = filters(q)
    const { rows } = await db.query(`${SELECT} ${f.where} ORDER BY i.id DESC LIMIT ${Math.min(Number(q.limit) || 500, 2000)}`, f.args)
    return rows.map(decorate)
  })

  app.get('/invoices/summary', async (req) => {
    requirePerm(req, 'invoices.view')
    const q = req.query as Record<string, string | undefined>
    const f = filters({ from: q.from, to: q.to })
    const { rows } = await db.query(
      `SELECT i.kind, i.status, COUNT(*)::int AS count, COALESCE(SUM(i.total),0)::bigint AS total
       FROM invoices i LEFT JOIN sales s ON s.id = i.sale_id ${f.where} GROUP BY i.kind, i.status`, f.args)
    const cfg = await getSetting(db, 'invoice')
    const keyLoaded = !!(await getSecret(db, 'oietema_api_key'))
    return {
      groups: rows.map((r) => ({ ...r, total: Number(r.total) })),
      config: { enabled: !!cfg.enabled, mode: cfg.mode ?? 'mock', tenant: cfg.tenant ?? null, establishment: cfg.establishment ?? null, point: cfg.point ?? null, format: cfg.format ?? 'A4', keyLoaded },
      motives: MOTIVES, cancelHours: CANCEL_HOURS,
    }
  })

  // ------------------------------------------------------------ Detalle
  app.get('/invoices/:id', async (req) => {
    requirePerm(req, 'invoices.view')
    const id = Number((req.params as any).id)
    const inv = decorate(await loadInvoice(db, id))
    const { rows: notes } = await db.query(`${SELECT} WHERE i.related_invoice_id = $1 ORDER BY i.id`, [id])
    const { rows: siblings } = inv.sale_id
      ? await db.query(`${SELECT} WHERE i.sale_id = $1 AND i.kind = 'invoice' AND i.id <> $2 ORDER BY i.id`, [inv.sale_id, id])
      : { rows: [] as any[] }
    let sale: any = null, items: any[] = [], voidBlock: string | null = null, active: any = null
    if (inv.sale_id) {
      const { rows } = await db.query(
        `SELECT s.id, s.number, s.status, s.total, s.subtotal, s.discount, s.returned_total, s.credit_amount, s.customer_id, s.created_at, s.channel,
           c.name AS customer_name, c.ruc AS customer_ruc,
           COALESCE((SELECT SUM(CASE WHEN ins.status = 'open' THEN ins.amount - ins.paid - ins.credited ELSE 0 END) FROM installments ins WHERE ins.sale_id = s.id), 0)::bigint AS open_debt
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = $1`, [inv.sale_id])
      sale = rows[0] ?? null
      items = (await db.query(
        `SELECT si.id, si.name, si.qty, si.unit_price, si.total, si.tax_rate, p.kind,
           COALESCE((SELECT SUM(ri.qty) FROM sale_return_items ri WHERE ri.sale_item_id = si.id), 0)::int AS returned_qty
         FROM sale_items si LEFT JOIN products p ON p.id = si.product_id WHERE si.sale_id = $1 ORDER BY si.id`, [inv.sale_id])).rows
      try { await checkVoidable(db, inv.sale_id, user(req).id) } catch (e: any) { voidBlock = e.message }
      active = (await activeInvoice(db, inv.sale_id))?.id ?? null
    }
    const hasActiveNotes = notes.some((n: any) => ['approved', 'pending'].includes(n.status))
    return { ...inv, notes: notes.map(decorate), siblings: siblings.map(decorate), sale, items, void_block: voidBlock, is_active: active === id, has_active_notes: hasActiveNotes, motives: MOTIVES }
  })

  // ------------------------------------------------------------ Comprobante imprimible (KUDE)
  // El servidor lo trae con el CDC para no exponer la clave ni chocar con CORS.
  app.get('/invoices/:id/kude', async (req, reply) => {
    requirePerm(req, 'invoices.view')
    const id = Number((req.params as any).id)
    const { rows } = await db.query('SELECT cdc FROM invoices WHERE id = $1', [id])
    if (!rows[0]) throw new HttpError(404, 'Comprobante no encontrado')
    if (!rows[0].cdc) throw new HttpError(409, 'El comprobante todavía no tiene CDC (no fue aprobado).')
    const cfg = await getSetting<any>(db, 'invoice')
    const apiKey = (await getSecret(db, 'oietema_api_key')) ?? ''
    const fmt = ((req.query as any).formato as string) || cfg.format || 'A4'
    const html = await fetchKude({ apiKey, tenant: cfg.tenant, establishment: String(cfg.establishment ?? ''), point: String(cfg.point ?? ''), format: cfg.format }, rows[0].cdc, fmt)
    return reply.header('content-type', 'text/html; charset=utf-8').send(html)
  })

  // ------------------------------------------------------------ Reintentar / corregir receptor
  app.post('/invoices/:id/retry', async (req) => {
    requirePerm(req, 'invoices.view')
    const id = Number((req.params as any).id)
    const inv = await loadInvoice(db, id)
    if (!['rejected', 'pending'].includes(inv.status)) throw new HttpError(409, 'Solo se reintentan comprobantes pendientes o rechazados')
    if (inv.sale_status === 'void' && inv.kind === 'invoice') throw new HttpError(409, 'La venta está anulada: no corresponde emitir su factura')
    await db.query(`UPDATE invoices SET status = 'pending' WHERE id = $1`, [id])
    await submitInvoice(db, id)
    return decorate(await loadInvoice(db, id))
  })

  // Cambia el cliente de una factura que SET rechazó (RUC mal escrito, cliente equivocado) y la vuelve a enviar.
  app.put('/invoices/:id/receptor', async (req) => {
    requirePerm(req, 'invoices.issue')
    const id = Number((req.params as any).id)
    const b = z.object({ customerId: z.number().int().nullable() }).parse(req.body)
    const inv = await loadInvoice(db, id)
    if (inv.kind !== 'invoice') throw new HttpError(409, 'El receptor de una nota es el de su factura')
    if (!['rejected', 'pending'].includes(inv.status)) throw new HttpError(409, 'Solo se corrige el cliente de una factura rechazada o pendiente. Si ya está aprobada, cancelala y volvé a facturar.')
    if (inv.sale_status === 'void') throw new HttpError(409, 'La venta está anulada')
    const c = b.customerId ? (await db.query('SELECT id, name, ruc FROM customers WHERE id = $1', [b.customerId])).rows[0] : null
    if (b.customerId && !c) throw new HttpError(404, 'Cliente no encontrado')
    await db.query(`UPDATE invoices SET customer_id = $2, customer_name = $3, customer_ruc = $4, status = 'pending', error = NULL WHERE id = $1`,
      [id, c?.id ?? null, c?.name ?? 'Consumidor final', c?.ruc || null])
    await submitInvoice(db, id)
    return decorate(await loadInvoice(db, id))
  })

  // ------------------------------------------------------------ Facturar una venta (sin factura, o tras cancelar la anterior)
  app.post('/sales/:id/invoice', async (req, reply) => {
    requirePerm(req, 'invoices.issue')
    const saleId = Number((req.params as any).id)
    const b = z.object({ customerId: z.number().int().nullable().default(null) }).parse(req.body ?? {})
    const newId = await withTx(db, async (tx) => {
      const { rows } = await tx.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [saleId])
      const s = rows[0]
      if (!s) throw new HttpError(404, 'Venta no encontrada')
      if (s.status !== 'completed') throw new HttpError(409, 'Solo se facturan ventas vigentes')
      if (Number(s.returned_total) > 0) throw new HttpError(409, 'La venta tiene devoluciones: no se puede facturar de nuevo por el total')
      const cur = await activeInvoice(tx, saleId)
      if (cur) throw new HttpError(409, cur.status === 'approved'
        ? `La venta ya tiene la factura ${cur.provider_number ?? cur.number} aprobada. Para cambiar el cliente, cancelala primero.`
        : `La venta tiene la factura ${cur.number} ${cur.status === 'rejected' ? 'rechazada' : 'pendiente'}: corregí el cliente o reintentá esa.`)
      const c = b.customerId ? (await tx.query('SELECT id, name, ruc FROM customers WHERE id = $1', [b.customerId])).rows[0] : null
      if (b.customerId && !c) throw new HttpError(404, 'Cliente no encontrado')
      const { rows: items } = await tx.query('SELECT total, tax_rate FROM sale_items WHERE sale_id = $1 ORDER BY id', [saleId])
      const t = saleTax(items.map((i) => ({ total: Number(i.total), tax_rate: Number(i.tax_rate) })), Number(s.subtotal) - Number(s.total))
      return createInvoice(tx, {
        saleId, customerName: c?.name ?? 'Consumidor final', customerRuc: c?.ruc || null, customerId: c?.id ?? null,
        total: Number(s.total), tax10: t.tax10, tax5: t.tax5, exempt: t.exempt, userId: user(req).id,
      })
    })
    await submitInvoice(db, newId)
    return reply.code(201).send(decorate(await loadInvoice(db, newId)))
  })

  // ------------------------------------------------------------ Cancelar (evento SIFEN, dentro de 48 h)
  app.post('/invoices/:id/cancel', async (req) => {
    requirePerm(req, 'invoices.manage')
    const id = Number((req.params as any).id)
    const b = z.object({ reason: z.string().trim().min(5, 'El motivo debe tener al menos 5 caracteres'), voidSale: z.boolean().default(true) }).parse(req.body)
    const inv = await approvedInvoice(db, id)
    if (Date.now() >= cancelDeadline(inv)) throw new HttpError(409, `Pasaron más de ${CANCEL_HOURS} h desde la aprobación: SIFEN ya no permite cancelarla. Emití una nota de crédito.`)
    const { rows: notes } = await db.query(`SELECT 1 FROM invoices WHERE related_invoice_id = $1 AND status IN ('approved','pending') LIMIT 1`, [id])
    if (notes[0]) throw new HttpError(409, 'La factura tiene notas de crédito o débito emitidas: ya no se cancela, se ajusta con notas.')
    // Antes de tocar SET se verifica que la venta se pueda anular, para no dejar la factura cancelada y la venta vigente.
    if (b.voidSale && inv.sale_status !== 'void') await checkVoidable(db, inv.sale_id, user(req).id)

    const r = await cancelAtProvider(db, id, b.reason, user(req).id)
    if (!r.ok) throw new HttpError(502, `SET no aceptó la cancelación: ${r.message ?? 'sin detalle'}`)
    let saleVoided = inv.sale_status === 'void', warning: string | null = null
    if (b.voidSale && !saleVoided) {
      try { await voidSale(db, inv.sale_id, user(req), `Factura cancelada: ${b.reason}`, { fiscal: false }); saleVoided = true }
      catch (e: any) { warning = `La factura quedó cancelada en SET, pero la venta no se pudo anular: ${e.message}. Anulala desde Ventas.` }
    }
    return { ...decorate(await loadInvoice(db, id)), protocol: r.protocol ?? null, sale_voided: saleVoided, warning }
  })

  // ------------------------------------------------------------ Nota de crédito
  app.post('/invoices/:id/credit-note', async (req, reply) => {
    requirePerm(req, 'invoices.manage')
    const id = Number((req.params as any).id)
    const b = creditBody.parse(req.body)
    const inv = await approvedInvoice(db, id)
    if (inv.sale_status !== 'completed') throw new HttpError(409, 'La venta está anulada')
    const active = await activeInvoice(db, inv.sale_id)
    if (active?.id !== id) throw new HttpError(409, 'Esta no es la factura vigente de la venta')

    if (b.mode === 'items') {
      // Reusa la devolución de ventas: repone stock, devuelve dinero (o descuenta deuda), asiento y NC con lo devuelto.
      const r = await processSaleReturn(db, user(req), inv.sale_id, { items: b.items, reason: b.reason, restock: b.restock, refundMethod: b.refundMethod, accountId: b.accountId, motive: b.motive })
      const nc = (await db.query(`SELECT id FROM invoices WHERE return_id = $1 AND kind = 'credit_note'`, [r.id])).rows[0]
      return reply.code(201).send({ return: r, note: nc ? decorate(await loadInvoice(db, nc.id)) : null })
    }

    // Por importe: se valida todo, se emite la NC y, solo si SET la aprueba, se registra el dinero.
    const pre = async (q: Db | any) => {
      const { rows } = await q.query('SELECT * FROM sales WHERE id = $1' + (q === db ? '' : ' FOR UPDATE'), [inv.sale_id])
      const s = rows[0]
      const remaining = Number(s.total) - Number(s.returned_total)
      if (b.amount > remaining) throw new HttpError(409, `El máximo que se puede acreditar es ${remaining.toLocaleString('es-PY')} (lo que queda de la venta)`)
      const { rows: d } = await q.query(`SELECT COALESCE(SUM(amount - paid - credited),0)::bigint AS open FROM installments WHERE sale_id = $1 AND status = 'open'`, [inv.sale_id])
      const debt = Number(s.credit_amount) > 0 ? Math.min(Number(d[0].open), b.amount) : 0
      const refund = b.amount - debt
      if (refund > 0 && b.refundMethod === 'none') throw new HttpError(409, `La deuda pendiente de la venta cubre ${debt.toLocaleString('es-PY')}; elegí cómo devolver los ${refund.toLocaleString('es-PY')} restantes`)
      if (refund > 0 && b.refundMethod === 'cash' && !(await openSession(q, user(req).id))) throw new HttpError(409, 'Abrí la caja para devolver el efectivo')
      return s
    }
    await pre(db)
    const ncId = await withTx(db, (tx) => {
      const t = saleTax([{ total: b.amount, tax_rate: b.taxRate }], 0)
      return createInvoice(tx, {
        saleId: inv.sale_id, kind: 'credit_note', relatedId: id, customerName: inv.customer_name, customerRuc: inv.customer_ruc, customerId: inv.customer_id,
        total: b.amount, tax10: t.tax10, tax5: t.tax5, exempt: t.exempt, motive: b.motive, reason: b.reason, userId: user(req).id,
        lines: [{ description: b.concept, qty: 1, amount: b.amount, tax_rate: b.taxRate }],
      })
    })
    await emitOrFail(db, ncId)
    try {
      const money = await withTx(db, async (tx) => {
        const s = await pre(tx)
        const applied = Number(s.credit_amount) > 0 ? await creditSaleDebt(tx, s.id, b.amount) : 0
        if (applied > 0) {
          await tx.query('UPDATE customers SET balance = balance - $2 WHERE id = $1', [s.customer_id, applied])
          await tx.query(`INSERT INTO customer_ledger (customer_id, type, amount, sale_id, note) VALUES ($1,'return',$2,$3,$4)`,
            [s.customer_id, -applied, s.id, `Nota de crédito en ${s.number}: ${b.concept}`])
        }
        const refund = b.amount - applied
        const session = await openSession(tx, user(req).id)
        const { rows: seq } = await tx.query(`SELECT nextval('sale_return_seq') AS n`)
        const number = `D-${String(seq[0].n).padStart(6, '0')}`
        const { rows: ret } = await tx.query(
          `INSERT INTO sale_returns (number, sale_id, user_id, session_id, reason, restock, total, applied_to_debt, refunded, refund_method, motive, concept)
           VALUES ($1,$2,$3,$4,$5,false,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [number, s.id, user(req).id, session?.id ?? null, `${MOTIVES[b.motive]}: ${b.reason}`, b.amount, applied, refund, refund > 0 ? b.refundMethod : null, b.motive, b.concept])
        const returnId = ret[0].id as number
        if (refund > 0 && b.refundMethod !== 'none') {
          await insertPayment(tx, { kind: 'return', saleId: s.id, customerId: s.customer_id, sessionId: session?.id ?? null, sessionAccountId: session?.account_id, userId: user(req).id,
            method: b.refundMethod, amount: -refund, details: { ...(b.accountId ? { accountId: b.accountId } : {}), creditNoteId: ncId, concept: b.concept } })
        }
        await tx.query('UPDATE sales SET returned_total = returned_total + $2 WHERE id = $1', [s.id, b.amount])
        await postReturn(tx, {
          returnId, number, userId: user(req).id, total: b.amount, restock: false,
          items: [{ amount: b.amount, tax_rate: b.taxRate, qty: 1, cost: 0, kind: 'service' }],
          settle: { applied, refunds: refund > 0 && b.refundMethod !== 'none' ? [{ method: b.refundMethod, amount: refund }] : [] },
        })
        await tx.query('UPDATE invoices SET return_id = $2 WHERE id = $1', [ncId, returnId])
        await tx.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'invoice.credit_note','invoice',$2,$3)`,
          [user(req).id, ncId, JSON.stringify({ motive: b.motive, amount: b.amount, applied, refund })])
        return { number, applied, refunded: refund }
      })
      return reply.code(201).send({ return: money, note: decorate(await loadInvoice(db, ncId)) })
    } catch (e: any) {
      throw new HttpError(409, `La nota de crédito quedó APROBADA en SET, pero no se pudo registrar el dinero: ${e.message}. Registrá la devolución manualmente.`)
    }
  })

  // ------------------------------------------------------------ Nota de débito
  app.post('/invoices/:id/debit-note', async (req, reply) => {
    requirePerm(req, 'invoices.manage')
    const id = Number((req.params as any).id)
    const b = debitBody.parse(req.body)
    const inv = await approvedInvoice(db, id)
    if (inv.sale_status !== 'completed') throw new HttpError(409, 'La venta está anulada')
    const pre = async (q: Db | any) => {
      const { rows } = await q.query('SELECT * FROM sales WHERE id = $1', [inv.sale_id])
      const s = rows[0]
      if (b.settle === 'account' && !s.customer_id) throw new HttpError(409, 'La venta es a consumidor final: no hay cuenta de cliente. Cobrá el importe en el momento.')
      if (b.settle === 'collect' && b.method === 'cash' && !(await openSession(q, user(req).id))) throw new HttpError(409, 'Abrí la caja para cobrar en efectivo')
      return s
    }
    await pre(db)
    const ndId = await withTx(db, (tx) => {
      const t = saleTax([{ total: b.amount, tax_rate: b.taxRate }], 0)
      return createInvoice(tx, {
        saleId: inv.sale_id, kind: 'debit_note', relatedId: id, customerName: inv.customer_name, customerRuc: inv.customer_ruc, customerId: inv.customer_id,
        total: b.amount, tax10: t.tax10, tax5: t.tax5, exempt: t.exempt, motive: b.motive, reason: b.reason, userId: user(req).id,
        lines: [{ description: b.concept, qty: 1, amount: b.amount, tax_rate: b.taxRate }],
      })
    })
    await emitOrFail(db, ndId)
    try {
      await withTx(db, async (tx) => {
        const s = await pre(tx)
        const t = saleTax([{ total: b.amount, tax_rate: b.taxRate }], 0)
        const vat = t.vat10 + t.vat5
        const income = b.motive === 8 ? ACC.sales : ACC.otherIncome
        let debit: string
        if (b.settle === 'collect') {
          const session = await openSession(tx, user(req).id)
          await insertPayment(tx, { kind: 'debit_note', saleId: s.id, customerId: s.customer_id, sessionId: session?.id ?? null, sessionAccountId: session?.account_id, userId: user(req).id,
            method: b.method, amount: b.amount, details: { ...(b.accountId ? { accountId: b.accountId } : {}), debitNoteId: ndId, concept: b.concept } })
          debit = methodAccount(b.method)
        } else {
          // A cuenta del cliente: suma a su saldo como una cuota más, que se cobra en Clientes y crédito.
          await tx.query('UPDATE customers SET balance = balance + $2 WHERE id = $1', [s.customer_id, b.amount])
          await tx.query(`INSERT INTO customer_ledger (customer_id, type, amount, sale_id, note) VALUES ($1,'charge',$2,$3,$4)`,
            [s.customer_id, b.amount, s.id, `Nota de débito en ${s.number}: ${b.concept}`])
          const { rows: n } = await tx.query('SELECT COALESCE(MAX(number),0)::int + 1 AS n FROM installments WHERE sale_id = $1', [s.id])
          await tx.query(`INSERT INTO installments (sale_id, customer_id, number, due_date, amount) VALUES ($1,$2,$3,(now() AT TIME ZONE 'America/Asuncion')::date + 30,$4)`,
            [s.id, s.customer_id, n[0].n, b.amount])
          debit = ACC.receivable
        }
        await post(tx, {
          description: `Nota de débito ${MOTIVES[b.motive]} — ${b.concept} (venta ${s.number})`, refType: 'invoice', refId: ndId, userId: user(req).id,
          lines: [{ code: debit, debit: b.amount }, { code: income, credit: b.amount - vat }, { code: ACC.vatDebit, credit: vat }],
        })
        await tx.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'invoice.debit_note','invoice',$2,$3)`,
          [user(req).id, ndId, JSON.stringify({ motive: b.motive, amount: b.amount, settle: b.settle, method: b.method })])
      })
    } catch (e: any) {
      throw new HttpError(409, `La nota de débito quedó APROBADA en SET, pero no se pudo registrar el cobro: ${e.message}. Registralo manualmente.`)
    }
    return reply.code(201).send(decorate(await loadInvoice(db, ndId)))
  })
}
