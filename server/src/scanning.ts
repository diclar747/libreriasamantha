import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import bwipjs from 'bwip-js'
import PDFDocument from 'pdfkit'
import { z } from 'zod'
import { ACC, post } from './accounting.js'
import { anyPerm, requirePerm } from './auth.js'
import { HttpError, withTx, type Db } from './db/client.js'
import { effectivePrice, netCost } from './pricing.js'
import { checkReplenishment } from './services.js'
import { moveStock } from './stock.js'

// ---------------------------------------------------------------- Códigos de barras
export function ean13Check(digits12: string) {
  const s = [...digits12].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0)
  return String((10 - (s % 10)) % 10)
}
export function eanCheck(digits: string) {
  // EAN-8 / UPC-A / EAN-13: el dígito verificador pondera de derecha a izquierda 3,1,3,1…
  const body = digits.slice(0, -1)
  const s = [...body].reverse().reduce((a, d, i) => a + Number(d) * (i % 2 === 0 ? 3 : 1), 0)
  return String((10 - (s % 10)) % 10) === digits.slice(-1)
}
/** Valida el dígito verificador de códigos numéricos EAN-8, UPC-A (12) y EAN-13. Otros formatos se aceptan tal cual. */
export function validateBarcode(code: string) {
  if (/^\d+$/.test(code) && [8, 12, 13].includes(code.length) && !eanCheck(code)) {
    throw new HttpError(400, `El código ${code} no es un ${code.length === 13 ? 'EAN-13' : code.length === 12 ? 'UPC-A' : 'EAN-8'} válido (dígito verificador incorrecto)`)
  }
}
/** Código interno EAN-13 para etiquetas propias (prefijo 200, reservado para uso interno). */
export function internalBarcode(productId: number) {
  const body = '200' + String(productId).padStart(9, '0')
  return body + ean13Check(body)
}
/** Normaliza lo que entrega el lector (espacios, guiones del ISBN, ceros iniciales de UPC en EAN-13). */
export function normalizeScan(raw: string) {
  const c = raw.trim().replace(/[\r\n\t]/g, '')
  return /^[\d-]{10,17}$/.test(c) ? c.replace(/-/g, '') : c
}

export async function findByCode(db: Db, code: string) {
  const c = normalizeScan(code)
  const alt = /^0\d{12}$/.test(c) ? c.slice(1) : c.length === 12 ? '0' + c : c
  const { rows } = await db.query(
    `SELECT * FROM products WHERE barcode = ANY($1) OR isbn = ANY($1) OR qr_code = $2 OR code = $2 OR regexp_replace(COALESCE(isbn,''), '-', '', 'g') = $2 ORDER BY active DESC, id LIMIT 2`, [[c, alt], c])
  return rows
}

type Fmt = 'code128' | 'ean13' | 'ean8' | 'qrcode'
const bw = (bcid: string, text: string, opts: Record<string, unknown> = {}) => bwipjs.toBuffer({ bcid, text, scale: 3, height: 12, includetext: false, ...opts } as any)

export function bestFormat(p: { barcode: string | null; code: string }): { fmt: Fmt; text: string } {
  const b = p.barcode
  if (b && /^\d{13}$/.test(b)) return { fmt: 'ean13', text: b.slice(0, 12) }
  if (b && /^\d{8}$/.test(b)) return { fmt: 'ean8', text: b.slice(0, 7) }
  return { fmt: 'code128', text: b || p.code }
}

// ---------------------------------------------------------------- Rutas
const linkTtlMin = 15

