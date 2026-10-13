import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from './db/client.js'
import { createOrder } from './orders.js'
import { enqueue, getSetting } from './services.js'
import { createWorkOrder } from './routes/workorders.js'
import { aiActive, aiCredentials, aiReply, cleanPrompt } from './ai.js'
import { notify } from './notifications.js'
import { effectivePrice } from './pricing.js'

// El asistente conversa; el sistema valida precios, stock y pagos. Nunca confirma un pago por lo que diga el cliente.
// La función `reply` es el punto de enchufe: hoy usa reglas; se puede reemplazar por un modelo de IA
// que llame a estas mismas operaciones (buscar, carrito, pedido) sin tocar el resto del sistema.

interface Item { productId: number; name: string; price: number; qty: number }
interface State {
  cart: Item[]
  results?: { id: number; name: string; price: number; available: number }[]
  step?: 'name' | 'delivery' | 'zone' | 'address' | 'confirm'
  draft?: { name?: string; method?: 'pickup' | 'delivery'; zoneId?: number; address?: string }
}

const gs = (n: number) => 'Gs. ' + n.toLocaleString('es-PY')
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()

function cartText(cart: Item[]) {
  if (!cart.length) return 'Tu carrito está vacío.'
  const total = cart.reduce((s, i) => s + i.price * i.qty, 0)
  return cart.map((i, n) => `${n + 1}. ${i.qty} x ${i.name} — ${gs(i.price * i.qty)}`).join('\n') + `\nTotal productos: ${gs(total)}`
}

const MENU = 'Puedo ayudarte con:\n• Buscar productos (escribí el nombre, ej. "cuaderno")\n• "lista <colegio>" para listas escolares\n• "carrito", "quitar N", "confirmar"\n• "estado P-000123" para ver un pedido\n• "imprimir 20 copias de ..." para pedir un presupuesto\n• horarios y ubicación'

// Búsqueda tolerante: sin tildes, plurales ("cuadernos" → "cuaderno") y varias palabras (todas deben aparecer).
const FOLD = "translate(lower(%s), 'áéíóúüñ', 'aeiouun')"
const STOP = new Set(['para', 'con', 'una', 'uno', 'unos', 'unas', 'los', 'las', 'del', 'que', 'mis', 'mas', 'por', 'hay', 'tienen', 'tenes', 'busco', 'quiero', 'necesito', 'hijo', 'hija'])
const stem = (w: string) => (w.length > 4 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)
async function search(db: Db, q: string) {
  const terms = norm(q).replace(/[^a-z0-9ñ\s-]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem).slice(0, 5)
  if (!terms.length) return []
  const col = (c: string) => FOLD.replace('%s', c)
  const params: unknown[] = []
  // Puntaje: cada palabra que aparece en nombre, autor, marca o categoría suma; gana el que más coincide.
  const hits = terms.map((w) => {
    params.push(`%${w}%`)
    const i = params.length
    return `(CASE WHEN ${col('name')} LIKE $${i} OR ${col("coalesce(author,'')")} LIKE $${i} OR ${col("coalesce(brand,'')")} LIKE $${i} OR ${col('category')} LIKE $${i} THEN 1 ELSE 0 END)`
  })
  params.push(q.trim())
  const score = hits.join(' + ')
  const { rows } = await db.query(
    `SELECT id, name, price, offer_enabled, offer_price, offer_pct, offer_start, offer_end, offer_channel, offer_label, GREATEST(stock - reserved, 0) AS available, (${score}) AS score FROM products
     WHERE active AND online_visible AND kind = 'product' AND ((${score}) > 0 OR isbn = $${params.length})
     ORDER BY (${score}) DESC, (stock - reserved > 0) DESC, name LIMIT 5`, params)
  return rows.map((r) => ({ id: r.id as number, name: r.name as string, price: effectivePrice(r, 'online').price, available: Number(r.available) }))
}

