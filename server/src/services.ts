import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePerm } from './auth.js'
import { HttpError, withTx, type Db, type Tx } from './db/client.js'

type Q = Db | Tx

import { notify } from './notifications.js'
import { cancelar, consultarRuc, emitir, type CancelResult, type FacturaPayload, type EmitResult } from './oietema.js'
import { deleteSecret, getSecret, setSecret } from './secrets.js'

export async function getSetting<T = any>(q: Q, key: string): Promise<T> {
  const { rows } = await q.query('SELECT value FROM settings WHERE key = $1', [key])
  return (rows[0]?.value ?? {}) as T
}

// ---------------------------------------------------------------- Facturación electrónica
// El proveedor real (SIFEN / DNIT) requiere timbrado, certificado y homologación.
// Mientras tanto "mock" aprueba localmente para poder probar todo el circuito.
export interface InvoiceDoc { number: string; kind: string; total: number; customer_name: string; customer_ruc: string | null }
export interface SifenResult { status: 'approved' | 'rejected'; cdc?: string; number?: string; error?: string }

// Modo "mock": aprueba localmente con un CDC ficticio, para probar el circuito sin facturar de verdad.
export async function sifenSubmit(mode: string, doc: InvoiceDoc): Promise<SifenResult> {
  if (mode !== 'mock') throw new Error('Integración SIFEN real pendiente: falta timbrado, certificado y habilitación en la DNIT')
  if (doc.customer_ruc === 'RECHAZAR') return { status: 'rejected', error: 'RUC del receptor inválido (simulado)' }
  const digits = Array.from({ length: 44 }, (_, i) => (Number(doc.number.replace(/\D/g, '')[i % 12] ?? 0) + i) % 10).join('')
  return { status: 'approved', cdc: digits }
}

// Configuración de conexión a OñeTema (clave cifrada + tenant/establecimiento/punto).
export async function oietemaConfig(q: Q, cfg?: any) {
  cfg ??= await getSetting(q, 'invoice')
  const apiKey = await getSecret(q as Db, 'oietema_api_key')
  if (!apiKey) throw new Error('Falta la clave de la API de facturación (cargala en Configuración).')
  if (!cfg.tenant || !cfg.establishment || !cfg.point) throw new Error('Falta configurar tenant, establecimiento o punto de facturación.')
  return { apiKey, tenant: cfg.tenant, establishment: String(cfg.establishment), point: String(cfg.point), format: cfg.format || 'A4' }
}

export const IVA = (rate: unknown): 0 | 5 | 10 => (Number(rate) === 10 ? 10 : Number(rate) === 5 ? 5 : 0)

// Una línea de N unidades por un importe que no se divide exacto en N se parte en dos (N-1 a precio base + 1 con el resto),
// para que Σ(PRECIO × CANTIDAD) coincida al guaraní con el total del documento (SIFEN recalcula y rechaza diferencias).
export function exactLines(desc: string, qty: number, amount: number, iva: 0 | 5 | 10, code?: string) {
  const d = String(desc).slice(0, 120)
  const q = Math.max(1, Math.round(qty) || 1)
  const base = Math.floor(amount / q)
  const extra = amount - base * q
  const mk = (CANTIDAD: number, PRECIO: number) => ({ ...(code ? { CODIGO: code } : {}), DESCRIPCION: d, CANTIDAD, PRECIO, IVA: iva })
  if (extra === 0) return [mk(q, base)]
  return q === 1 ? [mk(1, amount)] : [mk(q - 1, base), mk(1, base + extra)]
}

// Líneas guardadas en invoices.lines: [{ description, qty, amount, tax_rate, code? }] (amount = importe de la línea, IVA incluido).
export interface DocLine { description: string; qty: number; amount: number; tax_rate: number; code?: string }

