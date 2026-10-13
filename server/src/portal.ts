import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import PDFDocument from 'pdfkit'
import { z } from 'zod'
import { hashPassword, requirePerm, verifyPassword } from './auth.js'
import { HttpError, withTx, type Db, type Tx } from './db/client.js'
import { createOrder, orderInput, shopView } from './orders.js'
import { flowFor, logOrder, NOTIF_TYPES, notifyCustomer, stageOf, STAGE_TEXT } from './orderflow.js'
import { PUBLIC_URL } from './payments.js'
import { getSetting } from './services.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const newToken = () => randomBytes(32).toString('base64url')
const dstr = (v: unknown) => (v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10))
const strongPassword = z.string().min(8, 'La contraseña necesita al menos 8 caracteres').max(100).regex(/[A-Za-z]/, 'Incluí al menos una letra').regex(/\d/, 'Incluí al menos un número')
const nul = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)
const phone = z.preprocess(nul, z.string().trim().regex(/^[+\d][\d\s().-]{5,24}$/, 'El teléfono no es válido').nullish())

export interface Acct { id: number; email: string; customer_id: number | null }

export function portalRoutes(app: FastifyInstance, db: Db) {
  // ---------------------------------------------------------------- Sesión del cliente (separada de la del personal)
  async function auth(req: FastifyRequest): Promise<Acct & { sessionId: number }> {
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    if (!token) throw new HttpError(401, 'Iniciá sesión para continuar')
    const { rows } = await db.query(
      `SELECT a.id, a.email, a.customer_id, s.id AS session_id FROM customer_sessions s JOIN customer_accounts a ON a.id = s.account_id WHERE s.token_hash = $1 AND a.active AND s.created_at > now() - interval '30 days'`, [sha(token)])
    if (!rows[0]) throw new HttpError(401, 'Tu sesión venció. Volvé a ingresar')
    db.query('UPDATE customer_sessions SET last_seen = now() WHERE id = $1', [rows[0].session_id]).catch(() => {})
    return { id: rows[0].id, email: rows[0].email, customer_id: rows[0].customer_id, sessionId: rows[0].session_id }
  }
  async function openSession(accountId: number, req: FastifyRequest) {
    const token = newToken()
    await db.query('INSERT INTO customer_sessions (token_hash, account_id, user_agent) VALUES ($1,$2,$3)', [sha(token), accountId, String(req.headers['user-agent'] ?? '').slice(0, 160)])
    await db.query('UPDATE customer_accounts SET last_login = now(), failed_logins = 0, locked_until = NULL WHERE id = $1', [accountId])
    return token
  }
  const publicProfile = (a: any) => ({
    id: a.id, email: a.email, firstName: a.first_name, lastName: a.last_name, phone: a.phone, whatsapp: a.whatsapp, document: a.document, billingName: a.billing_name, billingDoc: a.billing_doc,
    emailVerified: a.email_verified, pendingEmail: a.pending_email, notifPrefs: a.notif_prefs, createdAt: a.created_at,
  })
  const mail = (tx: Db | Tx, to: string, subject: string, body: string, key: string) =>
    tx.query(`INSERT INTO outbox (to_phone, audience, body, dedupe_key, channel, to_email, subject) VALUES (NULL,'customer',$1,$2,'email',$3,$4) ON CONFLICT (dedupe_key) DO NOTHING`, [body, key, to, subject])
  const isDev = process.env.NODE_ENV !== 'production'

  async function issueVerification(accountId: number, email: string) {
    const token = newToken()
    await db.query('UPDATE customer_accounts SET verify_hash = $2, verify_expires = now() + interval \'48 hours\' WHERE id = $1', [accountId, sha(token)])
    await mail(db, email, 'Verificá tu correo — Librería Samantha', `Confirmá tu correo entrando a: ${PUBLIC_URL()}/tienda/verificar?token=${token}`, `verify:${accountId}:${token.slice(0, 8)}`)
    return token
  }

  // Al verificar el correo se vincula (o crea) la ficha de cliente del sistema, sin duplicar: solo por correo verificado.
  async function linkCustomer(tx: Tx, accountId: number) {
    const { rows } = await tx.query('SELECT * FROM customer_accounts WHERE id = $1 FOR UPDATE', [accountId])
    const a = rows[0]
    if (a.customer_id) return a.customer_id as number
    const { rows: ex } = await tx.query(`SELECT id FROM customers WHERE lower(email) = lower($1) AND active AND NOT account_linked ORDER BY id LIMIT 1`, [a.email])
    let cid: number
    if (ex[0]) cid = ex[0].id
    else cid = (await tx.query('INSERT INTO customers (name, ruc, phone, email, document) VALUES ($1,$2,$3,$4,$2) RETURNING id', [`${a.first_name} ${a.last_name}`, a.document, a.phone, a.email])).rows[0].id
    await tx.query('UPDATE customers SET account_linked = true, email = COALESCE(email, $2) WHERE id = $1', [cid, a.email])
    await tx.query('UPDATE customer_accounts SET customer_id = $2 WHERE id = $1', [accountId, cid])
    await tx.query('UPDATE orders SET customer_id = $2 WHERE account_id = $1 AND customer_id IS NULL', [accountId, cid])
    return cid
  }

  app.post('/account/register', async (req, reply) => {
    const b = z.object({
      firstName: z.string().trim().min(2, 'Ingresá tu nombre').max(60), lastName: z.string().trim().min(2, 'Ingresá tu apellido').max(60),
      email: z.string().trim().toLowerCase().email('El correo no es válido').max(120), password: strongPassword, confirm: z.string(),
      phone, whatsapp: phone, document: z.preprocess(nul, z.string().trim().max(30).nullish()), billingName: z.preprocess(nul, z.string().trim().max(120).nullish()),
    }).refine((x) => x.password === x.confirm, { message: 'Las contraseñas no coinciden', path: ['confirm'] }).parse(req.body)
    try {
      const { rows } = await db.query(
        `INSERT INTO customer_accounts (email, password_hash, first_name, last_name, phone, whatsapp, document, billing_name, billing_doc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7) RETURNING *`,
        [b.email, hashPassword(b.password), b.firstName, b.lastName, b.phone ?? null, b.whatsapp ?? b.phone ?? null, b.document ?? null, b.billingName ?? `${b.firstName} ${b.lastName}`])
      const token = await openSession(rows[0].id, req)
      const verify = await issueVerification(rows[0].id, b.email)
      return reply.code(201).send({ token, profile: publicProfile(rows[0]), ...(isDev ? { devVerifyToken: verify } : {}) })
    } catch (e: any) {
      if (e.code === '23505') throw new HttpError(409, 'Ya existe una cuenta con ese correo. Ingresá o recuperá tu contraseña.')
      throw e
    }
  })

  app.post('/account/login', async (req) => {
    const b = z.object({ email: z.string().trim().toLowerCase(), password: z.string().min(1) }).parse(req.body)
    const { rows } = await db.query('SELECT * FROM customer_accounts WHERE lower(email) = $1 AND active', [b.email])
    const a = rows[0]
    if (a?.locked_until && new Date(a.locked_until) > new Date()) throw new HttpError(429, 'Demasiados intentos. Probá de nuevo en unos minutos o recuperá tu contraseña.')
    if (!a || !verifyPassword(b.password, a.password_hash)) {
      if (a) await db.query(`UPDATE customer_accounts SET failed_logins = failed_logins + 1, locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END WHERE id = $1`, [a.id])
      throw new HttpError(401, 'Correo o contraseña incorrectos')
    }
    return { token: await openSession(a.id, req), profile: publicProfile(a) }
  })
  app.post('/account/logout', async (req) => {
    const a = await auth(req)
    await db.query('DELETE FROM customer_sessions WHERE id = $1', [a.sessionId])
    return { ok: true }
  })

  app.post('/account/verify', async (req) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body)
    return withTx(db, async (tx) => {
      const { rows } = await tx.query('SELECT * FROM customer_accounts WHERE verify_hash = $1 AND verify_expires > now() FOR UPDATE', [sha(token)])
      const a = rows[0]
      if (!a) throw new HttpError(400, 'El enlace de verificación no es válido o venció')
      if (a.pending_email) {
        const dup = await tx.query('SELECT 1 FROM customer_accounts WHERE lower(email) = lower($1) AND id <> $2', [a.pending_email, a.id])
        if (dup.rowCount) throw new HttpError(409, 'Ese correo ya pertenece a otra cuenta')
        await tx.query('UPDATE customer_accounts SET email = pending_email, pending_email = NULL WHERE id = $1', [a.id])
      }
      await tx.query('UPDATE customer_accounts SET email_verified = true, verify_hash = NULL, verify_expires = NULL WHERE id = $1', [a.id])
      await linkCustomer(tx, a.id)
      return { ok: true }
    })
  })
  app.post('/account/resend-verification', async (req) => {
    const a = await auth(req)
    const { rows } = await db.query('SELECT email, pending_email, email_verified FROM customer_accounts WHERE id = $1', [a.id])
    if (rows[0].email_verified && !rows[0].pending_email) throw new HttpError(409, 'Tu correo ya está verificado')
    const token = await issueVerification(a.id, rows[0].pending_email ?? rows[0].email)
    return { ok: true, ...(isDev ? { devVerifyToken: token } : {}) }
  })

  app.post('/account/forgot', async (req) => {
    const { email } = z.object({ email: z.string().trim().toLowerCase().email() }).parse(req.body)
    const { rows } = await db.query('SELECT id FROM customer_accounts WHERE lower(email) = $1 AND active', [email])
    let dev: string | undefined
    if (rows[0]) {
      const token = newToken(); dev = token
      await db.query(`UPDATE customer_accounts SET reset_hash = $2, reset_expires = now() + interval '1 hour' WHERE id = $1`, [rows[0].id, sha(token)])
      await mail(db, email, 'Recuperá tu contraseña — Librería Samantha', `Para elegir una contraseña nueva entrá a: ${PUBLIC_URL()}/tienda/restablecer?token=${token} (vence en 1 hora)`, `reset:${rows[0].id}:${token.slice(0, 8)}`)
    }
    // La respuesta es la misma exista o no la cuenta, para no revelar quién está registrado.
    return { ok: true, message: 'Si el correo está registrado, te enviamos un enlace para elegir una contraseña nueva.', ...(isDev && dev ? { devResetToken: dev } : {}) }
  })
  app.post('/account/reset', async (req) => {
    const b = z.object({ token: z.string().min(10), password: strongPassword }).parse(req.body)
    const { rows } = await db.query('SELECT id FROM customer_accounts WHERE reset_hash = $1 AND reset_expires > now()', [sha(b.token)])
    if (!rows[0]) throw new HttpError(400, 'El enlace no es válido o venció. Pedí uno nuevo.')
    await db.query('UPDATE customer_accounts SET password_hash = $2, reset_hash = NULL, reset_expires = NULL, failed_logins = 0, locked_until = NULL WHERE id = $1', [rows[0].id, hashPassword(b.password)])
    await db.query('DELETE FROM customer_sessions WHERE account_id = $1', [rows[0].id])
    return { ok: true }
  })

  // ---------------------------------------------------------------- Perfil
  app.get('/account/me', async (req) => {
    const a = await auth(req)
    const { rows } = await db.query('SELECT * FROM customer_accounts WHERE id = $1', [a.id])
    const { rows: un } = await db.query('SELECT COUNT(*)::int AS n FROM customer_notifications WHERE account_id = $1 AND read_at IS NULL', [a.id])
    return { ...publicProfile(rows[0]), unread: un[0].n, notifTypes: NOTIF_TYPES }
  })
  app.put('/account/me', async (req) => {
    const a = await auth(req)
    const b = z.object({
      firstName: z.string().trim().min(2).max(60), lastName: z.string().trim().min(2).max(60), phone, whatsapp: phone,
      document: z.preprocess(nul, z.string().trim().max(30).nullish()), billingName: z.preprocess(nul, z.string().trim().max(120).nullish()), billingDoc: z.preprocess(nul, z.string().trim().max(30).nullish()),
    }).parse(req.body)
    const { rows } = await db.query('UPDATE customer_accounts SET first_name = $2, last_name = $3, phone = $4, whatsapp = $5, document = $6, billing_name = $7, billing_doc = $8 WHERE id = $1 RETURNING *',
      [a.id, b.firstName, b.lastName, b.phone ?? null, b.whatsapp ?? null, b.document ?? null, b.billingName ?? null, b.billingDoc ?? null])
    if (a.customer_id) await db.query('UPDATE customers SET name = $2, phone = COALESCE($3, phone), ruc = COALESCE($4, ruc) WHERE id = $1', [a.customer_id, `${b.firstName} ${b.lastName}`, b.phone ?? null, b.billingDoc ?? b.document ?? null])
    return publicProfile(rows[0])
  })
  app.post('/account/me/email', async (req) => {
    const a = await auth(req)
    const b = z.object({ email: z.string().trim().toLowerCase().email('El correo no es válido'), password: z.string().min(1) }).parse(req.body)
    const { rows } = await db.query('SELECT password_hash FROM customer_accounts WHERE id = $1', [a.id])
    if (!verifyPassword(b.password, rows[0].password_hash)) throw new HttpError(403, 'La contraseña no coincide')
    if ((await db.query('SELECT 1 FROM customer_accounts WHERE lower(email) = $1', [b.email])).rowCount) throw new HttpError(409, 'Ese correo ya pertenece a otra cuenta')
    await db.query('UPDATE customer_accounts SET pending_email = $2 WHERE id = $1', [a.id, b.email])
    const token = await issueVerification(a.id, b.email)
    return { ok: true, message: `Te enviamos un enlace a ${b.email}. El correo cambia cuando lo confirmes.`, ...(isDev ? { devVerifyToken: token } : {}) }
  })
  app.post('/account/password', async (req) => {
    const a = await auth(req)
    const b = z.object({ current: z.string().min(1), next: strongPassword }).parse(req.body)
    const { rows } = await db.query('SELECT password_hash FROM customer_accounts WHERE id = $1', [a.id])
    if (!verifyPassword(b.current, rows[0].password_hash)) throw new HttpError(400, 'La contraseña actual no coincide')
    await db.query('UPDATE customer_accounts SET password_hash = $2 WHERE id = $1', [a.id, hashPassword(b.next)])
    await db.query('DELETE FROM customer_sessions WHERE account_id = $1 AND id <> $2', [a.id, a.sessionId])
    return { ok: true }
  })
  app.get('/account/sessions', async (req) => {
    const a = await auth(req)
    const { rows } = await db.query('SELECT id, user_agent, created_at, last_seen FROM customer_sessions WHERE account_id = $1 ORDER BY last_seen DESC', [a.id])
    return rows.map((r) => ({ ...r, current: r.id === a.sessionId }))
  })
  app.delete('/account/sessions/:id', async (req) => {
    const a = await auth(req)
    await db.query('DELETE FROM customer_sessions WHERE id = $1 AND account_id = $2', [Number((req.params as any).id), a.id])
    return { ok: true }
  })
  app.put('/account/prefs', async (req) => {
    const a = await auth(req)
    const b = z.record(z.string(), z.object({ inapp: z.boolean(), whatsapp: z.boolean(), email: z.boolean() })).parse(req.body)
    for (const k of Object.keys(b)) if (!NOTIF_TYPES[k]) throw new HttpError(400, 'Tipo desconocido')
    await db.query('UPDATE customer_accounts SET notif_prefs = $2 WHERE id = $1', [a.id, JSON.stringify(b)])
    return { ok: true }
  })

  // ---------------------------------------------------------------- Direcciones
  const addrBody = z.object({
    label: z.preprocess(nul, z.string().trim().max(40).nullish()), recipientName: z.preprocess(nul, z.string().trim().max(120).nullish()), recipientPhone: phone,
    department: z.preprocess(nul, z.string().trim().max(60).nullish()), cityId: z.number().int().nullish(), neighborhood: z.preprocess(nul, z.string().trim().max(80).nullish()),
    street: z.string().trim().min(3, 'Ingresá la calle').max(160), houseNumber: z.preprocess(nul, z.string().trim().max(20).nullish()), reference: z.preprocess(nul, z.string().trim().max(200).nullish()),
    instructions: z.preprocess(nul, z.string().trim().max(300).nullish()), lat: z.number().min(-90).max(90).nullish(), lng: z.number().min(-180).max(180).nullish(), isDefault: z.boolean().optional(),
  })
  const addrOut = (r: any) => ({ id: r.id, label: r.label, recipientName: r.recipient_name, recipientPhone: r.recipient_phone, department: r.department, cityId: r.city_id, cityName: r.city_name, neighborhood: r.neighborhood,
    street: r.street, houseNumber: r.house_number, reference: r.reference, instructions: r.instructions, lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng), isDefault: r.is_default })
  async function saveAddress(accountId: number, id: number | null, b: z.infer<typeof addrBody>) {
    return withTx(db, async (tx) => {
      let city: any = null
      if (b.cityId) { city = (await tx.query('SELECT id, name, department FROM geo_cities WHERE id = $1', [b.cityId])).rows[0]; if (!city) throw new HttpError(400, 'Ciudad inválida') }
      const { rows: cnt } = await tx.query('SELECT COUNT(*)::int AS n FROM customer_addresses WHERE account_id = $1 AND active', [accountId])
      const isDefault = b.isDefault || (!id && cnt[0].n === 0)
      if (isDefault) await tx.query('UPDATE customer_addresses SET is_default = false WHERE account_id = $1', [accountId])
      const vals = [b.label ?? null, b.recipientName ?? null, b.recipientPhone ?? null, city?.department ?? b.department ?? null, city?.id ?? null, city?.name ?? null, b.neighborhood ?? null, b.street, b.houseNumber ?? null, b.reference ?? null, b.instructions ?? null, b.lat ?? null, b.lng ?? null, !!isDefault]
      if (id) {
        const r = await tx.query(`UPDATE customer_addresses SET label=$3, recipient_name=$4, recipient_phone=$5, department=$6, city_id=$7, city_name=$8, neighborhood=$9, street=$10, house_number=$11, reference=$12, instructions=$13, lat=$14, lng=$15, is_default = CASE WHEN $16 THEN true ELSE is_default END WHERE id = $1 AND account_id = $2 AND active RETURNING *`, [id, accountId, ...vals])
        if (!r.rows[0]) throw new HttpError(404, 'Dirección no encontrada')
        return r.rows[0]
      }
      return (await tx.query(`INSERT INTO customer_addresses (account_id, label, recipient_name, recipient_phone, department, city_id, city_name, neighborhood, street, house_number, reference, instructions, lat, lng, is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, [accountId, ...vals])).rows[0]
    })
  }
  app.get('/account/addresses', async (req) => { const a = await auth(req); return (await db.query('SELECT * FROM customer_addresses WHERE account_id = $1 AND active ORDER BY is_default DESC, id', [a.id])).rows.map(addrOut) })
  app.post('/account/addresses', async (req, reply) => { const a = await auth(req); return reply.code(201).send(addrOut(await saveAddress(a.id, null, addrBody.parse(req.body)))) })
  app.put('/account/addresses/:id', async (req) => { const a = await auth(req); return addrOut(await saveAddress(a.id, Number((req.params as any).id), addrBody.parse(req.body))) })
  app.post('/account/addresses/:id/default', async (req) => {
    const a = await auth(req)
    const id = Number((req.params as any).id)
    await withTx(db, async (tx) => {
      const r = await tx.query('SELECT 1 FROM customer_addresses WHERE id = $1 AND account_id = $2 AND active', [id, a.id])
      if (!r.rowCount) throw new HttpError(404, 'Dirección no encontrada')
      await tx.query('UPDATE customer_addresses SET is_default = (id = $2) WHERE account_id = $1', [a.id, id])
    })
    return { ok: true }
  })
  app.delete('/account/addresses/:id', async (req) => {
    const a = await auth(req)
    const id = Number((req.params as any).id)
    // Los pedidos anteriores conservan su copia de la dirección: borrarla no los cambia.
    await db.query('UPDATE customer_addresses SET active = false, is_default = false WHERE id = $1 AND account_id = $2', [id, a.id])
    await db.query(`UPDATE customer_addresses SET is_default = true WHERE id = (SELECT id FROM customer_addresses WHERE account_id = $1 AND active ORDER BY id LIMIT 1) AND NOT EXISTS (SELECT 1 FROM customer_addresses WHERE account_id = $1 AND active AND is_default)`, [a.id])
    return { ok: true }
  })

  // ---------------------------------------------------------------- Favoritos
  const PUB = `p.id, p.name, p.short_description, p.description, p.category, p.subcategory, p.brand, p.author, p.publisher, p.edition, p.language, p.price, p.image_url, p.code, p.tax_rate,
    p.offer_enabled, p.offer_price, p.offer_pct, p.offer_start, p.offer_end, p.offer_channel, p.offer_label, p.stock, p.reserved, p.min_stock, '[]'::json AS image_ids`
  app.get('/account/favorites', async (req) => {
    const a = await auth(req)
    const { rows } = await db.query(`SELECT ${PUB} FROM customer_favorites f JOIN products p ON p.id = f.product_id WHERE f.account_id = $1 AND p.active AND p.online_visible ORDER BY f.created_at DESC`, [a.id])
    return rows.map(shopView)
  })
  app.get('/account/favorite-ids', async (req) => { const a = await auth(req); return (await db.query('SELECT product_id FROM customer_favorites WHERE account_id = $1', [a.id])).rows.map((r) => r.product_id) })
  app.post('/account/favorites/:productId', async (req) => { const a = await auth(req); await db.query('INSERT INTO customer_favorites (account_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [a.id, Number((req.params as any).productId)]); return { ok: true } })
  app.delete('/account/favorites/:productId', async (req) => { const a = await auth(req); await db.query('DELETE FROM customer_favorites WHERE account_id = $1 AND product_id = $2', [a.id, Number((req.params as any).productId)]); return { ok: true } })

  // ---------------------------------------------------------------- Pedidos del cliente
  const summary = (o: any) => ({ id: o.id, number: o.number, createdAt: o.created_at, total: Number(o.total), stage: stageOf(o), stageLabel: STAGE_TEXT[stageOf(o)].label, paymentStatus: o.payment_status, paymentMethod: o.payment_method,
    deliveryMethod: o.delivery_method, units: o.units, thumbs: o.thumbs ?? [] })
  async function actions(o: any) {
    const stage = stageOf(o)
    const out: string[] = ['message', 'reorder']
    if (o.status !== 'cancelled' && ['pending', 'rejected'].includes(o.payment_status) && o.payment_method === 'bancard') out.push('pay')
    if (o.status !== 'cancelled' && ['pending', 'rejected'].includes(o.payment_status) && o.payment_method === 'transfer') out.push('proof')
    if (o.status !== 'cancelled' && !o.cancel_requested_at && ['pending', 'confirmed', 'preparing', 'ready_to_ship'].includes(stage)) out.push('cancel')
    if (['delivered', 'picked_up', 'shipped'].includes(stage) && o.payment_status !== 'refunded') out.push('return')
    return out
  }

  app.get('/account/dashboard', async (req) => {
    const a = await auth(req)
    const { rows: orders } = await db.query('SELECT * FROM orders WHERE account_id = $1 ORDER BY id DESC', [a.id])
    const active = orders.filter((o) => o.status !== 'cancelled' && !['delivered'].includes(o.delivery_status))
    const needs: { orderId: number; number: string; kind: string; text: string }[] = []
    for (const o of active) {
      const st = stageOf(o)
      if (o.payment_status === 'pending' && o.payment_method === 'bancard') needs.push({ orderId: o.id, number: o.number, kind: 'pay', text: 'Completá el pago de tu pedido' })
      if (['pending', 'rejected'].includes(o.payment_status) && o.payment_method === 'transfer') needs.push({ orderId: o.id, number: o.number, kind: 'proof', text: o.payment_status === 'rejected' ? 'Tu comprobante fue rechazado: subí uno nuevo' : 'Subí el comprobante de tu transferencia' })
      if (st === 'ready_pickup') needs.push({ orderId: o.id, number: o.number, kind: 'pickup', text: 'Tu compra está lista para retirar en el local' })
    }
    const { rows: notes } = await db.query('SELECT id, order_id, type, title, body, read_at, created_at FROM customer_notifications WHERE account_id = $1 ORDER BY id DESC LIMIT 6', [a.id])
    const paid = orders.filter((o) => ['approved', 'partially_refunded'].includes(o.payment_status))
    return {
      stats: { orders: orders.length, active: active.length, spent: paid.reduce((s, o) => s + Number(o.paid_amount) - Number(o.refunded_amount), 0), favorites: (await db.query('SELECT COUNT(*)::int AS n FROM customer_favorites WHERE account_id = $1', [a.id])).rows[0].n },
      needs, active: active.slice(0, 5).map((o) => ({ ...summary(o), units: 0 })), notifications: notes,
    }
  })

  app.get('/account/orders', async (req) => {
    const a = await auth(req)
    const q = req.query as Record<string, string | undefined>
    const params: unknown[] = [a.id]
    const w = ['o.account_id = $1']
    const add = (v: unknown) => { params.push(v); return '$' + params.length }
    if (q.q) w.push(`o.number ILIKE ${add(`%${q.q}%`)}`)
    if (q.from) w.push(`local_date(o.created_at) >= ${add(q.from)}::date`)
    if (q.to) w.push(`local_date(o.created_at) <= ${add(q.to)}::date`)
    const size = 10, page = Math.max(1, Number(q.page) || 1)
    const { rows } = await db.query(
      `SELECT o.*, (SELECT COALESCE(SUM(qty), 0)::int FROM order_items WHERE order_id = o.id) AS units,
         (SELECT COALESCE(json_agg(p.image_url) FILTER (WHERE p.image_url IS NOT NULL), '[]') FROM (SELECT product_id FROM order_items WHERE order_id = o.id ORDER BY id LIMIT 3) x JOIN products p ON p.id = x.product_id) AS thumbs
       FROM orders o WHERE ${w.join(' AND ')} ORDER BY o.id DESC`, params)
    let list = rows.map(summary)
    if (q.stage) list = list.filter((o) => o.stage === q.stage || (q.stage === 'active' && !['delivered', 'picked_up', 'cancelled'].includes(o.stage)))
    return { items: list.slice((page - 1) * size, page * size), total: list.length, page, pages: Math.max(1, Math.ceil(list.length / size)) }
  })

  async function ownOrder(a: Acct, number: string) {
    const { rows } = await db.query('SELECT * FROM orders WHERE number = $1 AND account_id = $2', [number, a.id])
    if (!rows[0]) throw new HttpError(404, 'Pedido no encontrado')
    return rows[0]
  }
  app.get('/account/orders/:number', async (req) => {
    const a = await auth(req)
    const o = await ownOrder(a, (req.params as any).number)
    const [items, history, notes, returns, invoices, attempts] = await Promise.all([
      db.query('SELECT oi.id, oi.product_id, oi.name, oi.qty, oi.unit_price, p.image_url, p.price AS current_price FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.id', [o.id]),
      db.query('SELECT kind, from_state, to_state, title, note, at, user_id IS NOT NULL AS by_staff FROM order_history WHERE order_id = $1 AND visible ORDER BY id', [o.id]),
      db.query(`SELECT id, author_type, note, created_at FROM order_notes WHERE order_id = $1 AND (visible OR author_type = 'customer') ORDER BY id`, [o.id]),
      db.query(`SELECT r.id, r.number, r.status, r.reason, r.admin_response, r.instructions, r.refund_amount, r.created_at, (SELECT json_agg(json_build_object('name', oi.name, 'qty', ri.qty)) FROM order_return_items ri JOIN order_items oi ON oi.id = ri.order_item_id WHERE ri.return_id = r.id) AS items FROM order_returns r WHERE r.order_id = $1 ORDER BY r.id DESC`, [o.id]),
      db.query(`SELECT id, kind, number, status, total FROM invoices WHERE sale_id = $1 AND status = 'approved' ORDER BY id`, [o.sale_id ?? 0]),
      db.query('SELECT reason, at, rescheduled_for FROM delivery_attempts WHERE order_id = $1 ORDER BY id', [o.id]),
    ])
    const stage = stageOf(o)
    const reached: Record<string, string | null> = { pending: o.created_at, confirmed: o.confirmed_at, preparing: o.preparing_at, ready_to_ship: o.ready_at, ready_pickup: o.ready_at, shipped: o.dispatched_at, delivered: o.delivered_at, picked_up: o.delivered_at }
    const progress = flowFor(o.delivery_method).map((s) => ({ stage: s, label: STAGE_TEXT[s].label, text: STAGE_TEXT[s].customer, at: reached[s] ?? null, done: !!reached[s] && o.status !== 'cancelled' || (s === stage), current: s === stage }))
    const paid = Number(o.paid_amount), total = Number(o.total), refunded = Number(o.refunded_amount)
    const subtotal = items.rows.reduce((s, i) => s + Number(i.unit_price) * i.qty, 0)
    const { lookup_token: token } = o
    return {
      id: o.id, number: o.number, createdAt: o.created_at, token, stage, stageLabel: STAGE_TEXT[stage].label, stageText: STAGE_TEXT[stage].customer, status: o.status,
      cancelReason: o.cancel_reason, cancelRequested: !!o.cancel_requested_at, progress, history: history.rows, messages: notes.rows,
      items: items.rows.map((i) => ({ ...i, unit_price: Number(i.unit_price), current_price: Number(i.current_price) })),
      money: { subtotal, discount: Number(o.discount), coupon: o.coupon_code, shipping: Number(o.delivery_fee), total, paid, pending: o.status === 'cancelled' ? 0 : Math.max(total - paid, 0), refunded },
      payment: { status: o.payment_status, method: o.payment_method }, delivery: {
        method: o.delivery_method, address: o.address, city: o.city_name, department: o.department, neighborhood: o.neighborhood, reference: o.address_reference, recipientName: o.recipient_name ?? o.customer_name, recipientPhone: o.recipient_phone ?? o.phone,
        carrier: o.carrier, trackingNumber: o.tracking_number, trackingUrl: o.tracking_url, eta: dstr(o.eta_date), deliveredAt: o.delivered_at, receivedBy: o.received_by, note: o.customer_note, attempts: attempts.rows },
      billing: { name: o.billing_name ?? o.customer_name, document: o.billing_ruc ?? o.ruc }, invoices: invoices.rows, returns: returns.rows, actions: await actions(o),
    }
  })

  app.post('/account/orders', async (req, reply) => {
    const a = await auth(req)
    const body = orderInput.parse(req.body)
    const r = await createOrder(db, body, 'web', { accountId: a.id })
    return reply.code(r.duplicate ? 200 : 201).send(r)
  })
  app.post('/account/orders/:number/cancel-request', async (req) => {
    const a = await auth(req)
    const { reason } = z.object({ reason: z.string().trim().min(3, 'Contanos el motivo').max(300) }).parse(req.body)
    const o = await ownOrder(a, (req.params as any).number)
    if (!(await actions(o)).includes('cancel')) throw new HttpError(409, 'Este pedido ya no se puede cancelar: pedí una devolución')
    await withTx(db, async (tx) => {
      await tx.query('UPDATE orders SET cancel_requested_at = now(), cancel_request_reason = $2 WHERE id = $1', [o.id, reason])
      await logOrder(tx, o.id, { kind: 'order', title: 'Solicitaste cancelar el pedido', note: reason, accountId: a.id })
    })
    return { ok: true }
  })
  app.post('/account/orders/:number/message', async (req, reply) => {
    const a = await auth(req)
    const { text } = z.object({ text: z.string().trim().min(2).max(500) }).parse(req.body)
    const o = await ownOrder(a, (req.params as any).number)
    await withTx(db, async (tx) => {
      await tx.query(`INSERT INTO order_notes (order_id, author_type, account_id, visible, note) VALUES ($1,'customer',$2,true,$3)`, [o.id, a.id, text])
      await logOrder(tx, o.id, { kind: 'note', title: 'Consulta del cliente', note: text, accountId: a.id, visible: false })
    })
    return reply.code(201).send({ ok: true })
  })
  app.post('/account/orders/:number/return-request', async (req, reply) => {
    const a = await auth(req)
    const b = z.object({ reason: z.string().trim().min(3, 'Contanos el motivo').max(400), items: z.array(z.object({ orderItemId: z.number().int(), qty: z.number().int().positive() })).min(1, 'Elegí qué querés devolver'),
      photos: z.array(z.object({ filename: z.string().max(120), mime: z.string(), dataBase64: z.string() })).max(4).optional() }).parse(req.body)
    const o = await ownOrder(a, (req.params as any).number)
    if (!(await actions(o)).includes('return')) throw new HttpError(409, 'Este pedido todavía no admite devoluciones')
    const out = await withTx(db, async (tx) => {
      const { rows: items } = await tx.query('SELECT * FROM order_items WHERE order_id = $1', [o.id])
      const { rows: used } = await tx.query(`SELECT ri.order_item_id, SUM(ri.qty)::int AS n FROM order_return_items ri JOIN order_returns r ON r.id = ri.return_id WHERE r.order_id = $1 AND r.status <> 'rejected' GROUP BY 1`, [o.id])
      for (const it of b.items) {
        const oi = items.find((x) => x.id === it.orderItemId)
        if (!oi) throw new HttpError(400, 'Ese producto no es de tu pedido')
        const left = oi.qty - (used.find((u) => u.order_item_id === oi.id)?.n ?? 0)
        if (it.qty > left) throw new HttpError(409, `De "${oi.name}" solo podés devolver ${left}`)
      }
      const { rows: seq } = await tx.query(`SELECT nextval('order_return_seq') AS n`)
      const ids: number[] = []
      for (const p of b.photos ?? []) {
        if (!/^(image\/(png|jpe?g|webp))$/.test(p.mime)) throw new HttpError(400, 'Las fotos deben ser imágenes')
        const data = Buffer.from(p.dataBase64.replace(/^data:[^,]+,/, ''), 'base64')
        if (data.length > 4 * 1024 * 1024) throw new HttpError(413, 'Cada foto puede pesar hasta 4 MB')
        ids.push((await tx.query(`INSERT INTO attachments (owner_type, owner_id, filename, mime, size, data) VALUES ('order_return',$1,$2,$3,$4,$5) RETURNING id`, [o.id, p.filename, p.mime, data.length, data])).rows[0].id)
      }
      const { rows } = await tx.query(`INSERT INTO order_returns (number, order_id, account_id, reason, photo_attachment_ids) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [`DV-${String(seq[0].n).padStart(5, '0')}`, o.id, a.id, b.reason, ids])
      for (const it of b.items) await tx.query('INSERT INTO order_return_items (return_id, order_item_id, qty) VALUES ($1,$2,$3)', [rows[0].id, it.orderItemId, it.qty])
      await logOrder(tx, o.id, { kind: 'return', to: 'requested', title: 'Solicitaste una devolución', note: b.reason, accountId: a.id })
      return rows[0]
    })
    return reply.code(201).send({ id: out.id, number: out.number, status: out.status })
  })
  // "Volver a comprar": devuelve los productos con el precio y la disponibilidad de hoy; el cliente confirma en el carrito.
  app.post('/account/orders/:number/reorder', async (req) => {
    const a = await auth(req)
    const o = await ownOrder(a, (req.params as any).number)
    const { rows } = await db.query(
      `SELECT oi.qty, oi.unit_price AS old_price, ${PUB} FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 AND p.active AND p.online_visible AND p.kind = 'product' ORDER BY oi.id`, [o.id])
    const items = rows.map((r) => { const v: any = shopView(r); return { id: v.id, name: v.name, qty: r.qty, price: v.price, listPrice: v.list_price, oldPrice: Number(r.old_price), image: v.image_url, availability: v.availability, priceChanged: v.price !== Number(r.old_price) } })
    return { items, unavailable: items.filter((i) => i.availability === 'out').map((i) => i.name) }
  })
  app.get('/account/orders/:number/invoice/:invoiceId', async (req, reply) => {
    const a = await auth(req)
    const o = await ownOrder(a, (req.params as any).number)
    const { rows } = await db.query(`SELECT * FROM invoices WHERE id = $1 AND sale_id = $2 AND status = 'approved'`, [Number((req.params as any).invoiceId), o.sale_id ?? 0])
    if (!rows[0]) throw new HttpError(404, 'Comprobante no disponible')
    const inv = rows[0]
    const { rows: items } = await db.query('SELECT name, qty, unit_price, total FROM sale_items WHERE sale_id = $1 ORDER BY id', [o.sale_id])
    const shop = await getSetting(db, 'shop')
    const doc = new PDFDocument({ size: 'A4', margin: 44 })
    const chunks: Buffer[] = []
    doc.on('data', (c) => chunks.push(c))
    const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))))
    const gs = (n: number) => 'Gs. ' + Math.round(Number(n)).toLocaleString('es-PY')
    doc.fontSize(18).text(shop.name ?? 'Librería Samantha').fontSize(9).fillColor('#555').text(shop.address ?? '').fillColor('#000').moveDown()
    doc.fontSize(14).text(`${inv.kind === 'credit_note' ? 'Nota de crédito' : 'Factura'} ${inv.number}`).fontSize(10).text(`Fecha: ${new Date(inv.created_at).toLocaleDateString('es-PY')}   Pedido: ${o.number}`)
    doc.text(`Cliente: ${inv.customer_name}${inv.customer_ruc ? ' · RUC/CI ' + inv.customer_ruc : ''}`).moveDown(0.6)
    for (const i of items) { const y = doc.y; doc.text(`${i.qty} x ${i.name}`, 44, y, { width: 330 }).text(gs(i.unit_price), 380, y, { width: 70, align: 'right' }).text(gs(i.total), 455, y, { width: 90, align: 'right' }) }
    doc.moveDown().font('Helvetica-Bold').text(`Total: ${gs(inv.total)}`, { align: 'right' }).font('Helvetica').fontSize(9)
    doc.text(`IVA 10%: ${gs(inv.tax10)}   IVA 5%: ${gs(inv.tax5)}   Exento: ${gs(inv.exempt)}`, { align: 'right' })
    if (inv.cdc) doc.moveDown().text(`CDC: ${inv.cdc}`)
    doc.end()
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${inv.number}.pdf"`).send(await done)
  })

  // ---------------------------------------------------------------- Notificaciones del cliente
  app.get('/account/notifications', async (req) => {
    const a = await auth(req)
    const { rows } = await db.query(`SELECT n.id, n.type, n.title, n.body, n.read_at, n.created_at, o.number AS order_number FROM customer_notifications n LEFT JOIN orders o ON o.id = n.order_id WHERE n.account_id = $1 ORDER BY n.id DESC LIMIT 80`, [a.id])
    return { items: rows, unread: rows.filter((r) => !r.read_at).length }
  })
  app.post('/account/notifications/read', async (req) => {
    const a = await auth(req)
    await db.query('UPDATE customer_notifications SET read_at = now() WHERE account_id = $1 AND read_at IS NULL', [a.id])
    return { ok: true }
  })
}

