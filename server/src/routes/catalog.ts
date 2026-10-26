import { allCategories, sortCategories } from '../categories.js'
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { z } from 'zod'
import { can, requirePerm } from '../auth.js'
import { HttpError, withTx, type Db, type Tx } from '../db/client.js'
import { ACC, post } from '../accounting.js'
import { checkReplenishment } from '../services.js'
import { moveStock } from '../stock.js'
import { validateBarcode, eanCheck, findByCode } from '../scanning.js'
import { effectivePrice, markupOf, marginOf, netCost, offerActive, offerPrice, priceFromMarkup, vatOf } from '../pricing.js'

const nul = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)
const optText = (max = 300) => z.preprocess(nul, z.string().trim().max(max).nullish())
const optMoney = z.preprocess(nul, z.number().int().min(0).nullish())
const optDate = z.preprocess(nul, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida').nullish())

const productShape = {
  code: optText(60),
  barcode: optText(60),
  isbn: optText(30),
  qr_code: optText(120),
  name: z.string().trim().min(2, 'El nombre es obligatorio').max(200),
  short_description: optText(200),
  description: optText(4000),
  category: z.string().trim().min(1).max(80).default('Varios'),
  subcategory: optText(80),
  brand: optText(80),
  author: optText(120),
  publisher: optText(120),
  edition: optText(60),
  language: optText(40),
  kind: z.enum(['product', 'service']).default('product'),
  sale_unit: z.string().trim().min(1).max(30).default('unidad'),
  purchase_unit: z.string().trim().min(1).max(30).default('unidad'),
  units_per_purchase: z.number().int().positive().default(1),
  cost: z.number().int().min(0, 'El costo no puede ser negativo').default(0),
  cost_includes_vat: z.boolean().default(false),
  markup_pct: z.preprocess(nul, z.number().min(0).max(1000).nullish()),
  price: z.number().int().min(0, 'El precio no puede ser negativo'),
  price_includes_vat: z.boolean().default(true),
  wholesale_price: optMoney,
  tax_rate: z.union([z.literal(0), z.literal(5), z.literal(10)]).default(10),
  min_stock: z.number().int().min(0).default(0),
  location: optText(80),
  online_visible: z.boolean().default(true),
  active: z.boolean().default(true),
  offer_enabled: z.boolean().default(false),
  offer_price: optMoney,
  offer_pct: z.preprocess(nul, z.number().min(0).max(100).nullish()),
  offer_start: optDate,
  offer_end: optDate,
  offer_channel: z.enum(['local', 'online', 'both']).default('both'),
  offer_label: optText(40),
}
const productBody = z.object(productShape)
type ProductBody = z.infer<typeof productBody>
const FIELDS = Object.keys(productShape) as (keyof ProductBody)[]

const extras = z.object({
  initial_stock: z.number().int().min(0).optional(),
  confirmBelowCost: z.boolean().optional(),
  supplierIds: z.array(z.number().int()).optional(),
  preferredSupplierId: z.number().int().nullish(),
})

const LABELS: Record<string, string> = {
  code: 'Código', barcode: 'Código de barras', isbn: 'ISBN', qr_code: 'QR', name: 'Nombre', short_description: 'Descripción corta', description: 'Descripción',
  category: 'Categoría', subcategory: 'Subcategoría', brand: 'Marca', author: 'Autor', publisher: 'Editorial', edition: 'Edición', language: 'Idioma', kind: 'Tipo',
  sale_unit: 'Unidad de venta', purchase_unit: 'Unidad de compra', units_per_purchase: 'Unidades por presentación', cost: 'Costo', cost_includes_vat: 'Costo con IVA',
  markup_pct: 'Margen %', price: 'Precio', price_includes_vat: 'Precio con IVA', wholesale_price: 'Precio mayorista', tax_rate: 'IVA', min_stock: 'Stock mínimo',
  location: 'Ubicación', online_visible: 'Visible en la tienda', active: 'Activo', offer_enabled: 'Oferta activa', offer_price: 'Precio de oferta', offer_pct: 'Descuento %',
  offer_start: 'Inicio de oferta', offer_end: 'Fin de oferta', offer_channel: 'Canal de oferta', offer_label: 'Etiqueta de oferta',
}
const SENSITIVE = ['cost', 'cost_includes_vat', 'markup_pct']

function hideCost<T extends Record<string, any>>(role: string, p: T): T {
  if (can(role, 'costs.view')) return p
  const out: Record<string, any> = { ...p }
  for (const k of [...SENSITIVE, 'margin', 'markup', 'stock_value', 'last_cost']) delete out[k]
  return out as T
}

const dateStr = (v: unknown) => (v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10))

