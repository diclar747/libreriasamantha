import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { z } from 'zod'
import { requirePerm } from './auth.js'
import { HttpError, type Db } from './db/client.js'
import { pushOne, vapid } from './notifications.js'

// Campañas push de marketing para la tienda:
//  - Notificación push a los visitantes que aceptaron recibir ofertas (audiencia anónima en push_audience).
//  - Pop-up de oferta que aparece al abrir la tienda (varias campañas vigentes rotan por prioridad).
// Reutiliza las llaves VAPID y el envío de ./notifications.ts; es independiente del push interno del equipo.

const CAMPAIGN_STATUS = ['draft', 'scheduled', 'active', 'sent', 'archived'] as const

const campaignBody = z.object({
  name: z.string().min(1).max(120),
  title: z.string().min(1).max(120),
  body: z.string().max(500).default(''),
  imageUrl: z.string().max(600).nullish(),
  link: z.string().max(600).nullish(),
  productId: z.number().int().positive().nullish(),
  sendPush: z.boolean().default(true),
  showPopup: z.boolean().default(true),
  startsAt: z.string().datetime({ offset: true }).nullish(),
  endsAt: z.string().datetime({ offset: true }).nullish(),
  priority: z.number().int().min(0).max(1000).default(0),
  status: z.enum(CAMPAIGN_STATUS).default('draft'),
})

// El precio a mostrar en la oferta: el de oferta si está activo, si no el de lista.
const offerPrice = (r: any) => (r.offer_enabled && r.offer_price ? Number(r.offer_price) : r.product_price != null ? Number(r.product_price) : null)

function campaignOut(r: any) {
  const price = offerPrice(r)
  return {
    id: r.id, name: r.name, title: r.title, body: r.body,
    image_url: r.image_url ?? r.product_image ?? null,
    link: r.link ?? (r.product_id ? `/tienda/producto/${r.product_id}` : '/tienda'),
    product_id: r.product_id,
    product: r.product_id ? { id: r.product_id, name: r.product_name, price, list_price: r.product_price != null ? Number(r.product_price) : null, image: r.product_image } : null,
    send_push: r.send_push, show_popup: r.show_popup,
    starts_at: r.starts_at, ends_at: r.ends_at, priority: r.priority, status: r.status,
    sent_at: r.sent_at, sent_count: r.sent_count, fail_count: r.fail_count,
    created_at: r.created_at, updated_at: r.updated_at,
  }
}

const SELECT = `SELECT c.*, p.name AS product_name, p.price AS product_price, p.offer_price, p.offer_enabled, p.image_url AS product_image
                FROM push_campaigns c LEFT JOIN products p ON p.id = c.product_id`

// Procesa una imagen (data URL o URL remota) y la guarda; devuelve la URL pública que sirve /shop/campaign-img.
async function storeImage(db: Db, input: string): Promise<string> {
  let buf: Buffer
  if (/^data:image\//.test(input)) buf = Buffer.from(input.replace(/^data:image\/[^;]+;base64,/, ''), 'base64')
  else if (/^https?:\/\//.test(input)) {
    const res = await fetch(input).catch(() => null)
    if (!res || !res.ok) throw new HttpError(400, 'No se pudo descargar la imagen')
    buf = Buffer.from(await res.arrayBuffer())
  } else throw new HttpError(400, 'Imagen inválida')
  if (buf.length > 11 * 1024 * 1024) throw new HttpError(400, 'La imagen supera los 11 MB')
  let out: { data: Buffer; info: { width: number; height: number } }
  try { out = await sharp(buf, { failOn: 'error' }).rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true }) }
  catch { throw new HttpError(400, 'El archivo no es una imagen válida') }
  const { rows } = await db.query('INSERT INTO campaign_images (data, width, height) VALUES ($1,$2,$3) RETURNING id', [out.data, out.info.width, out.info.height])
  return `/api/shop/campaign-img/${rows[0].id}`
}

// ---------------------------------------------------------------- Público (tienda): suscripción, imágenes y ofertas vigentes
export function campaignPublicRoutes(app: FastifyInstance, db: Db) {
  app.get('/push/public-key', async () => ({ publicKey: (await vapid(db)).publicKey }))

  app.post('/push/subscribe', async (req) => {
    const b = z.object({
      endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }), accountId: z.number().int().positive().nullish(),
    }).parse(req.body)
    await db.query(
      `INSERT INTO push_audience (endpoint, p256dh, auth, account_id, user_agent) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = $2, auth = $3, account_id = COALESCE($4, push_audience.account_id), last_seen = now()`,
      [b.endpoint, b.keys.p256dh, b.keys.auth, b.accountId ?? null, String(req.headers['user-agent'] ?? '').slice(0, 200)])
    return { ok: true }
  })

  app.post('/push/unsubscribe', async (req) => {
    const { endpoint } = z.object({ endpoint: z.string() }).parse(req.body)
    await db.query('DELETE FROM push_audience WHERE endpoint = $1', [endpoint])
    return { ok: true }
  })

  app.get('/campaign-img/:id', async (req, reply) => {
    const { rows } = await db.query('SELECT data FROM campaign_images WHERE id = $1', [Number((req.params as any).id)])
    if (!rows[0]) throw new HttpError(404, 'Imagen no encontrada')
    return reply.header('Cache-Control', 'public, max-age=604800').type('image/webp').send(rows[0].data as Buffer)
  })

  // Campañas que deben aparecer como pop-up al abrir la tienda (vigentes, ordenadas por prioridad).
  app.get('/offers', async () => {
    const { rows } = await db.query(
      `${SELECT} WHERE c.show_popup AND c.status IN ('active','sent','scheduled')
         AND (c.starts_at IS NULL OR c.starts_at <= now()) AND (c.ends_at IS NULL OR c.ends_at >= now())
       ORDER BY c.priority DESC, c.id DESC LIMIT 12`)
    return rows.map(campaignOut)
  })
}

