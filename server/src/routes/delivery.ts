import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePerm } from '../auth.js'
import { HttpError, withTx, type Db, type Tx } from '../db/client.js'
import { DEFAULT_BASE_FEE, deliveryConfig, promoActive } from '../delivery.js'

// Módulo Delivery del panel: tarifa general (Gs. 30.000 por defecto en todas las ciudades), tarifa propia por ciudad,
// activar/desactivar entregas por ubicación, delivery gratis (por monto, siempre o por promoción), plazos y historial de cambios.
// El navegador nunca fija el precio: el servidor cotiza al crear el pedido y deja una copia del importe aplicado.

const gs = (n: number | null | undefined) => (n === null || n === undefined ? '—' : 'Gs. ' + Math.round(Number(n)).toLocaleString('es-PY'))
const FREE_LABEL: Record<string, string> = { global: 'según la promoción general', never: 'nunca', amount: 'desde un monto', always: 'siempre gratis' }

const cityPatch = z.object({
  active: z.boolean().optional(),                           // delivery activo en esta ciudad
  price: z.number().int().min(0).max(5_000_000).nullable().optional(), // null = vuelve a la tarifa general
  freeMode: z.enum(['global', 'never', 'amount', 'always']).optional(),
  freeFrom: z.number().int().min(0).max(100_000_000).nullable().optional(),
  eta: z.string().trim().max(80).nullable().optional(),
  notes: z.string().trim().max(300).nullable().optional(),
  specialZones: z.array(z.object({ name: z.string().trim().min(2).max(80), fee: z.number().int().min(0).max(5_000_000) })).max(30).optional(),
})
type Patch = z.infer<typeof cityPatch>