export async function chatReply(db: Db, channel: 'web' | 'whatsapp', externalId: string, text: string): Promise<string> {
  // Aviso al equipo cuando alguien empieza a escribir (una vez por conversación cada 30 minutos).
  if (!externalId.startsWith('admin-')) {
    const bucket = Math.floor(Date.now() / (30 * 60_000))
    await notify(db, {
      type: 'chat_inquiry', title: channel === 'whatsapp' ? 'Consulta por WhatsApp' : 'Consulta en la tienda',
      body: `${channel === 'whatsapp' ? externalId + ': ' : ''}${text.slice(0, 140)}`, link: '/orders', dedupeKey: `chat:${channel}:${externalId}:${bucket}`,
    }).catch(() => {})
  }
  const { rows: ss } = await db.query(
    `INSERT INTO chat_sessions (channel, external_id) VALUES ($1,$2) ON CONFLICT (channel, external_id) DO UPDATE SET updated_at = now() RETURNING *`, [channel, externalId])
  const session = ss[0]
  const state: State = { cart: [], ...session.state }
  await db.query('INSERT INTO chat_messages (session_id, role, body) VALUES ($1,$2,$3)', [session.id, 'user', text])
  const answer = await handle(db, channel, externalId, state, text)
  await db.query('UPDATE chat_sessions SET state = $2, updated_at = now() WHERE id = $1', [session.id, JSON.stringify(state)])
  await db.query('INSERT INTO chat_messages (session_id, role, body) VALUES ($1,$2,$3)', [session.id, 'bot', answer])
  return answer
}