// Ítems de la venta con el descuento global prorrateado (igual que saleTax) para que la suma dé exactamente `total`.
async function saleLines(q: Q, saleId: number, total: number): Promise<DocLine[]> {
  const { rows: items } = await q.query('SELECT si.name, si.qty, si.total, si.tax_rate, p.code FROM sale_items si LEFT JOIN products p ON p.id = si.product_id WHERE si.sale_id = $1 ORDER BY si.id', [saleId])
  const subtotal = items.reduce((s: number, it: any) => s + Number(it.total), 0)
  const disc = subtotal - Number(total)
  let rest = disc
  return items.map((it: any, idx: number) => {
    const share = idx === items.length - 1 ? rest : Math.round((disc * Number(it.total)) / (subtotal || 1))
    rest -= share
    return { description: it.name, qty: Number(it.qty) || 1, amount: Number(it.total) - share, tax_rate: Number(it.tax_rate), code: it.code ?? undefined }
  })
}

// Modo "oietema": facturación electrónica real. Arma el documento desde la fila `invoices` (+ ítems propios o los de la venta).
async function emitirElectronica(db: Db, inv: any, cfg: any): Promise<EmitResult> {
  const oietemaCfg = await oietemaConfig(db, cfg)
  const { rows: sr } = await db.query('SELECT credit_amount, customer_id FROM sales WHERE id = $1', [inv.sale_id])
  const sale = sr[0] ?? {}
  const customerId = inv.customer_id ?? sale.customer_id ?? null

  // Receptor. Sin RUC → consumidor final (RUC "XX", no contribuyente).
  let RUC = 'XX', RAZON_SOCIAL = inv.customer_name || 'Sin Nombre', PERSONA: 'FISICA' | 'JURIDICA' = 'FISICA', CONTRIBUYENTE: 'SI' | 'NO' = 'NO'
  // Correo del receptor: OñeTema le envía la factura (KUDE) por correo. Sale del cliente, o del pedido online si no hay cliente.
  const { rows: cu } = customerId ? await db.query('SELECT doc_type, taxpayer, persona, email FROM customers WHERE id = $1', [customerId]) : { rows: [] as any[] }
  const c = cu[0]
  let email: string | null = c?.email || null
  if (!email && inv.sale_id) { const { rows: o } = await db.query('SELECT email FROM orders WHERE sale_id = $1 LIMIT 1', [inv.sale_id]); email = o[0]?.email || null }
  if (inv.customer_ruc) {
    RUC = String(inv.customer_ruc)
    CONTRIBUYENTE = c?.taxpayer || c?.doc_type === 'ruc' ? 'SI' : 'NO'
    PERSONA = c?.persona === 'JURIDICA' ? 'JURIDICA' : 'FISICA'
  }

  // Ítems: los propios de la nota (devolución parcial, descuento, interés…) o los de la venta prorrateados al total.
  const lines: DocLine[] = Array.isArray(inv.lines) && inv.lines.length ? inv.lines : await saleLines(db, inv.sale_id, Number(inv.total))
  const ITEMS = lines.flatMap((l) => exactLines(l.description, l.qty, Number(l.amount), IVA(l.tax_rate), l.code))
  const sum = ITEMS.reduce((s, i) => s + i.PRECIO * i.CANTIDAD, 0)
  if (sum !== Number(inv.total)) throw new Error(`Los ítems suman ${sum} y el documento ${inv.total}: no se envía para no generar un comprobante con importe incorrecto.`)

  const payload: FacturaPayload = {
    RUC, RAZON_SOCIAL, PERSONA, CONTRIBUYENTE,
    CONDICION: Number(sale.credit_amount) > 0 ? 'CREDITO' : 'CONTADO',
    ...(Number(sale.credit_amount) > 0 ? { PLAZO: '30 dias' } : {}),
    ...(email ? { EMAIL: email } : {}),
    ITEMS,
  }
  if (inv.kind === 'credit_note' || inv.kind === 'debit_note') {
    payload.TIPO_DOCUMENTO = inv.kind === 'credit_note' ? 'NOTA_DE_CREDITO' : 'NOTA_DE_DEBITO'
    payload.MOTIVO = Number(inv.motive) || (inv.kind === 'credit_note' ? 1 : 8) // tabla E401: 1 = Devolución y ajuste de precios, 8 = Ajuste de precio
    const orig = inv.related_invoice_id ? (await db.query('SELECT cdc FROM invoices WHERE id = $1', [inv.related_invoice_id])).rows[0] : null
    if (!orig?.cdc) throw new Error('La factura original no tiene CDC aprobado: no se puede emitir la nota.')
    payload.FACTURA_CDC = orig.cdc
  }
  return emitir(oietemaCfg, payload)
}

