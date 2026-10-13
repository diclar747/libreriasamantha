import type { FastifyInstance } from 'fastify'
import webpush from 'web-push'
import { z } from 'zod'
import { can, hashPassword, verifyPassword } from './auth.js'
import { HttpError, type Db, type Tx } from './db/client.js'
import { getSecret, setSecret } from './secrets.js'
import { getSetting } from './services.js'

// Cada evento tiene un permiso: solo lo reciben quienes pueden actuar sobre él.
export const NOTIFICATION_TYPES: Record<string, { label: string; perm: string; hint: string }> = {
  chat_inquiry: { label: 'Consultas en la tienda y WhatsApp', perm: 'orders.manage', hint: 'Cuando alguien empieza a escribirle al asistente.' },
  order_new: { label: 'Pedidos nuevos', perm: 'orders.manage', hint: 'Cuando un cliente crea un pedido (aún sin pagar).' },
  order_paid: { label: 'Pedidos pagados', perm: 'orders.manage', hint: 'Cuando se confirma el pago y hay que preparar el pedido.' },
  order_exception: { label: 'Pagos con problemas', perm: 'orders.manage', hint: 'Pago recibido sin stock u otra excepción que necesita decisión.' },
  proof_review: { label: 'Comprobantes de transferencia', perm: 'orders.manage', hint: 'Cuando un cliente sube el comprobante de su transferencia para revisar.' },
  print_request: { label: 'Solicitudes de impresión', perm: 'workorders.write', hint: 'Presupuestos pedidos desde la web o WhatsApp.' },
  low_stock: { label: 'Stock bajo y reposición', perm: 'purchases.write', hint: 'Productos que llegaron al mínimo.' },
  invoice_rejected: { label: 'Facturas rechazadas', perm: 'invoices.view', hint: 'Comprobantes que no fueron aprobados.' },
}

type Q = Db | Tx

export async function notify(q: Q, n: { type: keyof typeof NOTIFICATION_TYPES; title: string; body?: string; link?: string; dedupeKey?: string; data?: Record<string, unknown> }) {
  const def = NOTIFICATION_TYPES[n.type]
  await q.query(
    `INSERT INTO notifications (type, title, body, link, perm, dedupe_key, data) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING`,
    [n.type, n.title, n.body ?? null, n.link ?? null, def.perm, n.dedupeKey ?? null, n.data ? JSON.stringify(n.data) : null])
}