async function handle(db: Db, channel: string, externalId: string, st: State, raw: string): Promise<string> {
  const t = norm(raw)

  // --- Flujo de confirmación del pedido
  if (st.step) {
    if (/^(cancelar|salir|no)$/.test(t)) { st.step = undefined; st.draft = undefined; return 'Listo, cancelé la confirmación. Tu carrito sigue guardado.' }
    st.draft ??= {}
    if (st.step === 'name') {
      if (raw.trim().length < 2) return '¿A nombre de quién preparo el pedido?'
      st.draft.name = raw.trim(); st.step = 'delivery'
      return 'Gracias. ¿Retirás en el local o querés delivery? (respondé "retiro" o "delivery")'
    }
    if (st.step === 'delivery') {
      if (t.startsWith('retiro') || t.startsWith('retirar')) { st.draft.method = 'pickup'; st.step = 'confirm' }
      else if (t.startsWith('deliv') || t.includes('envio')) {
        st.draft.method = 'delivery'; st.step = 'zone'
        const { rows } = await db.query('SELECT id, name, fee FROM delivery_zones WHERE active ORDER BY name')
        if (!rows.length) { st.step = 'delivery'; return 'Por ahora no tenemos zonas de delivery cargadas. ¿Retirás en el local?' }
        return 'Elegí tu zona (respondé con el número):\n' + rows.map((z, i) => `${i + 1}. ${z.name} — envío ${gs(Number(z.fee))}`).join('\n')
      } else return 'Respondé "retiro" o "delivery".'
    }
    if (st.step === 'zone') {
      const { rows } = await db.query('SELECT id FROM delivery_zones WHERE active ORDER BY name')
      const n = parseInt(t, 10)
      if (!rows[n - 1]) return 'Elegí una zona con su número.'
      st.draft.zoneId = rows[n - 1].id; st.step = 'address'
      return '¿Cuál es la dirección de entrega (con una referencia)?'
    }
    if (st.step === 'address') { st.draft.address = raw.trim(); st.step = 'confirm' }
    if (st.step === 'confirm') {
      if (!st.draft.name && st.draft.method) { /* nombre ya capturado antes */ }
      const summary = `Resumen:\n${cartText(st.cart)}\nEntrega: ${st.draft.method === 'pickup' ? 'retiro en local' : 'delivery — ' + st.draft.address}\n`
      if (t === 'si' || t === 'confirmo' || t === 'confirmar' || t === 'ok') {
        const phone = channel === 'whatsapp' ? externalId : 'sin-telefono'
        try {
          const { order, payment } = await createOrder(db, {
            customer: { name: st.draft.name!, phone: phone.length >= 6 ? phone : '000000' },
            items: st.cart.map((i) => ({ productId: i.productId, qty: i.qty })),
            delivery: { method: st.draft.method!, zoneId: st.draft.zoneId, address: st.draft.address },
          }, channel === 'whatsapp' ? 'whatsapp' : 'web')
          st.cart = []; st.step = undefined; st.draft = undefined
          return `Pedido ${order.number} creado por ${gs(Number(order.total))}. Reservé tu stock por unos minutos.\nPagá acá: ${payment!.url}\nCuando el pago se confirme te aviso. (Tu código de seguimiento: ${order.lookup_token})`
        } catch (e: any) { st.step = undefined; return `No pude crear el pedido: ${e.message}. Revisá tu carrito con "carrito".` }
      }
      return summary + '¿Confirmo el pedido y te envío el enlace de pago? (sí / cancelar)'
    }
  }

  if (/^(hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches|menu|ayuda)/.test(t) && t.length <= 24) return '¡Hola! Soy el asistente de Librería Samantha. ' + MENU

  if (/horario|abren|cierran|hora de atencion/.test(t)) { const s = await getSetting(db, 'shop'); return `Atendemos: ${s.hours}.` }
  if (/direccion|ubicacion|donde (estan|queda)|como llegar/.test(t)) { const s = await getSetting(db, 'shop'); return s.address ? `Estamos en: ${s.address}.` : 'Escribinos por acá y te pasamos la ubicación.' }

  // --- Estado de pedido (solo con el teléfono del cliente o el código de seguimiento)
  const ord = raw.match(/\bP-\d{6}\b/i)
  if (ord || t.startsWith('estado')) {
    if (!ord) return 'Indicame el número de pedido, por ejemplo "estado P-000123".'
    const { rows } = await db.query('SELECT * FROM orders WHERE number = $1', [ord[0].toUpperCase()])
    const o = rows[0]
    const tokenOk = o && raw.includes(o.lookup_token)
    if (!o || !(tokenOk || (channel === 'whatsapp' && o.phone === externalId))) return 'No encontré ese pedido con tus datos. Si lo hiciste en la web, agregá el código de seguimiento.'
    const pay = { pending: 'pendiente de pago', approved: 'pago aprobado', rejected: 'pago rechazado', refunded: 'reembolsado', partially_refunded: 'reembolso parcial' }[o.payment_status as string]
    const del = { pending: 'sin preparar', preparing: 'en preparación', ready: 'listo para retirar', dispatched: 'despachado', delivered: 'entregado' }[o.delivery_status as string]
    return `Pedido ${o.number}: ${pay}; entrega: ${del}. Total ${gs(Number(o.total))}.`
  }

  // --- Solicitud de impresión (queda como presupuesto; el encargado confirma antes de cobrar)
  const pr = t.match(/imprimir\s+(\d+)\s+(?:copias?\s+)?(?:de\s+)?(.+)/)
  if (pr) {
    const wo = await createWorkOrder(db, { description: pr[2], copies: Number(pr[1]), pages: 1, color: /color/.test(t), paper: 'A4', phone: channel === 'whatsapp' ? externalId : null, customerName: 'Cliente chat', source: channel === 'whatsapp' ? 'whatsapp' : 'web' })
    await enqueue(db, { audience: 'manager', dedupeKey: `wo-new:${wo.id}`, body: `Solicitud de impresión ${wo.number} por chat: ${pr[2]} (${pr[1]} copias).` })
    return `Registré tu solicitud ${wo.number}. Presupuesto estimado: ${gs(Number(wo.price))}. El encargado la revisa y te confirma antes de cobrar. Enviá el archivo por este medio.`
  }

  // --- Listas escolares
  const lst = t.match(/^lista\s+(.+)/)
  if (lst) {
    const { rows } = await db.query(`SELECT id, school, grade FROM school_lists WHERE active AND (school ILIKE $1 OR grade ILIKE $1) ORDER BY school, grade LIMIT 8`, [`%${lst[1]}%`])
    if (!rows.length) return 'No encontré listas para ese colegio o grado.'
    return 'Encontré:\n' + rows.map((r) => `• Lista #${r.id}: ${r.school} — ${r.grade}`).join('\n') + '\nEscribí "agregar lista N" para sumarla al carrito.'
  }
  const addList = t.match(/^agregar lista\s+(\d+)/)
  if (addList) {
    const { rows } = await db.query(
      `SELECT p.id, p.name, p.price, i.qty, GREATEST(p.stock - p.reserved, 0) AS available FROM school_list_items i JOIN products p ON p.id = i.product_id WHERE i.list_id = $1`, [Number(addList[1])])
    if (!rows.length) return 'No encontré esa lista.'
    const missing: string[] = []
    for (const r of rows) {
      if (Number(r.available) < r.qty) { missing.push(r.name); continue }
      const ex = st.cart.find((c) => c.productId === r.id)
      if (ex) ex.qty += r.qty; else st.cart.push({ productId: r.id, name: r.name, price: Number(r.price), qty: r.qty })
    }
    return `Agregué la lista.\n${cartText(st.cart)}` + (missing.length ? `\nSin stock suficiente (no agregados): ${missing.join(', ')}.` : '') + '\nEscribí "confirmar" para continuar.'
  }

  // --- Carrito
  if (/^carrito/.test(t)) return cartText(st.cart)
  const rm = t.match(/^quitar\s+(\d+)/)
  if (rm) { st.cart.splice(Number(rm[1]) - 1, 1); return cartText(st.cart) }
  if (/^(confirmar|comprar|pagar|finalizar)/.test(t)) {
    if (!st.cart.length) return 'Tu carrito está vacío. Buscá un producto para empezar.'
    st.step = 'name'
    return `${cartText(st.cart)}\n¿A nombre de quién preparo el pedido?`
  }

  // --- Agregar un resultado: "agregar 2" o "agregar 2 x 3" / "quiero 3 del 2"
  const add = t.match(/^(?:agregar|sumar|quiero|llevo)\s+(\d+)(?:\s*(?:x|por|unidades?)\s*(\d+))?$/)
  if (add && st.results?.length) {
    const r = st.results[Number(add[1]) - 1]
    const qty = Number(add[2] ?? 1)
    if (!r) return 'No encontré esa opción. Elegí un número de la lista.'
    if (r.available < qty) return `Por ahora no tenemos esa cantidad de "${r.name}" disponible. Probá con menos unidades o consultá más tarde.`
    const ex = st.cart.find((c) => c.productId === r.id)
    if (ex) ex.qty += qty; else st.cart.push({ productId: r.id, name: r.name, price: r.price, qty })
    return `Agregué ${qty} x ${r.name}.\n${cartText(st.cart)}\nPodés seguir buscando o escribir "confirmar".`
  }

  // --- Preguntas frecuentes: se responden con lo cargado en el área de prompts (sin IA)
  const FAQ: [RegExp, string][] = [
    [/\b(envio|envios|delivery|domicilio|reparto)\b/, 'envios'],
    [/\b(pago|pagos|tarjeta|transferencia|cuotas|efectivo)\b/, 'pagos'],
    [/\b(devolucion|devolver|cambio|cambiar|garantia)\b/, 'cambios'],
    [/\b(listas? escolar(es)?)\b/, 'escolares'],
  ]
  const faq = async (): Promise<string | null> => {
    for (const [re, slug] of FAQ) {
      if (!re.test(t)) continue
      const { rows } = await db.query('SELECT content FROM ai_prompts WHERE slug = $1 AND active', [slug])
      const text = rows[0] ? cleanPrompt(rows[0].content) : ''
      if (!text) continue
      let extra = ''
      if (slug === 'envios') {
        const { rows: z } = await db.query('SELECT name, fee FROM delivery_zones WHERE active ORDER BY name')
        if (z.length) extra = '\nZonas y tarifas: ' + z.map((r) => `${r.name} (${gs(Number(r.fee))})`).join('; ') + '.'
      }
      return text + extra
    }
    return null
  }
  // Con la IA encendida contesta ella; si falla (sin saldo, sin red), se usan estas respuestas.
  if (!(await aiActive(db))) { const a = await faq(); if (a) return a }

  // --- Búsqueda
  const q = raw.replace(/^(buscar|busco|tenes|tienen|quiero|necesito)\s+/i, '').trim()
  if (q.length < 2) return MENU
  const found = await search(db, q)
  st.results = found
  const ai = await aiReply(db, { channel, externalId, message: raw, found: found.map((f, i) => ({ n: i + 1, name: f.name, price: f.price, available: f.available })) })
  if (ai) return ai.text
  const fallback = await faq()
  if (fallback) return fallback
  if (!found.length) return `No encontré "${q}". Probá con otro nombre o escribí "ayuda".`
  return found.map((r, i) => `${i + 1}. ${r.name} — ${gs(r.price)} ${r.available > 0 ? '(disponible)' : '(sin stock)'}`).join('\n') +
    '\nEscribí "agregar N" (o "agregar N x cantidad") para sumarlo al carrito.'
}