export type DocKind = 'invoice' | 'credit_note' | 'debit_note'
const SEQ: Record<DocKind, string> = { invoice: 'invoice_number_seq', credit_note: 'credit_note_number_seq', debit_note: 'debit_note_number_seq' }

export async function nextInvoiceNumber(tx: Tx, kind: DocKind) {
  const cfg = await getSetting(tx, 'invoice')
  const { rows } = await tx.query(`SELECT nextval('${SEQ[kind]}') AS n`)
  return `${cfg.establishment}-${cfg.point}-${String(rows[0].n).padStart(7, '0')}`
}

export async function createInvoice(tx: Tx, o: {
  saleId: number; kind?: DocKind; relatedId?: number
  customerName: string; customerRuc: string | null; total: number; tax10: number; tax5: number; exempt: number
  customerId?: number | null; motive?: number; reason?: string; lines?: DocLine[]; returnId?: number; userId?: number
}) {
  const kind = o.kind ?? 'invoice'
  const number = await nextInvoiceNumber(tx, kind)
  const { rows } = await tx.query(
    `INSERT INTO invoices (sale_id, kind, number, related_invoice_id, customer_name, customer_ruc, total, tax10, tax5, exempt, customer_id, motive, reason, lines, return_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [o.saleId, kind, number, o.relatedId ?? null, o.customerName, o.customerRuc, o.total, o.tax10, o.tax5, o.exempt,
      o.customerId ?? null, o.motive ?? null, o.reason ?? null, o.lines ? JSON.stringify(o.lines) : null, o.returnId ?? null, o.userId ?? null])
  return rows[0].id as number
}

// Se ejecuta fuera de la transacción de la venta: un fallo del proveedor nunca bloquea el cobro.
export async function submitInvoice(db: Db, id: number) {
  const { rows } = await db.query('SELECT * FROM invoices WHERE id = $1', [id])
  const inv = rows[0]
  if (!inv || inv.status === 'approved' || inv.status === 'cancelled') return inv
  const cfg = await getSetting(db, 'invoice')
  const mode = cfg.mode ?? 'mock'
  const label = inv.kind === 'invoice' ? 'Factura' : inv.kind === 'credit_note' ? 'Nota de crédito' : 'Nota de débito'
  try {
    const r = mode === 'oietema' ? await emitirElectronica(db, inv, cfg) : await sifenSubmit(mode, inv)
    await db.query(
      `UPDATE invoices SET status = $2, cdc = $3, provider_number = COALESCE($4, provider_number), error = $5, attempts = attempts + 1,
         approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END WHERE id = $1`,
      [id, r.status, r.cdc ?? null, r.number ?? null, r.error ?? null])
    if (r.status === 'rejected') await notify(db, { type: 'invoice_rejected', title: `${label} rechazada ${inv.number}`, body: r.error ?? 'Revisá los datos del receptor.', link: `/facturacion?open=${id}`, dedupeKey: `inv-rej:${id}:${inv.attempts}` }).catch(() => {})
  } catch (e: any) {
    await db.query(`UPDATE invoices SET status = 'pending', error = $2, attempts = attempts + 1 WHERE id = $1`, [id, e.message])
  }
}

// ---------------------------------------------------------------- Cancelación (evento SIFEN)
// SIFEN permite cancelar un documento aprobado dentro de las 48 h; después solo vale una nota de crédito.
export const CANCEL_HOURS = 48
export const cancelDeadline = (inv: { approved_at?: string | Date | null; created_at: string | Date }) =>
  new Date(inv.approved_at ?? inv.created_at).getTime() + CANCEL_HOURS * 3600_000

export async function cancelAtProvider(db: Db, invoiceId: number, reason: string, userId: number): Promise<CancelResult> {
  const { rows } = await db.query('SELECT * FROM invoices WHERE id = $1', [invoiceId])
  const inv = rows[0]
  if (!inv) return { ok: false, message: 'Comprobante no encontrado' }
  if (inv.status !== 'approved' || !inv.cdc) return { ok: false, message: 'Solo se cancelan documentos aprobados (con CDC).' }
  if (Date.now() >= cancelDeadline(inv)) return { ok: false, message: `Pasaron más de ${CANCEL_HOURS} h desde la aprobación: corresponde una nota de crédito.` }
  const motivo = (reason.trim().length >= 5 ? reason.trim() : `Cancelación: ${reason.trim()}`).slice(0, 500) // SIFEN pide ≥ 5 caracteres
  const cfg = await getSetting(db, 'invoice')
  let r: CancelResult
  try {
    r = (cfg.mode ?? 'mock') === 'oietema'
      ? await cancelar(await oietemaConfig(db, cfg), inv.cdc, motivo)
      : { ok: true, message: 'Cancelación simulada (modo de prueba local)', protocol: 'SIM-' + Date.now() }
  } catch (e: any) { r = { ok: false, message: e.message } }
  if (r.ok) {
    await db.query(
      `UPDATE invoices SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, cancel_protocol = $4, error = NULL WHERE id = $1`,
      [invoiceId, userId, motivo, r.protocol ?? null])
    await db.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'invoice.cancel','invoice',$2,$3)`,
      [userId, invoiceId, JSON.stringify({ reason: motivo, protocol: r.protocol ?? null })])
  }
  return r
}