function decorate(p: any) {
  const loc = effectivePrice(p, 'local'), onl = effectivePrice(p, 'online')
  const c = Number(p.cost), pr = Number(p.price)
  return {
    ...p,
    offer_start: dateStr(p.offer_start), offer_end: dateStr(p.offer_end),
    available: p.kind === 'service' ? null : p.stock - p.reserved,
    sell_price: loc.price, on_offer: loc.onOffer, offer_label_now: loc.label,
    online_price: onl.price, online_on_offer: onl.onOffer,
    price_net: pr - vatOf(pr, p.tax_rate), price_vat: vatOf(pr, p.tax_rate),
    markup: pr && c ? markupOf(pr, c, p.cost_includes_vat, p.tax_rate) : null,
    margin: pr && c ? marginOf(pr, c, p.cost_includes_vat, p.tax_rate) : null,
    stock_value: p.kind === 'service' ? 0 : p.stock * netCost(c, p.cost_includes_vat, p.tax_rate),
    low: p.kind === 'product' && p.stock - p.reserved <= p.min_stock && p.min_stock > 0,
    out: p.kind === 'product' && p.stock - p.reserved <= 0,
  }
}

// Validaciones de negocio que no se pueden expresar en el esquema.
function validate(b: ProductBody, canBelowCost: boolean, confirm: boolean) {
  const errs: string[] = []
  if (b.kind === 'product' && b.price <= 0) errs.push('El precio de venta debe ser mayor a cero')
  if (b.wholesale_price != null && b.wholesale_price > b.price) errs.push('El precio mayorista no puede superar al precio de venta')
  if (b.units_per_purchase < 1) errs.push('Las unidades por presentación deben ser al menos 1')
  if (b.offer_enabled) {
    if (b.offer_price == null && b.offer_pct == null) errs.push('La oferta necesita un precio o un porcentaje de descuento')
    if (b.offer_price != null && b.offer_price >= b.price) errs.push('El precio de oferta debe ser menor al precio normal')
    if (b.offer_pct != null && (b.offer_pct <= 0 || b.offer_pct >= 100)) errs.push('El descuento debe estar entre 0 y 100%')
    if (b.offer_start && b.offer_end && b.offer_end < b.offer_start) errs.push('La oferta termina antes de empezar')
  }
  if (errs.length) throw new HttpError(400, errs.join('. '))
  if (b.barcode) validateBarcode(b.barcode)
  const isbn = b.isbn?.replace(/-/g, '')
  if (isbn && /^\d{13}$/.test(isbn) && !eanCheck(isbn)) throw new HttpError(400, `El ISBN ${b.isbn} no es válido (dígito verificador incorrecto)`)
  // Vender por debajo del costo requiere permiso y confirmación expresa.
  const cost = netCost(b.cost, b.cost_includes_vat, b.tax_rate)
  const op = b.offer_enabled ? offerPrice(b as any) : null
  const lowest = Math.min(b.price, op ?? b.price)
  const lowestNet = lowest - vatOf(lowest, b.tax_rate)
  if (b.kind === 'product' && cost > 0 && lowestNet < cost) {
    if (!canBelowCost) throw new HttpError(403, 'El precio queda por debajo del costo y no tenés permiso para autorizarlo')
    if (!confirm) throw new HttpError(409, 'El precio queda por debajo del costo. Confirmá para guardarlo igual.')
  }
}

async function nextCode(tx: Db | Tx) {
  const { rows } = await tx.query(`SELECT COALESCE(MAX(substring(code from '^P-(\\d+)$')::int), 0) + 1 AS n FROM products`)
  return 'P-' + String(rows[0].n).padStart(6, '0')
}

async function ensureUnique(tx: Db | Tx, b: Partial<ProductBody>, selfId?: number) {
  for (const [f, label] of [['code', 'código'], ['barcode', 'código de barras'], ['isbn', 'ISBN'], ['qr_code', 'QR']] as const) {
    const v = b[f]
    if (!v) continue
    const { rows } = await tx.query(`SELECT id, name FROM products WHERE ${f} = $1 AND ($2::int IS NULL OR id <> $2) LIMIT 1`, [v, selfId ?? null])
    if (rows[0]) throw new HttpError(409, `Ya existe un producto con ese ${label}: "${rows[0].name}"`)
  }
}

async function audit(tx: Db | Tx, userId: number, action: string, id: number, detail: unknown) {
  await tx.query('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)', [userId, action, 'product', id, JSON.stringify(detail)])
}

const same = (a: unknown, b: unknown) => (a == null && b == null) || String(dateStr(a) ?? a) === String(dateStr(b) ?? b)