export function scanPublicRoutes(app: FastifyInstance, db: Db) {
  // El teléfono se une con el enlace temporal del QR y solo puede enviar códigos a esa sesión.
  app.get('/scan/:token', async (req) => {
    const { rows } = await db.query(`SELECT l.id, l.purpose, l.status, l.expires_at, u.name AS user_name FROM scan_links l JOIN users u ON u.id = l.user_id WHERE l.token = $1`, [(req.params as any).token])
    const l = rows[0]
    if (!l || l.status === 'closed' || new Date(l.expires_at) < new Date()) throw new HttpError(410, 'El enlace venció. Generá un QR nuevo desde la caja.')
    await db.query(`UPDATE scan_links SET status = 'linked', linked_at = COALESCE(linked_at, now()), last_seen = now() WHERE id = $1`, [l.id])
    return { purpose: l.purpose, linkedTo: l.user_name, expiresAt: l.expires_at }
  })
  app.post('/scan/:token/events', async (req, reply) => {
    const b = z.object({ code: z.string().min(1).max(200), format: z.string().max(30).optional(), eventId: z.string().max(80).optional() }).parse(req.body)
    const { rows } = await db.query(`SELECT id, status, expires_at FROM scan_links WHERE token = $1`, [(req.params as any).token])
    const l = rows[0]
    if (!l || l.status === 'closed' || new Date(l.expires_at) < new Date()) throw new HttpError(410, 'El enlace venció. Generá un QR nuevo desde la caja.')
    const code = normalizeScan(b.code)
    const { rows: found } = await db.query('SELECT name FROM products WHERE barcode = $1 OR isbn = $1 OR qr_code = $1 OR code = $1 LIMIT 1', [code])
    // Un reintento del teléfono (misma lectura) no duplica el producto en el carrito.
    const ins = await db.query(
      `INSERT INTO scan_events (link_id, code, format, client_event_id) VALUES ($1,$2,$3,$4) ON CONFLICT (link_id, client_event_id) DO NOTHING RETURNING id`, [l.id, code, b.format ?? null, b.eventId ?? null])
    await db.query('UPDATE scan_links SET last_seen = now() WHERE id = $1', [l.id])
    return reply.code(ins.rowCount ? 201 : 200).send({ ok: true, duplicate: !ins.rowCount, product: found[0]?.name ?? null })
  })
}