// Prueba desde el área de prompts: responde como lo haría el chat y dice qué motor contestó.
export async function testChat(db: Db, message: string, userId: number) {
  const cfg = await getSetting(db, 'ai')
  const found = (await search(db, message.replace(/^(buscar|busco|tenes|tienen|quiero|necesito)\s+/i, '').trim())).map((f, i) => ({ n: i + 1, name: f.name, price: f.price, available: f.available }))
  const ai = await aiReply(db, { channel: 'test', externalId: `admin-${userId}`, message, found })
  if (ai) return { reply: ai.text, source: 'ai' as const, model: ai.model, usage: ai.usage }
  const why = !cfg.enabled ? 'La IA está apagada en la configuración.' : !(await aiCredentials(db)) ? 'Falta la clave de la API: cargala en Configuración.' : 'La IA no respondió; revisá los registros del servidor.'
  return { reply: await chatReply(db, 'web', `admin-test-${userId}`, message), source: 'rules' as const, why }
}

export function chatRoutes(app: FastifyInstance, db: Db) {
  // Chat de la web: la identidad es un id de sesión anónimo generado por el navegador.
  app.post('/chat', async (req) => {
    const b = z.object({ sessionId: z.string().min(8).max(64), message: z.string().min(1).max(500) }).parse(req.body)
    return { reply: await chatReply(db, 'web', b.sessionId, b.message) }
  })
}

export function winsapWebhookRoutes(app: FastifyInstance, db: Db) {
  // Entrada de mensajes de WhatsApp vía Winsap. El formato exacto y la autenticación del webhook
  // se ajustan cuando se confirme su documentación; el secreto compartido evita mensajes falsos.
  app.post('/winsap', async (req, reply) => {
    const secret = process.env.WINSAP_WEBHOOK_SECRET
    if (secret && req.headers['x-webhook-secret'] !== secret) return reply.code(403).send({ error: 'Firma inválida' })
    const b = z.object({ from: z.string().min(6), text: z.string().min(1).max(1000) }).parse(req.body)
    const answer = await chatReply(db, 'whatsapp', b.from, b.text)
    await enqueue(db, { phone: b.from, body: answer })
    return { ok: true }
  })
}