// ---------------------------------------------------------------- Imágenes
const SIZES = { thumb: 240, md: 640, full: 1200 } as const
const thumbCache = new Map<string, Buffer>()

function isPrivateHost(host: string) {
  return /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|::1|\[)/i.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.local') || host.endsWith('.internal')
}

async function loadImageInput(b: { data?: string; url?: string }) {
  if (b.data) {
    const m = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/s.exec(b.data)
    if (!m) throw new HttpError(400, 'Formato de imagen no permitido (usá JPG, PNG o WebP)')
    return { buf: Buffer.from(m[1], 'base64'), source: null as string | null }
  }
  if (b.url) {
    const u = new URL(b.url)
    if (!['http:', 'https:'].includes(u.protocol) || isPrivateHost(u.hostname)) throw new HttpError(400, 'URL de imagen no permitida')
    const r = await fetch(u, { signal: AbortSignal.timeout(8000), redirect: 'error' }).catch(() => { throw new HttpError(400, 'No se pudo descargar la imagen') })
    if (!r.ok || !(r.headers.get('content-type') ?? '').startsWith('image/')) throw new HttpError(400, 'La URL no devolvió una imagen')
    const buf = Buffer.from(await r.arrayBuffer())
    return { buf, source: b.url }
  }
  throw new HttpError(400, 'Falta la imagen')
}

async function refreshMainImage(tx: Db | Tx, productId: number) {
  const { rows } = await tx.query('SELECT id FROM product_images WHERE product_id = $1 ORDER BY position, id LIMIT 1', [productId])
  await tx.query('UPDATE products SET image_url = $2 WHERE id = $1', [productId, rows[0] ? `/api/shop/img/${rows[0].id}?s=md` : null])
}