export function scanRoutes(app: FastifyInstance, db: Db) {
  // ---- Teléfono vinculado como lector (el POS crea el enlace y muestra su QR)
  app.post('/scan/links', async (req, reply) => {
    anyPerm(req, ['pos.sell', 'purchases.receive', 'stock.adjust'])
    const b = z.object({ purpose: z.enum(['sale', 'reception', 'inventory']).default('sale'), cartId: z.string().max(60).default('pos') }).parse(req.body ?? {})
    await db.query(`UPDATE scan_links SET status = 'closed', closed_at = now() WHERE user_id = $1 AND status <> 'closed' AND purpose = $2`, [req.user!.id, b.purpose])
    const token = randomBytes(18).toString('base64url')
    const { rows: s } = await db.query(`SELECT id FROM cash_sessions WHERE user_id = $1 AND status = 'open'`, [req.user!.id])
    const { rows } = await db.query(
      `INSERT INTO scan_links (token, user_id, session_id, cart_id, purpose, expires_at) VALUES ($1,$2,$3,$4,$5, now() + make_interval(mins => $6)) RETURNING id, expires_at`,
      [token, req.user!.id, s[0]?.id ?? null, b.cartId, b.purpose, linkTtlMin])
    return reply.code(201).send({ id: rows[0].id, token, path: `/escanear/${token}`, expiresAt: rows[0].expires_at })
  })
  app.get('/scan/links/:id', async (req) => {
    anyPerm(req, ['pos.sell', 'purchases.receive', 'stock.adjust'])
    const { rows } = await db.query('SELECT id, status, linked_at, last_seen, expires_at, purpose FROM scan_links WHERE id = $1 AND user_id = $2', [Number((req.params as any).id), req.user!.id])
    if (!rows[0]) throw new HttpError(404, 'Enlace inexistente')
    const expired = new Date(rows[0].expires_at) < new Date()
    return { ...rows[0], status: expired && rows[0].status !== 'closed' ? 'expired' : rows[0].status, online: rows[0].last_seen ? Date.now() - new Date(rows[0].last_seen).getTime() < 60_000 : false }
  })
  // El POS consulta lo escaneado desde el teléfono; cada código se entrega una sola vez.
  app.get('/scan/links/:id/events', async (req) => {
    anyPerm(req, ['pos.sell', 'purchases.receive', 'stock.adjust'])
    const id = Number((req.params as any).id)
    const { rows: l } = await db.query('SELECT id FROM scan_links WHERE id = $1 AND user_id = $2', [id, req.user!.id])
    if (!l[0]) throw new HttpError(404, 'Enlace inexistente')
    const { rows } = await db.query(`UPDATE scan_events SET delivered = true WHERE link_id = $1 AND NOT delivered RETURNING id, code, format, created_at`, [id])
    return rows.sort((a, b) => a.id - b.id)
  })
  app.delete('/scan/links/:id', async (req) => {
    anyPerm(req, ['pos.sell', 'purchases.receive', 'stock.adjust'])
    await db.query(`UPDATE scan_links SET status = 'closed', closed_at = now() WHERE id = $1 AND user_id = $2`, [Number((req.params as any).id), req.user!.id])
    return { ok: true }
  })

  // ---- Códigos internos y etiquetas
  app.post('/products/:id/generate-barcode', async (req) => {
    requirePerm(req, 'products.write')
    const id = Number((req.params as any).id)
    const { rows } = await db.query('SELECT id, barcode, name FROM products WHERE id = $1', [id])
    if (!rows[0]) throw new HttpError(404, 'Producto no encontrado')
    if (rows[0].barcode) throw new HttpError(409, 'El producto ya tiene código de barras')
    const code = internalBarcode(id)
    await db.query('UPDATE products SET barcode = $2, updated_at = now() WHERE id = $1', [id, code])
    await db.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'product.barcode_generated','product',$2,$3)`, [req.user!.id, id, JSON.stringify({ barcode: code })])
    return { barcode: code }
  })
  app.get('/products/:id/barcode.png', async (req, reply) => {
    requirePerm(req, 'products.read')
    const { rows } = await db.query('SELECT code, barcode, qr_code FROM products WHERE id = $1', [Number((req.params as any).id)])
    if (!rows[0]) throw new HttpError(404, 'Producto no encontrado')
    const type = (req.query as any).type
    const f = type === 'qr' ? { fmt: 'qrcode' as Fmt, text: rows[0].qr_code || rows[0].code } : bestFormat(rows[0])
    return reply.type('image/png').send(await bw(f.fmt, f.text, f.fmt === 'qrcode' ? { height: undefined, scale: 4 } : { includetext: true, textxalign: 'center' }))
  })
  // Hoja de etiquetas (PDF): nombre, precio, código y barras. ids=1,2,3&copies=2
  app.get('/products/labels', async (req, reply) => {
    requirePerm(req, 'products.read')
    const q = req.query as { ids?: string; copies?: string; type?: string }
    const ids = (q.ids ?? '').split(',').map(Number).filter(Boolean)
    if (!ids.length) throw new HttpError(400, 'Elegí al menos un producto')
    if (ids.length > 200) throw new HttpError(400, 'Máximo 200 productos por hoja')
    const copies = Math.min(Math.max(Number(q.copies) || 1, 1), 20)
    const { rows } = await db.query('SELECT * FROM products WHERE id = ANY($1) ORDER BY name', [ids])
    const doc = new PDFDocument({ size: 'A4', margin: 24 })
    const chunks: Buffer[] = []
    doc.on('data', (c) => chunks.push(c))
    const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))))
    const W = 182, H = 92, cols = 3
    let n = 0
    for (const p of rows) {
      const f = q.type === 'qr' ? { fmt: 'qrcode' as Fmt, text: p.qr_code || p.code } : bestFormat(p)
      const img = await bw(f.fmt, f.text, f.fmt === 'qrcode' ? { height: undefined, scale: 3 } : { includetext: true, textxalign: 'center', scale: 2, height: 10 })
      const price = effectivePrice(p, 'local').price
      for (let c = 0; c < copies; c++) {
        const perPage = cols * Math.floor((doc.page.height - 48) / H)
        if (n > 0 && n % perPage === 0) doc.addPage()
        const idx = n % perPage
        const x = 24 + (idx % cols) * (W + 6), y = 24 + Math.floor(idx / cols) * H
        doc.rect(x, y, W, H - 4).strokeColor('#bbb').stroke()
        doc.fillColor('#000').fontSize(8).text(p.name.slice(0, 44), x + 5, y + 5, { width: W - 10, height: 20, ellipsis: true })
        doc.fontSize(12).font('Helvetica-Bold').text('Gs. ' + price.toLocaleString('es-PY'), x + 5, y + 24, { width: W - 10 }).font('Helvetica')
        doc.image(img, x + 8, y + 42, f.fmt === 'qrcode' ? { height: 44 } : { fit: [W - 16, 40] })
        n++
      }
    }
    doc.end()
    return reply.header('content-type', 'application/pdf').header('content-disposition', 'inline; filename="etiquetas.pdf"').send(await done)
  })

  // ---- Conteo físico de inventario con lector
  const COUNT_PERM = ['stock.adjust', 'stock.read']
  app.get('/inventory-counts', async (req) => {
    anyPerm(req, COUNT_PERM)
    const { rows } = await db.query(
      `SELECT c.*, u.name AS user_name, (SELECT COUNT(*) FROM inventory_count_items WHERE count_id = c.id)::int AS items,
         (SELECT COUNT(*) FROM inventory_count_items WHERE count_id = c.id AND counted <> expected)::int AS differences
       FROM inventory_counts c JOIN users u ON u.id = c.user_id ORDER BY c.id DESC LIMIT 100`)
    return rows
  })
  app.post('/inventory-counts', async (req, reply) => {
    requirePerm(req, 'stock.adjust')
    const { note } = z.object({ note: z.string().max(200).nullish() }).parse(req.body ?? {})
    const { rows } = await db.query(`INSERT INTO inventory_counts (user_id, note) VALUES ($1,$2) RETURNING *`, [req.user!.id, note ?? null])
    await db.query('UPDATE inventory_counts SET number = $2 WHERE id = $1', [rows[0].id, 'CF-' + String(rows[0].id).padStart(5, '0')])
    return reply.code(201).send({ ...rows[0], number: 'CF-' + String(rows[0].id).padStart(5, '0') })
  })
  const countDetail = async (id: number) => {
    const { rows } = await db.query('SELECT c.*, u.name AS user_name FROM inventory_counts c JOIN users u ON u.id = c.user_id WHERE c.id = $1', [id])
    if (!rows[0]) throw new HttpError(404, 'Conteo no encontrado')
    const { rows: items } = await db.query(
      `SELECT i.*, p.name, p.code, p.barcode, (i.counted - i.expected) AS diff, p.cost, p.cost_includes_vat, p.tax_rate FROM inventory_count_items i JOIN products p ON p.id = i.product_id WHERE i.count_id = $1 ORDER BY i.counted_at DESC`, [id])
    return { ...rows[0], items, summary: { products: items.length, units: items.reduce((a, i) => a + i.counted, 0), differences: items.filter((i) => i.diff !== 0).length } }
  }
  app.get('/inventory-counts/:id', async (req) => { anyPerm(req, COUNT_PERM); return countDetail(Number((req.params as any).id)) })
  // Cada lectura suma 1 (o la cantidad indicada); con el mismo eventId no se cuenta dos veces.
  app.post('/inventory-counts/:id/scan', async (req) => {
    requirePerm(req, 'stock.adjust')
    const id = Number((req.params as any).id)
    const b = z.object({ code: z.string().min(1), qty: z.number().int().min(1).max(10000).default(1), set: z.boolean().default(false) }).parse(req.body)
    return withTx(db, async (tx) => {
      const { rows: c } = await tx.query('SELECT status FROM inventory_counts WHERE id = $1 FOR UPDATE', [id])
      if (!c[0]) throw new HttpError(404, 'Conteo no encontrado')
      if (c[0].status !== 'open') throw new HttpError(409, 'El conteo ya está cerrado')
      const found = await findByCode(tx as any, b.code)
      if (!found[0]) throw new HttpError(404, `No hay un producto con el código ${b.code}`)
      const p = found[0]
      if (p.kind !== 'product') throw new HttpError(400, 'Los servicios no se cuentan')
      const { rows } = await tx.query(
        `INSERT INTO inventory_count_items (count_id, product_id, counted, expected) VALUES ($1,$2,$3,$4)
         ON CONFLICT (count_id, product_id) DO UPDATE SET counted = CASE WHEN $5 THEN $3 ELSE inventory_count_items.counted + $3 END, counted_at = now() RETURNING counted, expected`,
        [id, p.id, b.qty, p.stock, b.set])
      return { productId: p.id, name: p.name, counted: rows[0].counted, expected: rows[0].expected, diff: rows[0].counted - rows[0].expected }
    })
  })
  app.post('/inventory-counts/:id/apply', async (req) => {
    requirePerm(req, 'stock.adjust')
    const id = Number((req.params as any).id)
    return withTx(db, async (tx) => {
      const { rows: c } = await tx.query('SELECT * FROM inventory_counts WHERE id = $1 FOR UPDATE', [id])
      if (!c[0]) throw new HttpError(404, 'Conteo no encontrado')
      if (c[0].status !== 'open') throw new HttpError(409, 'El conteo ya fue procesado')
      const { rows: items } = await tx.query('SELECT i.*, p.cost, p.cost_includes_vat, p.tax_rate FROM inventory_count_items i JOIN products p ON p.id = i.product_id WHERE i.count_id = $1 ORDER BY i.product_id', [id])
      let gain = 0, loss = 0
      const touched: number[] = []
      for (const i of items) {
        // Se ajusta contra el stock actual: lo vendido mientras se contaba no se pisa.
        await tx.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [i.product_id])
        const delta = i.counted - i.expected
        if (delta === 0) continue
        await moveStock(tx, { productId: i.product_id, delta, type: 'count', reason: `Conteo físico ${c[0].number}`, userId: req.user!.id, refType: 'inventory_count', refId: id, unitCost: i.cost })
        const v = Math.abs(delta) * netCost(Number(i.cost), i.cost_includes_vat, i.tax_rate)
        if (delta > 0) gain += v; else loss += v
        touched.push(i.product_id)
      }
      await post(tx, { description: `Conteo físico ${c[0].number}`, refType: 'inventory_count', refId: id, userId: req.user!.id,
        lines: [{ code: ACC.inventory, debit: gain, credit: loss }, { code: ACC.adjustments, debit: loss, credit: gain }] })
      await tx.query(`UPDATE inventory_counts SET status = 'applied', applied_at = now(), applied_by = $2 WHERE id = $1`, [id, req.user!.id])
      await checkReplenishment(tx, touched)
      return { applied: touched.length, gain, loss }
    })
  })
  app.post('/inventory-counts/:id/cancel', async (req) => {
    requirePerm(req, 'stock.adjust')
    const r = await db.query(`UPDATE inventory_counts SET status = 'cancelled' WHERE id = $1 AND status = 'open'`, [Number((req.params as any).id)])
    if (!r.rowCount) throw new HttpError(409, 'El conteo no está abierto')
    return { ok: true }
  })
}