// ---------------------------------------------------------------- Admin: dashboard de campañas
export function campaignAdminRoutes(app: FastifyInstance, db: Db) {
  const audienceCount = async () => (await db.query('SELECT COUNT(*)::int AS n FROM push_audience')).rows[0].n as number

  app.get('/campaigns', async (req) => {
    requirePerm(req, 'campaigns.manage')
    const { rows } = await db.query(`${SELECT} ORDER BY c.id DESC LIMIT 200`)
    return { audience: await audienceCount(), items: rows.map(campaignOut) }
  })

  app.get('/campaigns/audience', async (req) => {
    requirePerm(req, 'campaigns.manage')
    return { count: await audienceCount() }
  })

  app.post('/campaigns', async (req, reply) => {
    requirePerm(req, 'campaigns.manage')
    const b = campaignBody.parse(req.body)
    const image = b.imageUrl ? (/^data:image\//.test(b.imageUrl) ? await storeImage(db, b.imageUrl) : b.imageUrl) : null
    const { rows } = await db.query(
      `INSERT INTO push_campaigns (name, title, body, image_url, link, product_id, send_push, show_popup, starts_at, ends_at, priority, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [b.name, b.title, b.body, image, b.link ?? null, b.productId ?? null, b.sendPush, b.showPopup, b.startsAt ?? null, b.endsAt ?? null, b.priority, b.status, req.user!.id])
    const { rows: full } = await db.query(`${SELECT} WHERE c.id = $1`, [rows[0].id])
    return reply.code(201).send(campaignOut(full[0]))
  })

  app.put('/campaigns/:id', async (req) => {
    requirePerm(req, 'campaigns.manage')
    const id = Number((req.params as any).id)
    const b = campaignBody.parse(req.body)
    const image = b.imageUrl ? (/^data:image\//.test(b.imageUrl) ? await storeImage(db, b.imageUrl) : b.imageUrl) : null
    const { rows } = await db.query(
      `UPDATE push_campaigns SET name=$2, title=$3, body=$4, image_url=$5, link=$6, product_id=$7, send_push=$8, show_popup=$9,
         starts_at=$10, ends_at=$11, priority=$12, status=$13, updated_at=now() WHERE id=$1 RETURNING id`,
      [id, b.name, b.title, b.body, image, b.link ?? null, b.productId ?? null, b.sendPush, b.showPopup, b.startsAt ?? null, b.endsAt ?? null, b.priority, b.status])
    if (!rows[0]) throw new HttpError(404, 'Campaña no encontrada')
    const { rows: full } = await db.query(`${SELECT} WHERE c.id = $1`, [id])
    return campaignOut(full[0])
  })

  app.delete('/campaigns/:id', async (req) => {
    requirePerm(req, 'campaigns.manage')
    await db.query('DELETE FROM push_campaigns WHERE id = $1', [Number((req.params as any).id)])
    return { ok: true }
  })

  // Envía la notificación push de la campaña a toda la audiencia (en lotes, limpiando los dispositivos muertos).
  app.post('/campaigns/:id/send', async (req) => {
    requirePerm(req, 'campaigns.manage')
    const id = Number((req.params as any).id)
    const { rows: cr } = await db.query(`${SELECT} WHERE c.id = $1`, [id])
    if (!cr[0]) throw new HttpError(404, 'Campaña no encontrada')
    const c = campaignOut(cr[0])
    const payload = { title: c.title, body: c.body, image: c.image_url ?? undefined, url: c.link, tag: `campaign:${id}` }
    const v = await vapid(db)
    const { rows: subs } = await db.query('SELECT id, endpoint, p256dh, auth FROM push_audience')
    let sent = 0, failed = 0
    const gone: number[] = []
    for (let i = 0; i < subs.length; i += 100) {
      const batch = subs.slice(i, i + 100)
      const results = await Promise.all(batch.map((s) => pushOne(v, s, payload)))
      results.forEach((r, j) => { if (r === 'ok') sent++; else { failed++; if (r === 'gone') gone.push(batch[j].id) } })
    }
    if (gone.length) await db.query('DELETE FROM push_audience WHERE id = ANY($1)', [gone])
    await db.query(
      `UPDATE push_campaigns SET status = CASE WHEN status = 'draft' THEN 'active' ELSE status END, sent_at = now(), sent_count = $2, fail_count = $3, updated_at = now() WHERE id = $1`,
      [id, sent, failed])
    return { sent, failed, audience: subs.length }
  })

  // Prueba: envía la campaña solo a los dispositivos del usuario del equipo que la está creando.
  app.post('/campaigns/:id/test', async (req) => {
    requirePerm(req, 'campaigns.manage')
    const id = Number((req.params as any).id)
    const { rows: cr } = await db.query(`${SELECT} WHERE c.id = $1`, [id])
    if (!cr[0]) throw new HttpError(404, 'Campaña no encontrada')
    const c = campaignOut(cr[0])
    const { rows: subs } = await db.query('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [req.user!.id])
    if (!subs.length) throw new HttpError(409, 'Activá las notificaciones en tu perfil para probar en este dispositivo')
    const v = await vapid(db)
    let sent = 0
    for (const s of subs) if ((await pushOne(v, s, { title: c.title, body: c.body, image: c.image_url ?? undefined, url: c.link, tag: `campaign-test:${id}` })) === 'ok') sent++
    return { sent, devices: subs.length }
  })
}