// ---------------------------------------------------------------- Lado administrativo: ficha de cliente con su actividad en la tienda
export function portalAdminRoutes(app: FastifyInstance, db: Db) {
  app.get('/customers/:id/portal', async (req) => {
    requirePerm(req, 'customers.read')
    const id = Number((req.params as any).id)
    const [acc, orders, local] = await Promise.all([
      db.query('SELECT id, email, first_name, last_name, phone, whatsapp, document, billing_name, billing_doc, email_verified, created_at, last_login FROM customer_accounts WHERE customer_id = $1', [id]),
      db.query(`SELECT id, number, created_at, total, status, payment_status, delivery_status, delivery_method, confirmed_at, dispatched_at, ready_at FROM orders WHERE customer_id = $1 ORDER BY id DESC LIMIT 50`, [id]),
      db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total) FILTER (WHERE status = 'completed'), 0)::bigint AS total, MAX(created_at) AS last FROM sales WHERE customer_id = $1`, [id]),
    ])
    const addresses = acc.rows[0] ? (await db.query('SELECT label, recipient_name, department, city_name, neighborhood, street, house_number, reference, is_default FROM customer_addresses WHERE account_id = $1 AND active ORDER BY is_default DESC, id', [acc.rows[0].id])).rows : []
    return {
      account: acc.rows[0] ?? null, addresses,
      orders: orders.rows.map((o) => ({ ...o, stage: stageOf(o), stage_label: STAGE_TEXT[stageOf(o)].label })),
      stats: { purchases: local.rows[0].n, total: Number(local.rows[0].total), lastPurchase: local.rows[0].last, onlineOrders: orders.rows.length, pendingPayments: orders.rows.filter((o) => o.status !== 'cancelled' && ['pending', 'in_review', 'rejected'].includes(o.payment_status)).length },
    }
  })
  app.post('/customers/:id/link-account', async (req) => {
    requirePerm(req, 'customers.write')
    const id = Number((req.params as any).id)
    const { accountId } = z.object({ accountId: z.number().int() }).parse(req.body)
    await withTx(db, async (tx) => {
      const { rows } = await tx.query('SELECT * FROM customer_accounts WHERE id = $1 FOR UPDATE', [accountId])
      if (!rows[0]) throw new HttpError(404, 'Cuenta inexistente')
      if (!rows[0].email_verified) throw new HttpError(409, 'La cuenta todavía no verificó su correo')
      if (rows[0].customer_id && rows[0].customer_id !== id) throw new HttpError(409, 'La cuenta ya está vinculada a otra ficha')
      await tx.query('UPDATE customer_accounts SET customer_id = $2 WHERE id = $1', [accountId, id])
      await tx.query('UPDATE customers SET account_linked = true WHERE id = $1', [id])
      await tx.query('UPDATE orders SET customer_id = $2 WHERE account_id = $1', [accountId, id])
    })
    return { ok: true }
  })
  app.get('/customer-accounts', async (req) => {
    requirePerm(req, 'customers.read')
    const { q } = req.query as { q?: string }
    const { rows } = await db.query(`SELECT id, email, first_name, last_name, document, email_verified, customer_id, created_at FROM customer_accounts WHERE ($1::text IS NULL OR email ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1 OR document ILIKE $1) ORDER BY id DESC LIMIT 50`, [q ? `%${q}%` : null])
    return rows
  })
}