// ---------------------------------------------------------------- Mensajería (Winsap)
export async function enqueue(q: Q, m: { phone?: string | null; audience?: 'customer' | 'supplier' | 'manager'; body: string; dedupeKey?: string }) {
  await q.query(
    `INSERT INTO outbox (to_phone, audience, body, dedupe_key) VALUES ($1,$2,$3,$4) ON CONFLICT (dedupe_key) DO NOTHING`,
    [m.phone ?? null, m.audience ?? 'customer', m.body, m.dedupeKey ?? null])
}

// Sender de Winsap: se conecta cuando se confirme su API (envío, webhooks, estados). Por ahora "mock".
export async function flushOutbox(db: Db) {
  const { rows } = await db.query(`SELECT * FROM outbox WHERE status = 'queued' AND attempts < 5 ORDER BY id LIMIT 50`)
  let sent = 0
  for (const m of rows) {
    try {
      if (m.channel === 'email') {
        // Correo: queda en modo simulado hasta configurar un proveedor SMTP.
        if (!m.to_email) throw new Error('Sin correo de destino')
        await db.query(`UPDATE outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, [m.id])
        sent++; continue
      }
      if (process.env.WINSAP_MODE && process.env.WINSAP_MODE !== 'mock') throw new Error('Winsap real pendiente de configuración')
      if (!m.to_phone && m.audience !== 'manager') throw new Error('Sin teléfono de destino')
      await db.query(`UPDATE outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, [m.id])
      sent++
    } catch (e: any) {
      await db.query(`UPDATE outbox SET attempts = attempts + 1, last_error = $2, status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'queued' END WHERE id = $1`, [m.id, e.message])
    }
  }
  return { sent, attempted: rows.length }
}

// ---------------------------------------------------------------- Reposición y alertas de stock bajo
// Se avisa UNA vez cuando el disponible baja al mínimo (o menos); al reponer vuelve a armarse y puede avisar de nuevo.
export async function checkReplenishment(tx: Tx, productIds: number[]) {
  if (!productIds.length) return
  const shop = await getSetting(tx, 'shop')
  const { rows } = await tx.query(
    `SELECT p.id, p.code, p.name, p.stock, p.reserved, p.min_stock, p.low_alert_active,
       COALESCE((SELECT SUM((pi.qty_ordered - pi.qty_received) * pi.units_per_presentation) FROM purchase_items pi
                 JOIN purchase_orders po ON po.id = pi.order_id AND po.status IN ('issued','partial') WHERE pi.product_id = p.id), 0) AS pending,
       EXISTS (SELECT 1 FROM stock_movements m WHERE m.product_id = p.id AND m.type IN ('sale','online_sale')) AS had_sales,
       (SELECT po.supplier_id FROM purchase_items pi JOIN purchase_orders po ON po.id = pi.order_id WHERE pi.product_id = p.id ORDER BY po.id DESC LIMIT 1) AS supplier_id
     FROM products p WHERE p.id = ANY($1) AND p.kind = 'product' AND p.active`, [productIds])
  for (const p of rows) {
    const available = p.stock - p.reserved
    if (available > p.min_stock) {
      if (p.low_alert_active) {
        await tx.query('UPDATE products SET low_alert_active = false WHERE id = $1', [p.id])
        await tx.query(`UPDATE replenishments SET status = 'received' WHERE product_id = $1 AND status = 'requested'`, [p.id])
      }
      continue
    }
    if (p.low_alert_active) continue // ya se avisó por esta misma condición
    if (p.min_stock <= 0 && !p.had_sales) continue // un producto recién cargado sin mínimo no avisa
    await tx.query('UPDATE products SET low_alert_active = true WHERE id = $1', [p.id])
    const suggested = Math.max(p.min_stock * 2 - available - Number(p.pending), 1)
    await tx.query(`INSERT INTO replenishments (product_id, suggested_qty, supplier_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [p.id, suggested, p.supplier_id])
    await notify(tx, {
      type: 'low_stock', title: available <= 0 ? `Agotado: ${p.name}` : `Stock bajo: ${p.name}`,
      body: `Disponible ${available} (mínimo ${p.min_stock})${Number(p.pending) ? ` · ya pedido y pendiente de recibir: ${p.pending}` : ''}.`,
      link: `/products?open=${p.id}`, data: { productId: p.id, code: p.code, available, min: p.min_stock, pending: Number(p.pending), suggested },
    })
    await enqueue(tx, { audience: 'manager', phone: shop.managerPhone || null,
      body: `Stock bajo: ${p.name} (${available} disponibles, mínimo ${p.min_stock}). Reposición sugerida: ${suggested} unidades.` })
  }
}

export function serviceRoutes(app: FastifyInstance, db: Db) {
  app.get('/settings/:key', async (req) => {
    requirePerm(req, 'reports.view')
    return getSetting(db, (req.params as any).key)
  })
  app.put('/settings/:key', async (req) => {
    requirePerm(req, 'settings.write')
    const key = (req.params as any).key
    if (!['invoice', 'shop', 'ai', 'payments'].includes(key)) throw new HttpError(404, 'Configuración inexistente')
    const cur = await getSetting(db, key)
    const next = { ...cur, ...(req.body as object) }
    await db.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, JSON.stringify(next)])
    return next
  })

  // Las rutas de comprobantes (/invoices…) viven en invoicing.ts.

  // Clave de la API de facturación: se guarda cifrada (como la clave de IA); nunca se devuelve en claro.
  app.get('/invoice/status', async (req) => {
    requirePerm(req, 'reports.view')
    const key = await getSecret(db, 'oietema_api_key')
    return { apiKeyPresent: !!key, last4: key ? key.slice(-4) : null }
  })
  app.put('/invoice/api-key', async (req) => {
    requirePerm(req, 'settings.write')
    const { apiKey } = z.object({ apiKey: z.string().min(8) }).parse(req.body)
    await setSecret(db, 'oietema_api_key', apiKey.trim())
    return { ok: true }
  })
  app.delete('/invoice/api-key', async (req) => {
    requirePerm(req, 'settings.write')
    await deleteSecret(db, 'oietema_api_key')
    return { ok: true }
  })
  // Probar conexión: consulta un RUC de prueba (sin consumir numeración ni emitir nada).
  app.post('/invoice/test', async (req) => {
    requirePerm(req, 'settings.write')
    const r = await consultarRuc('80000004')
    if (r.exists) return { ok: true, message: `Conexión correcta. RUC de prueba: ${r.razonSocial} (${r.rucConDv}).` }
    return { ok: false, message: 'No se pudo consultar el RUC de prueba. Revisá la conexión a internet.' }
  })

  app.get('/outbox', async (req) => {
    requirePerm(req, 'reports.view')
    return (await db.query('SELECT * FROM outbox ORDER BY id DESC LIMIT 100')).rows
  })
  app.post('/outbox/flush', async (req) => {
    requirePerm(req, 'reports.view')
    return flushOutbox(db)
  })

  app.get('/replenishments', async (req) => {
    requirePerm(req, 'purchases.write')
    const { rows } = await db.query(
      `SELECT r.*, p.name, p.code, p.stock, p.reserved, p.min_stock, s.name AS supplier_name FROM replenishments r
       JOIN products p ON p.id = r.product_id LEFT JOIN suppliers s ON s.id = r.supplier_id
       WHERE r.status IN ('open','requested') ORDER BY r.id DESC`)
    return rows
  })
  // La compra compromete dinero: solo se genera tras aprobación explícita.
  app.post('/replenishments/:id/approve', async (req) => {
    requirePerm(req, 'purchases.write')
    const id = Number((req.params as any).id)
    const b = z.object({ supplierId: z.number().int().optional(), qty: z.number().int().positive().optional() }).parse(req.body ?? {})
    return withTx(db, async (tx) => {
      const { rows } = await tx.query(`SELECT * FROM replenishments WHERE id = $1 AND status = 'open' FOR UPDATE`, [id])
      const r = rows[0]
      if (!r) throw new HttpError(409, 'La reposición no está pendiente')
      const supplierId = b.supplierId ?? r.supplier_id
      if (!supplierId) throw new HttpError(400, 'Elegí un proveedor')
      const { rows: p } = await tx.query('SELECT name, cost, units_per_purchase, purchase_unit, tax_rate FROM products WHERE id = $1', [r.product_id])
      const units = b.qty ?? r.suggested_qty
      const boxes = Math.max(1, Math.ceil(units / p[0].units_per_purchase))
      const { rows: seq } = await tx.query(`SELECT nextval('purchase_order_seq') AS n`)
      const unitCost = Number(p[0].cost) * p[0].units_per_purchase
      const net = boxes * unitCost, tax = Math.round(net * p[0].tax_rate / 100)
      const { rows: po } = await tx.query(`INSERT INTO purchase_orders (number, supplier_id, status, notes, user_id, approved_by, approved_at, issued_at, net, tax, total) VALUES ($1,$2,'issued','Reposición automática',$3,$3,now(),now(),$4,$5,$6) RETURNING id, number`, [`OC-${String(seq[0].n).padStart(6, '0')}`, supplierId, req.user!.id, net, tax, net + tax])
      await tx.query('INSERT INTO purchase_items (order_id, product_id, qty_ordered, unit_cost, presentation, units_per_presentation, tax_rate, line_net, line_tax) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [po[0].id, r.product_id, boxes, unitCost, p[0].purchase_unit, p[0].units_per_purchase, p[0].tax_rate, net, tax])
      await tx.query(`UPDATE replenishments SET status = 'requested', supplier_id = $2 WHERE id = $1`, [id, supplierId])
      const { rows: s } = await tx.query('SELECT whatsapp, phone FROM suppliers WHERE id = $1', [supplierId])
      await enqueue(tx, { phone: s[0]?.whatsapp ?? s[0]?.phone, audience: 'supplier', dedupeKey: `po:${po[0].id}`,
        body: `Hola, necesitamos ${boxes} x ${p[0].name} (orden de compra #${po[0].id}). ¿Disponibilidad y plazo de entrega? — Librería Samantha` })
      return { orderId: po[0].id }
    })
  })
  app.post('/replenishments/:id/dismiss', async (req) => {
    requirePerm(req, 'purchases.write')
    await db.query(`UPDATE replenishments SET status = 'dismissed' WHERE id = $1 AND status = 'open'`, [Number((req.params as any).id)])
    return { ok: true }
  })
}