// ---------------------------------------------------------------- Web Push (VAPID, nativo de Node)
async function vapid(db: Db) {
  let publicKey = (await getSetting(db, 'push')).publicKey as string | undefined
  let privateKey = await getSecret(db, 'vapid_private')
  if (!publicKey || !privateKey) {
    const k = webpush.generateVAPIDKeys()
    publicKey = k.publicKey; privateKey = k.privateKey
    await setSecret(db, 'vapid_private', privateKey)
    await db.query(`INSERT INTO settings (key, value) VALUES ('push', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [JSON.stringify({ publicKey })])
  }
  return { publicKey, privateKey, subject: process.env.VAPID_SUBJECT ?? 'mailto:admin@libreria.local' }
}

const wants = (prefs: any, type: string, channel: 'push' | 'inapp') => prefs?.[type]?.[channel] !== false

async function sendTo(db: Db, subs: any[], payload: object) {
  if (!subs.length) return 0
  const v = await vapid(db)
  let sent = 0
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload),
        { vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey }, TTL: 3600 })
      sent++
    } catch (e: any) {
      // 404/410: el dispositivo ya no existe; se limpia la suscripción.
      if (e.statusCode === 404 || e.statusCode === 410) await db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id])
    }
  }))
  return sent
}

// Envía las notificaciones pendientes. Corre en segundo plano, fuera de las transacciones de negocio.
export async function flushPushes(db: Db) {
  const { rows } = await db.query('SELECT * FROM notifications WHERE pushed_at IS NULL ORDER BY id LIMIT 50')
  for (const n of rows) {
    const { rows: subs } = await db.query(
      `SELECT s.*, u.role, u.notif_prefs FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE u.active`)
    const targets = subs.filter((s) => can(s.role, n.perm) && wants(s.notif_prefs, n.type, 'push'))
    await sendTo(db, targets, { title: n.title, body: n.body, url: n.link ?? '/', tag: n.type + ':' + n.id })
    await db.query('UPDATE notifications SET pushed_at = now() WHERE id = $1', [n.id])
  }
  return rows.length
}

// ---------------------------------------------------------------- Rutas: perfil, notificaciones, push
const profileBody = z.object({
  name: z.string().min(2).max(80),
  phone: z.string().max(40).nullish(),
  email: z.string().max(120).nullish(),
  address: z.string().max(200).nullish(),
  avatar: z.string().max(400_000).regex(/^data:image\/(png|jpeg|webp);base64,/, 'Imagen inválida').nullish(),
})

export function profileRoutes(app: FastifyInstance, db: Db) {
  app.get('/me/profile', async (req) => {
    const { rows } = await db.query('SELECT id, username, name, role, phone, email, address, avatar, notif_prefs FROM users WHERE id = $1', [req.user!.id])
    const types = Object.entries(NOTIFICATION_TYPES).filter(([, d]) => can(req.user!.role, d.perm)).map(([key, d]) => ({
      key, label: d.label, hint: d.hint, inapp: wants(rows[0].notif_prefs, key, 'inapp'), push: wants(rows[0].notif_prefs, key, 'push'),
    }))
    const { rows: subs } = await db.query('SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [req.user!.id])
    return { ...rows[0], notif_prefs: undefined, notificationTypes: types, pushDevices: subs[0].n }
  })
  app.put('/me/profile', async (req) => {
    const b = profileBody.parse(req.body)
    const sets = ['name = $2', 'phone = $3', 'email = $4', 'address = $5']
    const params: unknown[] = [req.user!.id, b.name, b.phone ?? null, b.email ?? null, b.address ?? null]
    if (b.avatar !== undefined) { sets.push('avatar = $6'); params.push(b.avatar) }
    const { rows } = await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING id, username, name, role, phone, email, address, avatar`, params)
    return rows[0]
  })
  app.put('/me/notification-prefs', async (req) => {
    const b = z.record(z.string(), z.object({ inapp: z.boolean(), push: z.boolean() })).parse(req.body)
    for (const k of Object.keys(b)) if (!NOTIFICATION_TYPES[k]) throw new HttpError(400, `Tipo desconocido: ${k}`)
    await db.query(`UPDATE users SET notif_prefs = notif_prefs || $2::jsonb WHERE id = $1`, [req.user!.id, JSON.stringify(b)])
    return { ok: true }
  })
  app.post('/me/password', async (req) => {
    const b = z.object({ current: z.string(), next: z.string().min(8, 'La contraseña nueva necesita al menos 8 caracteres') }).parse(req.body)
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user!.id])
    if (!verifyPassword(b.current, rows[0].password_hash)) throw new HttpError(400, 'La contraseña actual no coincide')
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user!.id, hashPassword(b.next)])
    // Cierra las demás sesiones: quien tenga la clave vieja pierde el acceso.
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND token <> $2', [req.user!.id, req.headers.authorization?.replace(/^Bearer /, '')])
    return { ok: true }
  })

  app.get('/notifications', async (req) => {
    const { rows: me } = await db.query('SELECT notif_prefs, notif_read_id FROM users WHERE id = $1', [req.user!.id])
    const { rows } = await db.query('SELECT * FROM notifications ORDER BY id DESC LIMIT 200')
    const mine = rows.filter((n) => can(req.user!.role, n.perm) && wants(me[0].notif_prefs, n.type, 'inapp')).slice(0, 60)
    const readId = me[0].notif_read_id as number
    return {
      items: mine.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, data: n.data, created_at: n.created_at, unread: n.id > readId })),
      unread: mine.filter((n) => n.id > readId).length,
    }
  })
  app.post('/notifications/read', async (req) => {
    const { upTo } = z.object({ upTo: z.number().int().optional() }).parse(req.body ?? {})
    await db.query(`UPDATE users SET notif_read_id = GREATEST(notif_read_id, COALESCE($2, (SELECT COALESCE(MAX(id), 0) FROM notifications))) WHERE id = $1`, [req.user!.id, upTo ?? null])
    return { ok: true }
  })

  app.get('/push/public-key', async () => ({ publicKey: (await vapid(db)).publicKey }))
  app.post('/push/subscribe', async (req) => {
    const b = z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }).parse(req.body)
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`,
      [req.user!.id, b.endpoint, b.keys.p256dh, b.keys.auth, String(req.headers['user-agent'] ?? '').slice(0, 200)])
    return { ok: true }
  })
  app.post('/push/unsubscribe', async (req) => {
    const { endpoint } = z.object({ endpoint: z.string() }).parse(req.body)
    await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user!.id])
    return { ok: true }
  })
  app.post('/push/test', async (req) => {
    const { rows } = await db.query('SELECT * FROM push_subscriptions WHERE user_id = $1', [req.user!.id])
    if (!rows.length) throw new HttpError(409, 'Este usuario no tiene dispositivos con notificaciones activadas')
    const sent = await sendTo(db, rows, { title: 'Notificación de prueba', body: 'Las notificaciones push funcionan en este dispositivo.', url: '/profile', tag: 'test' })
    return { sent, devices: rows.length }
  })
}