async function log(tx: Tx, userId: number | null, c: { id: number; name: string; department: string }, scope: string, field: string, from: string | null, to: string | null, note?: string) {
  if (from === to) return
  await tx.query('INSERT INTO delivery_rate_history (user_id, scope, department, city_id, city_name, field, old_value, new_value, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [userId, scope, c.department, c.id, c.name, field, from, to, note ?? null])
}

// Aplica un cambio a una ciudad y deja asentado qué cambió (valor anterior y nuevo).
async function applyPatch(tx: Tx, userId: number, cityId: number, b: Patch, base: number, scope = 'city', note?: string) {
  const { rows } = await tx.query(
    `SELECT c.id, c.name, c.department, c.active, r.covered, r.price, r.eta, r.notes, r.free_mode, r.free_from, r.special_zones
     FROM geo_cities c LEFT JOIN delivery_rates r ON r.city_id = c.id WHERE c.id = $1 FOR UPDATE OF c`, [cityId])
  const c = rows[0]
  if (!c) throw new HttpError(404, 'Ciudad no encontrada')
  const cur = { covered: c.covered ?? true, price: c.price != null ? Number(c.price) : null, eta: c.eta ?? null, notes: c.notes ?? null, freeMode: c.free_mode ?? 'global', freeFrom: c.free_from != null ? Number(c.free_from) : null, zones: c.special_zones ?? [] }
  const next = {
    covered: b.active ?? cur.covered, price: b.price !== undefined ? b.price : cur.price, eta: b.eta !== undefined ? (b.eta || null) : cur.eta, notes: b.notes !== undefined ? (b.notes || null) : cur.notes,
    freeMode: b.freeMode ?? cur.freeMode, freeFrom: b.freeFrom !== undefined ? b.freeFrom : cur.freeFrom, zones: b.specialZones ?? cur.zones,
  }
  if (next.freeMode === 'amount' && next.freeFrom === null) throw new HttpError(400, `Indicá desde qué monto es gratis el delivery en ${c.name}.`)
  if (next.freeMode !== 'amount') next.freeFrom = null
  await tx.query(
    `INSERT INTO delivery_rates (city_id, covered, price, eta, notes, free_mode, free_from, special_zones, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9, now())
     ON CONFLICT (city_id) DO UPDATE SET covered = $2, price = $3, eta = $4, notes = $5, free_mode = $6, free_from = $7, special_zones = $8::jsonb, updated_by = $9, updated_at = now()`,
    [cityId, next.covered, next.price, next.eta, next.notes, next.freeMode, next.freeFrom, JSON.stringify(next.zones), userId])
  const ref = { id: c.id, name: c.name, department: c.department }
  await log(tx, userId, ref, scope, 'Delivery activo', cur.covered ? 'sí' : 'no', next.covered ? 'sí' : 'no', note)
  await log(tx, userId, ref, scope, 'Tarifa', cur.price === null ? `${gs(base)} (general)` : gs(cur.price), next.price === null ? `${gs(base)} (general)` : gs(next.price), note)
  await log(tx, userId, ref, scope, 'Delivery gratis', cur.freeMode === 'amount' ? `desde ${gs(cur.freeFrom)}` : FREE_LABEL[cur.freeMode], next.freeMode === 'amount' ? `desde ${gs(next.freeFrom)}` : FREE_LABEL[next.freeMode], note)
  await log(tx, userId, ref, scope, 'Plazo', cur.eta, next.eta, note)
  await log(tx, userId, ref, scope, 'Notas', cur.notes, next.notes, note)
  await log(tx, userId, ref, scope, 'Zonas con tarifa especial', JSON.stringify(cur.zones), JSON.stringify(next.zones), note)
}

export function deliveryAdminRoutes(app: FastifyInstance, db: Db) {
  // ---------------------------------------------------------------- Resumen
  app.get('/delivery/overview', async (req) => {
    requirePerm(req, 'delivery.view')
    const cfg = await deliveryConfig(db)
    const { rows: deps } = await db.query(
      `SELECT c.department, COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE c.active AND COALESCE(r.covered, true))::int AS enabled,
         COUNT(*) FILTER (WHERE r.price IS NOT NULL)::int AS custom,
         COUNT(*) FILTER (WHERE r.free_mode <> 'global')::int AS free_rules,
         MIN(COALESCE(r.price, $1::bigint)) AS min_fee, MAX(COALESCE(r.price, $1::bigint)) AS max_fee
       FROM geo_cities c LEFT JOIN delivery_rates r ON r.city_id = c.id WHERE c.active
       GROUP BY c.department ORDER BY c.department = 'Capital' DESC, c.department`, [cfg.baseFee])
    const sum = (k: string) => deps.reduce((s, d) => s + Number(d[k]), 0)
    return {
      config: { ...cfg, promoIsActive: promoActive(cfg), defaultBaseFee: DEFAULT_BASE_FEE },
      kpis: { cities: sum('total'), enabled: sum('enabled'), disabled: sum('total') - sum('enabled'), custom: sum('custom'), freeRules: sum('free_rules') },
      departments: deps.map((d) => ({ department: d.department, total: d.total, enabled: d.enabled, custom: d.custom, freeRules: d.free_rules, minFee: Number(d.min_fee), maxFee: Number(d.max_fee) })),
    }
  })

  // ---------------------------------------------------------------- Ciudades (búsqueda, filtros y paginación)
  app.get('/delivery/cities', async (req) => {
    requirePerm(req, 'delivery.view')
    const q = z.object({ department: z.string().max(60).optional(), q: z.string().max(80).optional(), state: z.enum(['all', 'enabled', 'disabled', 'custom', 'free']).optional(), page: z.coerce.number().int().min(1).optional(), size: z.coerce.number().int().min(10).max(300).optional() }).parse(req.query)
    const cfg = await deliveryConfig(db)
    const params: unknown[] = []
    const w = ['c.active']
    if (q.department) { params.push(q.department); w.push(`c.department = $${params.length}`) }
    if (q.q) { params.push(`%${q.q.trim()}%`); w.push(`translate(lower(c.name), 'áéíóúüñ', 'aeiouun') LIKE translate(lower($${params.length}), 'áéíóúüñ', 'aeiouun')`) }
    if (q.state === 'enabled') w.push('COALESCE(r.covered, true)')
    else if (q.state === 'disabled') w.push('NOT COALESCE(r.covered, true)')
    else if (q.state === 'custom') w.push('r.price IS NOT NULL')
    else if (q.state === 'free') w.push("COALESCE(r.free_mode, 'global') <> 'global'")
    const size = q.size ?? 60, page = q.page ?? 1
    const where = w.join(' AND ')
    const { rows: tot } = await db.query(`SELECT COUNT(*)::int AS n FROM geo_cities c LEFT JOIN delivery_rates r ON r.city_id = c.id WHERE ${where}`, params)
    params.push(size, (page - 1) * size)
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.department, COALESCE(r.covered, true) AS enabled, r.price, COALESCE(r.price, ${Math.round(cfg.baseFee)}::bigint) AS fee, COALESCE(r.free_mode, 'global') AS free_mode, r.free_from, r.eta, r.notes,
         COALESCE(r.special_zones, '[]'::jsonb) AS special_zones, r.updated_at,
         (SELECT COUNT(*)::int FROM orders o WHERE o.city_id = c.id AND o.status <> 'cancelled') AS orders
       FROM geo_cities c LEFT JOIN delivery_rates r ON r.city_id = c.id WHERE ${where}
       ORDER BY c.department = 'Capital' DESC, c.department, c.name LIMIT $${params.length - 1} OFFSET $${params.length}`, params)
    const { rows: deps } = await db.query('SELECT department FROM geo_cities WHERE active GROUP BY department ORDER BY department = \'Capital\' DESC, department')
    return {
      baseFee: cfg.baseFee, departments: deps.map((d) => d.department), total: tot[0].n, page, pages: Math.max(1, Math.ceil(tot[0].n / size)),
      cities: rows.map((r) => ({ id: r.id, name: r.name, department: r.department, enabled: r.enabled, price: r.price != null ? Number(r.price) : null, fee: Number(r.fee), freeMode: r.free_mode, freeFrom: r.free_from != null ? Number(r.free_from) : null, eta: r.eta, notes: r.notes, specialZones: r.special_zones, updatedAt: r.updated_at, orders: r.orders })),
    }
  })

  // ---------------------------------------------------------------- Edición de una ciudad
  app.put('/delivery/cities/:id', async (req) => {
    requirePerm(req, 'delivery.manage')
    const b = cityPatch.parse(req.body)
    const id = Number((req.params as any).id)
    const base = (await deliveryConfig(db)).baseFee
    await withTx(db, (tx) => applyPatch(tx, req.user!.id, id, b, base))
    return { ok: true }
  })

  // ---------------------------------------------------------------- Cambios masivos: ciudades elegidas, un departamento o todo el país
  app.post('/delivery/bulk', async (req) => {
    requirePerm(req, 'delivery.manage')
    const b = z.object({
      target: z.union([z.object({ ids: z.array(z.number().int()).min(1).max(300) }), z.object({ department: z.string().min(2).max(60) }), z.object({ all: z.literal(true) })]),
      patch: cityPatch,
      note: z.string().max(200).optional(),
    }).parse(req.body)
    if (!Object.keys(b.patch).length) throw new HttpError(400, 'No hay nada para cambiar')
    const base = (await deliveryConfig(db)).baseFee
    const t = b.target as Json
    const ids: number[] = t.ids ?? (await db.query(`SELECT id FROM geo_cities WHERE active ${t.department ? 'AND department = $1' : ''} ORDER BY id`, t.department ? [t.department] : [])).rows.map((r: any) => r.id)
    if (!ids.length) throw new HttpError(404, 'No hay ciudades para ese criterio')
    const scope = t.department ? 'department' : t.all ? 'country' : 'city'
    await withTx(db, async (tx) => { for (const id of ids) await applyPatch(tx, req.user!.id, id, b.patch, base, scope, b.note) })
    return { updated: ids.length }
  })

  // ---------------------------------------------------------------- Ajustes generales: tarifa general, interruptor, promoción y plazo
  app.put('/delivery/settings', async (req) => {
    requirePerm(req, 'delivery.manage')
    const b = z.object({
      baseFee: z.number().int().min(0).max(5_000_000).optional(),
      enabled: z.boolean().optional(),
      freeFrom: z.number().int().min(0).max(100_000_000).nullable().optional(),
      promoStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      promoEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      defaultEta: z.string().trim().max(80).nullable().optional(),
    }).parse(req.body)
    if (b.promoStart && b.promoEnd && b.promoStart > b.promoEnd) throw new HttpError(400, 'La promoción termina antes de empezar')
    await withTx(db, async (tx) => {
      const cur = await deliveryConfig(tx)
      const next = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) } as typeof cur
      const { rows } = await tx.query("SELECT value FROM settings WHERE key = 'shop' FOR UPDATE")
      const shop = { ...(rows[0]?.value ?? {}), baseDeliveryFee: next.baseFee, deliveryEnabled: next.enabled, deliveryFreeFrom: next.freeFrom, deliveryPromoStart: next.promoStart, deliveryPromoEnd: next.promoEnd, deliveryDefaultEta: next.defaultEta }
      await tx.query("INSERT INTO settings (key, value) VALUES ('shop', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify(shop)])
      const h = (scope: string, field: string, from: string | null, to: string | null) => from === to ? null : tx.query('INSERT INTO delivery_rate_history (user_id, scope, field, old_value, new_value) VALUES ($1,$2,$3,$4,$5)', [req.user!.id, scope, field, from, to])
      await h('general', 'Tarifa general', gs(cur.baseFee), gs(next.baseFee))
      await h('general', 'Delivery habilitado en todo el país', cur.enabled ? 'sí' : 'no', next.enabled ? 'sí' : 'no')
      await h('promo', 'Delivery gratis desde', cur.freeFrom === null ? 'sin promoción' : gs(cur.freeFrom), next.freeFrom === null ? 'sin promoción' : gs(next.freeFrom))
      await h('promo', 'Promoción desde', cur.promoStart, next.promoStart)
      await h('promo', 'Promoción hasta', cur.promoEnd, next.promoEnd)
      await h('general', 'Plazo general', cur.defaultEta, next.defaultEta)
    })
    return deliveryConfig(db)
  })

  // ---------------------------------------------------------------- Agregar una ciudad que falte en el catálogo
  app.post('/delivery/cities', async (req, reply) => {
    requirePerm(req, 'delivery.manage')
    const b = z.object({ department: z.string().trim().min(2).max(60), name: z.string().trim().min(2).max(80) }).parse(req.body)
    const { rows: dep } = await db.query('SELECT 1 FROM geo_cities WHERE department = $1 LIMIT 1', [b.department])
    if (!dep[0]) throw new HttpError(400, 'Ese departamento no existe en el catálogo')
    try {
      const { rows } = await db.query('INSERT INTO geo_cities (department, name) VALUES ($1,$2) RETURNING id', [b.department, b.name])
      await db.query('INSERT INTO delivery_rate_history (user_id, scope, department, city_id, city_name, field, old_value, new_value) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [req.user!.id, 'city', b.department, rows[0].id, b.name, 'Ciudad agregada', null, 'sí'])
      return reply.code(201).send({ id: rows[0].id })
    } catch (e: any) { if (e.code === '23505') throw new HttpError(409, 'Esa ciudad ya existe en ese departamento'); throw e }
  })

  // ---------------------------------------------------------------- Historial de cambios
  app.get('/delivery/history', async (req) => {
    requirePerm(req, 'delivery.view')
    const q = z.object({ department: z.string().max(60).optional(), city: z.string().max(80).optional(), page: z.coerce.number().int().min(1).optional() }).parse(req.query)
    const params: unknown[] = []
    const w: string[] = []
    if (q.department) { params.push(q.department); w.push(`h.department = $${params.length}`) }
    if (q.city) { params.push(`%${q.city}%`); w.push(`h.city_name ILIKE $${params.length}`) }
    const size = 50, page = q.page ?? 1
    const where = w.length ? 'WHERE ' + w.join(' AND ') : ''
    const { rows: tot } = await db.query(`SELECT COUNT(*)::int AS n FROM delivery_rate_history h ${where}`, params)
    params.push(size, (page - 1) * size)
    const { rows } = await db.query(
      `SELECT h.id, h.at, h.scope, h.department, h.city_name, h.field, h.old_value, h.new_value, h.note, u.name AS user_name
       FROM delivery_rate_history h LEFT JOIN users u ON u.id = h.user_id ${where} ORDER BY h.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params)
    return { items: rows, total: tot[0].n, page, pages: Math.max(1, Math.ceil(tot[0].n / size)) }
  })

  // ---------------------------------------------------------------- Cobros de delivery por ciudad y período
  app.get('/delivery/report', async (req) => {
    requirePerm(req, 'delivery.view')
    const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query)
    const params: unknown[] = [q.from ?? '1900-01-01', q.to ?? '2999-12-31']
    const { rows } = await db.query(
      `SELECT COALESCE(o.department, 'Sin ciudad') AS department, COALESCE(o.city_name, 'Zona anterior') AS city,
         COUNT(*)::int AS orders, COALESCE(SUM(o.delivery_fee), 0) AS charged, COALESCE(SUM(o.delivery_base_fee), 0) AS base_total,
         COUNT(*) FILTER (WHERE o.delivery_fee = 0)::int AS free_orders, COALESCE(SUM(o.total), 0) AS orders_total
       FROM orders o WHERE o.delivery_method = 'delivery' AND o.status <> 'cancelled' AND local_date(o.created_at) BETWEEN $1::date AND $2::date
       GROUP BY 1, 2 ORDER BY charged DESC, orders DESC`, params)
    const items = rows.map((r) => ({ department: r.department, city: r.city, orders: r.orders, charged: Number(r.charged), baseTotal: Number(r.base_total), freeOrders: r.free_orders, forgone: Number(r.base_total) - Number(r.charged), ordersTotal: Number(r.orders_total) }))
    return { items, totals: { orders: items.reduce((s, i) => s + i.orders, 0), charged: items.reduce((s, i) => s + i.charged, 0), forgone: items.reduce((s, i) => s + i.forgone, 0), freeOrders: items.reduce((s, i) => s + i.freeOrders, 0) } }
  })
}

type Json = Record<string, any>