export function imageRoutes(app: FastifyInstance, db: Db) {
  app.get('/img/:id', async (req, reply) => {
    const id = Number((req.params as any).id)
    const s = ((req.query as any).s as keyof typeof SIZES) in SIZES ? ((req.query as any).s as keyof typeof SIZES) : 'full'
    const { rows } = await db.query('SELECT data, size, created_at FROM product_images WHERE id = $1', [id])
    if (!rows[0]) throw new HttpError(404, 'Imagen no encontrada')
    let out: Buffer = rows[0].data
    if (s !== 'full') {
      const key = `${id}:${s}`
      let c = thumbCache.get(key)
      if (!c) {
        c = await sharp(rows[0].data).resize({ width: SIZES[s], height: SIZES[s], fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer()
        if (thumbCache.size > 400) thumbCache.delete(thumbCache.keys().next().value!)
        thumbCache.set(key, c)
      }
      out = c
    }
    return reply.header('Cache-Control', 'public, max-age=604800, immutable').type('image/webp').send(out)
  })
}

// ---------------------------------------------------------------- Rutas administrativas
const SORTS: Record<string, string> = {
  name: 'p.name', code: 'p.code', price: 'p.price', stock: 'p.stock', category: 'p.category', updated: 'p.updated_at', created: 'p.created_at', cost: 'p.cost',
}

function filtersSql(q: Record<string, string | undefined>, params: unknown[], allowCost: boolean) {
  const where: string[] = []
  const add = (v: unknown) => { params.push(v); return '$' + params.length }
  const status = q.status ?? (q.all ? 'all' : 'active')
  if (status === 'active') where.push('p.active')
  else if (status === 'inactive') where.push('NOT p.active')
  if (q.q) {
    const like = add(`%${q.q}%`), exact = add(q.q)
    where.push(`(p.name ILIKE ${like} OR p.code ILIKE ${like} OR p.author ILIKE ${like} OR p.brand ILIKE ${like} OR p.barcode = ${exact} OR p.isbn = ${exact} OR p.qr_code = ${exact})`)
  }
  if (q.category) where.push(`p.category = ${add(q.category)}`)
  if (q.subcategory) where.push(`p.subcategory = ${add(q.subcategory)}`)
  if (q.brand) where.push(`p.brand = ${add(q.brand)}`)
  if (q.kind) where.push(`p.kind = ${add(q.kind)}`)
  if (q.online === '1') where.push('p.online_visible'); else if (q.online === '0') where.push('NOT p.online_visible')
  if (q.supplierId) where.push(`EXISTS (SELECT 1 FROM product_suppliers ps WHERE ps.product_id = p.id AND ps.supplier_id = ${add(Number(q.supplierId))})`)
  if (q.low || q.stock === 'low') where.push(`p.kind = 'product' AND p.min_stock > 0 AND p.stock - p.reserved <= p.min_stock AND p.stock - p.reserved > 0`)
  if (q.stock === 'out') where.push(`p.kind = 'product' AND p.stock - p.reserved <= 0`)
  if (q.stock === 'ok') where.push(`p.kind = 'product' AND p.stock - p.reserved > GREATEST(p.min_stock, 0)`)
  if (q.offer === '1') where.push(`p.offer_enabled AND (p.offer_start IS NULL OR p.offer_start <= local_date(now())) AND (p.offer_end IS NULL OR p.offer_end >= local_date(now()))`)
  if (q.noImage === '1') where.push(`NOT EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id)`)
  if (allowCost && q.belowCost === '1') where.push(`p.cost > 0 AND p.price < p.cost`)
  return where
}

export function catalogRoutes(app: FastifyInstance, db: Db) {
  app.get('/products', async (req) => {
    requirePerm(req, 'products.read')
    const q = req.query as Record<string, string | undefined>
    const costs = can(req.user!.role, 'costs.view')
    const params: unknown[] = []
    const where = filtersSql(q, params, costs)
    const wsql = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const paged = q.page !== undefined
    const size = [15, 30, 50, 100].includes(Number(q.pageSize)) ? Number(q.pageSize) : 30
    const page = Math.max(1, Number(q.page) || 1)
    const col = SORTS[q.sort ?? 'name'] ?? 'p.name'
    const dir = q.dir === 'desc' ? 'DESC' : 'ASC'
    const { rows } = await db.query(
      `SELECT p.*, (SELECT COUNT(*)::int FROM product_images i WHERE i.product_id = p.id) AS image_count
       FROM products p ${wsql} ORDER BY ${col} ${dir}, p.id ${paged ? `LIMIT ${size} OFFSET ${(page - 1) * size}` : 'LIMIT 200'}`, params)
    const items = rows.map((r) => hideCost(req.user!.role, decorate(r)))
    if (!paged) return items
    const { rows: tot } = await db.query(`SELECT COUNT(*)::int AS n FROM products p ${wsql}`, params)
    return { items, total: tot[0].n, page, pageSize: size, pages: Math.max(1, Math.ceil(tot[0].n / size)) }
  })

  app.get('/products/categories', async (req) => {
    requirePerm(req, 'products.read')
    const { rows } = await db.query('SELECT DISTINCT category FROM products WHERE active ORDER BY 1')
    return sortCategories(rows.map((r) => r.category), (c: string) => c)
  })
  app.get('/products/facets', async (req) => {
    requirePerm(req, 'products.read')
    const [cats, subs, brands, langs] = await Promise.all([
      db.query('SELECT DISTINCT category AS v FROM products ORDER BY 1'),
      db.query('SELECT DISTINCT category, subcategory AS v FROM products WHERE subcategory IS NOT NULL ORDER BY 1,2'),
      db.query('SELECT DISTINCT brand AS v FROM products WHERE brand IS NOT NULL ORDER BY 1'),
      db.query('SELECT DISTINCT unnest(ARRAY[sale_unit, purchase_unit]) AS v FROM products ORDER BY 1'),
    ])
    return { categories: allCategories(cats.rows.map((r) => r.v)), subcategories: subs.rows, brands: brands.rows.map((r) => r.v), units: langs.rows.map((r) => r.v) }
  })

  // Búsqueda exacta por lector (código, código de barras, ISBN, QR, código interno).
  app.get('/products/lookup', async (req) => {
    requirePerm(req, 'products.read')
    const code = String((req.query as any).code ?? '').trim()
    if (!code) throw new HttpError(400, 'Falta el código')
    const rows = await findByCode(db, code)
    if (!rows[0]) throw new HttpError(404, 'No hay un producto con ese código')
    return { ...hideCost(req.user!.role, decorate(rows[0])), duplicates: rows.length > 1 }
  })

  app.get('/products/:id', async (req) => {
    requirePerm(req, 'products.read')
    const id = Number((req.params as any).id)
    const { rows } = await db.query('SELECT * FROM products WHERE id = $1', [id])
    if (!rows[0]) throw new HttpError(404, 'Producto no encontrado')
    const [imgs, sups] = await Promise.all([
      db.query('SELECT id, position, mime, width, height, size FROM product_images WHERE product_id = $1 ORDER BY position, id', [id]),
      db.query(`SELECT ps.supplier_id, s.name, ps.supplier_code, ps.last_cost, ps.preferred FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id WHERE ps.product_id = $1 ORDER BY ps.preferred DESC, s.name`, [id]),
    ])
    const out = hideCost(req.user!.role, decorate(rows[0]))
    return { ...out, images: imgs.rows.map((i) => ({ ...i, url: `/api/shop/img/${i.id}?s=full`, thumb: `/api/shop/img/${i.id}?s=thumb` })),
      suppliers: can(req.user!.role, 'costs.view') ? sups.rows : sups.rows.map(({ last_cost: _l, ...r }) => r) }
  })

  // Calculadora: costo + margen -> precio, y precio -> margen, con desglose de IVA.
  app.post('/products/price-calc', async (req) => {
    requirePerm(req, 'products.read')
    const b = z.object({ cost: z.number().min(0), cost_includes_vat: z.boolean().default(false), tax_rate: z.union([z.literal(0), z.literal(5), z.literal(10)]).default(10),
      markup_pct: z.number().min(0).optional(), price: z.number().min(0).optional() }).parse(req.body)
    const price = b.price ?? (b.markup_pct != null ? priceFromMarkup(b.cost, b.markup_pct, b.cost_includes_vat, b.tax_rate) : 0)
    return { price, net: price - vatOf(price, b.tax_rate), vat: vatOf(price, b.tax_rate), cost_net: netCost(b.cost, b.cost_includes_vat, b.tax_rate),
      markup_pct: price && b.cost ? markupOf(price, b.cost, b.cost_includes_vat, b.tax_rate) : null, margin_pct: price && b.cost ? marginOf(price, b.cost, b.cost_includes_vat, b.tax_rate) : null }
  })

  app.post('/products', async (req, reply) => {
    requirePerm(req, 'products.write')
    const x = extras.parse(req.body)
    const b = productBody.parse(req.body)
    validate(b, can(req.user!.role, 'price.override'), !!x.confirmBelowCost)
    const created = await withTx(db, async (tx) => {
      // Código automático: se toma un candado por transacción para que dos altas a la vez (doble toque, red lenta)
      // no reciban el mismo número y una falle. El candado se libera solo al terminar la transacción.
      if (!b.code) { await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['samantha:product_code']); b.code = await nextCode(tx) }
      await ensureUnique(tx, b)
      const { rows } = await tx.query(`INSERT INTO products (${FIELDS.join(', ')}) VALUES (${FIELDS.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, FIELDS.map((f) => b[f] ?? null))
      const p = rows[0]
      if (x.supplierIds?.length) {
        for (const sid of x.supplierIds) await tx.query('INSERT INTO product_suppliers (product_id, supplier_id, preferred) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [p.id, sid, sid === x.preferredSupplierId])
      }
      if (x.initial_stock && b.kind === 'product') {
        await moveStock(tx, { productId: p.id, delta: x.initial_stock, type: 'opening', unitCost: b.cost, reason: 'Stock inicial', userId: req.user!.id, refType: 'product', refId: p.id })
        const value = x.initial_stock * netCost(b.cost, b.cost_includes_vat, b.tax_rate)
        if (value > 0) await post(tx, { description: `Stock inicial: ${b.name}`, refType: 'stock_adjustment', refId: p.id, userId: req.user!.id, lines: [{ code: ACC.inventory, debit: value }, { code: ACC.capital, credit: value }] })
      }
      await audit(tx, req.user!.id, 'product.create', p.id, { code: p.code, name: p.name, price: p.price, cost: p.cost })
      return (await tx.query('SELECT * FROM products WHERE id = $1', [p.id])).rows[0]
    })
    return reply.code(201).send(hideCost(req.user!.role, decorate(created)))
  })

  app.put('/products/:id', async (req) => {
    requirePerm(req, 'products.write')
    const id = Number((req.params as any).id)
    const x = extras.parse(req.body)
    const sent = new Set(Object.keys((req.body ?? {}) as object))
    // partial() conserva los valores por defecto: solo cuentan los campos que realmente se enviaron.
    const patch = Object.fromEntries(Object.entries(productBody.partial().parse(req.body)).filter(([k]) => sent.has(k))) as Partial<ProductBody>
    return withTx(db, async (tx) => {
      const { rows: cur } = await tx.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [id])
      if (!cur[0]) throw new HttpError(404, 'Producto no encontrado')
      const costs = can(req.user!.role, 'costs.view')
      if (!costs) for (const k of SENSITIVE) delete (patch as any)[k]
      const merged = productBody.parse({ ...Object.fromEntries(FIELDS.map((f) => [f, cur[0][f]])), ...patch,
        offer_start: patch.offer_start !== undefined ? patch.offer_start : dateStr(cur[0].offer_start), offer_end: patch.offer_end !== undefined ? patch.offer_end : dateStr(cur[0].offer_end),
        price: patch.price ?? Number(cur[0].price), cost: patch.cost ?? Number(cur[0].cost), wholesale_price: patch.wholesale_price !== undefined ? patch.wholesale_price : cur[0].wholesale_price == null ? null : Number(cur[0].wholesale_price),
        offer_price: patch.offer_price !== undefined ? patch.offer_price : cur[0].offer_price == null ? null : Number(cur[0].offer_price) })
      validate(merged, can(req.user!.role, 'price.override'), !!x.confirmBelowCost)
      if (!merged.code) merged.code = cur[0].code
      await ensureUnique(tx, merged, id)
      if (cur[0].kind !== merged.kind && (cur[0].stock !== 0 || Number(cur[0].reserved))) throw new HttpError(409, 'No se puede cambiar el tipo de un producto con stock')
      const changes: Record<string, [unknown, unknown]> = {}
      for (const f of FIELDS) if (f in patch && !same(cur[0][f], merged[f])) changes[f] = [cur[0][f] ?? null, merged[f] ?? null]
      for (const f of ['cost', 'price', 'wholesale_price'] as const) {
        if (changes[f]) await tx.query('INSERT INTO price_history (product_id, field, old_value, new_value, user_id) VALUES ($1,$2,$3,$4,$5)', [id, f, cur[0][f], merged[f] ?? null, req.user!.id])
      }
      if (!Object.keys(changes).length && !x.supplierIds) return hideCost(req.user!.role, decorate(cur[0]))
      const keys = Object.keys(changes) as (keyof ProductBody)[]
      let row = cur[0]
      if (keys.length) {
        const { rows } = await tx.query(`UPDATE products SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => merged[k] ?? null)])
        row = rows[0]
        await audit(tx, req.user!.id, 'product.update', id, { changes: Object.fromEntries(Object.entries(changes).filter(([k]) => costs || !SENSITIVE.includes(k)).map(([k, v]) => [LABELS[k] ?? k, v])) })
      }
      if (x.supplierIds) {
        await tx.query('DELETE FROM product_suppliers WHERE product_id = $1 AND NOT (supplier_id = ANY($2))', [id, x.supplierIds])
        for (const sid of x.supplierIds) await tx.query('INSERT INTO product_suppliers (product_id, supplier_id, preferred) VALUES ($1,$2,false) ON CONFLICT DO NOTHING', [id, sid])
        await tx.query('UPDATE product_suppliers SET preferred = (supplier_id = $2) WHERE product_id = $1', [id, x.preferredSupplierId ?? null])
      }
      if (changes.min_stock || changes.active) await checkReplenishment(tx, [id])
      return hideCost(req.user!.role, decorate(row))
    })
  })

  // Un producto con movimientos no se elimina: se desactiva y queda el historial.
  app.delete('/products/:id', async (req) => {
    requirePerm(req, 'products.write')
    const id = Number((req.params as any).id)
    return withTx(db, async (tx) => {
      const { rows } = await tx.query('SELECT id, name, stock FROM products WHERE id = $1 FOR UPDATE', [id])
      if (!rows[0]) throw new HttpError(404, 'Producto no encontrado')
      const { rows: use } = await tx.query(
        `SELECT (SELECT COUNT(*) FROM sale_items WHERE product_id = $1) + (SELECT COUNT(*) FROM purchase_items WHERE product_id = $1)
              + (SELECT COUNT(*) FROM order_items WHERE product_id = $1) + (SELECT COUNT(*) FROM stock_movements WHERE product_id = $1) AS n`, [id])
      if (Number(use[0].n) > 0 || rows[0].stock !== 0) {
        await tx.query('UPDATE products SET active = false, updated_at = now() WHERE id = $1', [id])
        await audit(tx, req.user!.id, 'product.deactivate', id, { name: rows[0].name, reason: 'Tiene movimientos' })
        return { deleted: false, deactivated: true, message: 'El producto tiene movimientos, así que se desactivó en lugar de eliminarse.' }
      }
      await tx.query('DELETE FROM product_images WHERE product_id = $1', [id])
      await tx.query('DELETE FROM product_suppliers WHERE product_id = $1', [id])
      await tx.query('DELETE FROM price_history WHERE product_id = $1', [id])
      await tx.query('DELETE FROM price_suggestions WHERE product_id = $1', [id])
      await tx.query('DELETE FROM products WHERE id = $1', [id])
      await audit(tx, req.user!.id, 'product.delete', id, { name: rows[0].name })
      return { deleted: true, deactivated: false }
    })
  })

  app.get('/products/:id/history', async (req) => {
    requirePerm(req, 'products.read')
    const id = Number((req.params as any).id)
    const costs = can(req.user!.role, 'costs.view')
    const prices = costs ? (await db.query('SELECT h.*, u.name AS user_name FROM price_history h LEFT JOIN users u ON u.id = h.user_id WHERE product_id = $1 ORDER BY at DESC LIMIT 100', [id])).rows : []
    const { rows: movements } = await db.query(
      `SELECT m.*, u.name AS user_name FROM stock_movements m LEFT JOIN users u ON u.id = m.user_id WHERE product_id = $1 ORDER BY at DESC, m.id DESC LIMIT 200`, [id])
    const { rows: changes } = await db.query(
      `SELECT a.id, a.action, a.detail, a.at, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity = 'product' AND a.entity_id = $1 ORDER BY a.at DESC, a.id DESC LIMIT 100`, [id])
    return { prices, movements, changes }
  })

  // ------------------------------------------------------------ Imágenes
  app.post('/products/:id/images', async (req, reply) => {
    requirePerm(req, 'products.write')
    const id = Number((req.params as any).id)
    const b = z.object({ data: z.string().max(15_000_000).optional(), url: z.string().url().optional() }).parse(req.body)
    const { rows: ex } = await db.query('SELECT id FROM products WHERE id = $1', [id])
    if (!ex[0]) throw new HttpError(404, 'Producto no encontrado')
    const { rows: cnt } = await db.query('SELECT COUNT(*)::int AS n FROM product_images WHERE product_id = $1', [id])
    if (cnt[0].n >= 8) throw new HttpError(409, 'Máximo 8 imágenes por producto')
    const { buf, source } = await loadImageInput(b)
    if (buf.length > 11 * 1024 * 1024) throw new HttpError(400, 'La imagen supera los 11 MB')
    let out: { data: Buffer; info: { width: number; height: number } }
    try { out = await sharp(buf, { failOn: 'error' }).rotate().resize({ width: SIZES.full, height: SIZES.full, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true }) }
    catch { throw new HttpError(400, 'El archivo no es una imagen válida') }
    const hash = createHash('sha1').update(out.data).digest('hex')
    const { rows } = await db.query(
      `INSERT INTO product_images (product_id, position, mime, data, width, height, size, source_url) VALUES ($1, (SELECT COALESCE(MAX(position), -1) + 1 FROM product_images WHERE product_id = $1), 'image/webp', $2, $3, $4, $5, $6) RETURNING id, position`,
      [id, out.data, out.info.width, out.info.height, out.data.length, source ?? `sha1:${hash}`])
    await refreshMainImage(db, id)
    await db.query('UPDATE products SET updated_at = now() WHERE id = $1', [id])
    return reply.code(201).send({ id: rows[0].id, position: rows[0].position, url: `/api/shop/img/${rows[0].id}?s=full`, thumb: `/api/shop/img/${rows[0].id}?s=thumb`, width: out.info.width, height: out.info.height, size: out.data.length })
  })
  app.put('/products/:id/images/order', async (req) => {
    requirePerm(req, 'products.write')
    const id = Number((req.params as any).id)
    const { ids } = z.object({ ids: z.array(z.number().int()).min(1) }).parse(req.body)
    await withTx(db, async (tx) => {
      for (let i = 0; i < ids.length; i++) await tx.query('UPDATE product_images SET position = $3 WHERE id = $1 AND product_id = $2', [ids[i], id, i])
      await refreshMainImage(tx, id)
    })
    return { ok: true }
  })
  app.delete('/products/:id/images/:imageId', async (req) => {
    requirePerm(req, 'products.write')
    const id = Number((req.params as any).id), imageId = Number((req.params as any).imageId)
    const r = await db.query('DELETE FROM product_images WHERE id = $1 AND product_id = $2', [imageId, id])
    if (!r.rowCount) throw new HttpError(404, 'Imagen no encontrada')
    for (const k of [...thumbCache.keys()]) if (k.startsWith(imageId + ':')) thumbCache.delete(k)
    await refreshMainImage(db, id)
    return { ok: true }
  })

  // ------------------------------------------------------------ Sugerencias de precio (por cambio de costo)
  app.get('/price-suggestions', async (req) => {
    requirePerm(req, 'products.write'); requirePerm(req, 'costs.view')
    const { status } = req.query as any
    const { rows } = await db.query(
      `SELECT s.*, p.name, p.code, p.tax_rate, p.markup_pct FROM price_suggestions s JOIN products p ON p.id = s.product_id WHERE s.status = $1 ORDER BY s.created_at DESC LIMIT 200`, [status ?? 'pending'])
    return rows
  })
  app.post('/price-suggestions/:id/apply', async (req) => {
    requirePerm(req, 'products.write'); requirePerm(req, 'costs.view')
    const id = Number((req.params as any).id)
    const { price } = z.object({ price: z.number().int().positive().optional() }).parse(req.body ?? {})
    return withTx(db, async (tx) => {
      const { rows } = await tx.query(`SELECT * FROM price_suggestions WHERE id = $1 AND status = 'pending' FOR UPDATE`, [id])
      if (!rows[0]) throw new HttpError(404, 'Sugerencia no disponible')
      const newPrice = price ?? Number(rows[0].price_suggested)
      const { rows: p } = await tx.query('SELECT price FROM products WHERE id = $1 FOR UPDATE', [rows[0].product_id])
      await tx.query('INSERT INTO price_history (product_id, field, old_value, new_value, user_id) VALUES ($1,$2,$3,$4,$5)', [rows[0].product_id, 'price', p[0].price, newPrice, req.user!.id])
      await tx.query('UPDATE products SET price = $2, updated_at = now() WHERE id = $1', [rows[0].product_id, newPrice])
      await tx.query(`UPDATE price_suggestions SET status = 'applied', decided_by = $2, decided_at = now() WHERE id = $1`, [id, req.user!.id])
      await audit(tx, req.user!.id, 'product.price_suggestion', rows[0].product_id, { from: Number(p[0].price), to: newPrice })
      return { ok: true, price: newPrice }
    })
  })
  app.post('/price-suggestions/:id/dismiss', async (req) => {
    requirePerm(req, 'products.write')
    const r = await db.query(`UPDATE price_suggestions SET status = 'dismissed', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'pending'`, [Number((req.params as any).id), req.user!.id])
    if (!r.rowCount) throw new HttpError(404, 'Sugerencia no disponible')
    return { ok: true }
  })

  // Importación masiva (Excel -> JSON en el cliente). Actualiza por código o crea.
  app.post('/products/import', async (req) => {
    requirePerm(req, 'products.write')
    const rows = z.array(productBody).max(5000).parse((req.body as any)?.rows)
    let created = 0, updated = 0
    await withTx(db, async (tx) => {
      for (const b of rows) {
        b.code = b.code || (await nextCode(tx))
        const { rows: ex } = await tx.query('SELECT id, cost, price FROM products WHERE code = $1 FOR UPDATE', [b.code])
        await ensureUnique(tx, b, ex[0]?.id)
        if (ex[0]) {
          for (const f of ['cost', 'price'] as const) {
            if (Number(ex[0][f]) !== b[f]) await tx.query('INSERT INTO price_history (product_id, field, old_value, new_value, user_id) VALUES ($1,$2,$3,$4,$5)', [ex[0].id, f, ex[0][f], b[f], req.user!.id])
          }
          await tx.query(`UPDATE products SET ${FIELDS.map((f, i) => `${f} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [ex[0].id, ...FIELDS.map((f) => b[f] ?? null)])
          updated++
        } else {
          await tx.query(`INSERT INTO products (${FIELDS.join(', ')}) VALUES (${FIELDS.map((_, i) => `$${i + 1}`).join(', ')})`, FIELDS.map((f) => b[f] ?? null))
          created++
        }
      }
    })
    return { created, updated }
  })

  // Ajuste de stock con motivo obligatorio (inventario físico, daños, etc.)
  app.post('/stock/adjust', async (req) => {
    requirePerm(req, 'stock.adjust')
    const b = z.object({ productId: z.number().int(), delta: z.number().int().refine((n) => n !== 0, 'El ajuste no puede ser cero'), reason: z.string().min(3), initial: z.boolean().default(false) }).parse(req.body)
    return withTx(db, async (tx) => {
      const { rows } = await tx.query('SELECT stock, reserved, kind, cost, cost_includes_vat, tax_rate FROM products WHERE id = $1 FOR UPDATE', [b.productId])
      if (!rows[0]) throw new HttpError(404, 'Producto no encontrado')
      if (rows[0].kind === 'service') throw new HttpError(400, 'Los servicios no tienen stock')
      if (rows[0].stock + b.delta < rows[0].reserved) throw new HttpError(409, 'El stock quedaría por debajo de lo reservado')
      const m = await moveStock(tx, { productId: b.productId, delta: b.delta, type: b.initial ? 'opening' : 'adjustment', reason: b.reason, userId: req.user!.id, unitCost: rows[0].cost, refType: 'adjustment', refId: b.productId })
      const value = Math.abs(b.delta) * netCost(Number(rows[0].cost), rows[0].cost_includes_vat, rows[0].tax_rate)
      await post(tx, { description: `Ajuste de inventario: ${b.reason}`, refType: 'stock_adjustment', refId: b.productId, userId: req.user!.id,
        lines: b.delta > 0 ? [{ code: ACC.inventory, debit: value }, { code: b.initial ? ACC.capital : ACC.adjustments, credit: value }]
                          : [{ code: ACC.adjustments, debit: value }, { code: ACC.inventory, credit: value }] })
      await checkReplenishment(tx, [b.productId])
      return { stock: m!.after, before: m!.before }
    })
  })
}

export { offerActive }
