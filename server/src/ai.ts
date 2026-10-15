import Anthropic from '@anthropic-ai/sdk'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePerm } from './auth.js'
import { HttpError, type Db } from './db/client.js'
import { deleteSecret, getSecret, setSecret } from './secrets.js'
import { getSetting } from './services.js'

// ---------------------------------------------------------------- Prompts editables
const DEFAULTS: { slug: string; title: string; kind: 'system' | 'rules' | 'knowledge'; sort: number; content: string }[] = [
  {
    slug: 'identidad', title: 'Identidad y tono', kind: 'system', sort: 10,
    content: `Sos el asistente virtual de Samantha — Libros y regalos, una librería cristiana de Paraguay. Vendemos Biblias, devocionales, libros para niños, adolescentes, jóvenes, mujeres, hombres y matrimonios, agendas, regalos, y también útiles escolares y de oficina. Hacemos envíos a todo el país. Nuestro lema: «historias que transforman vidas».
Hablás en español paraguayo, tuteando con "vos", con un tono cálido, respetuoso y claro. Sos breve y concreto. Los precios se escriben en guaraníes con el formato "Gs. 12.000".
Tu trabajo es ayudar a elegir productos, informar precios y disponibilidad, explicar envíos y formas de pago, y acompañar al cliente hasta tener su pedido y poder seguirlo.`,
  },
  {
    slug: 'reglas', title: 'Reglas que nunca se rompen', kind: 'rules', sort: 20,
    content: `- Usá únicamente los datos del contexto y de las herramientas (productos, precios, stock, envíos, pedidos). Si no tenés un dato, decilo y ofrecé derivar con una persona del equipo por WhatsApp.
- No inventes precios, stock, plazos ni promociones. No negocies descuentos ni hagas excepciones de precio.
- Nunca confirmes que un pago fue recibido: lo confirma el sistema cuando el proveedor de pagos avisa. Para saber si un pedido está pagado, consultá su estado.
- No des datos de otros clientes, ni costos, ni información interna. Los datos de un pedido solo se muestran con sesión iniciada, o con el número de pedido más el código de seguimiento o el teléfono de la compra.
- No pidas ni recibas contraseñas, números de tarjeta ni datos bancarios por chat.
- Si el cliente está molesto o pide una devolución, una factura o hablar con una persona, ofrecé el WhatsApp del local.`,
  },
  {
    slug: 'envios', title: 'Envíos y delivery', kind: 'knowledge', sort: 30,
    content: `Ofrecemos retiro en el local (sin costo) y delivery. El delivery se cotiza por zona y el costo de envío se muestra antes de confirmar el pedido.
Completar: tiempos de entrega, horarios de reparto y cobertura exacta.`,
  },
  {
    slug: 'pagos', title: 'Formas de pago', kind: 'knowledge', sort: 40,
    content: `En la tienda en línea se paga con tarjeta mediante un enlace de pago seguro. En el local se acepta efectivo, tarjeta y transferencia.
Completar: bancos para transferencia, cuotas disponibles y condiciones de venta a crédito para colegios y empresas.`,
  },
  {
    slug: 'cambios', title: 'Cambios y devoluciones', kind: 'knowledge', sort: 50,
    content: `Completar: plazo para cambios, estado en que debe estar el producto, quién cubre el envío de devolución y cómo se reembolsa.`,
  },
  {
    slug: 'impresiones', title: 'Servicios de impresión', kind: 'knowledge', sort: 60,
    content: `Hacemos impresiones y fotocopias en blanco y negro o color, y terminaciones como anillado y plastificado. Las tarifas por hoja y por terminación se informan al pedir el presupuesto.
El cliente puede pedir un presupuesto escribiendo, por ejemplo, "imprimir 20 copias de ..."; el encargado lo confirma antes de cobrar y avisa cuando el trabajo está listo.`,
  },
  {
    slug: 'escolares', title: 'Listas escolares', kind: 'knowledge', sort: 70,
    content: `Tenemos listas armadas por colegio y grado; el cliente escribe "lista" y el nombre del colegio. También puede mandar la foto de su lista por WhatsApp para que el equipo la revise.`,
  },
]

// Las líneas "Completar: …" son recordatorios para el equipo, no información para el cliente.
export const cleanPrompt = (t: string) => t.split('\n').filter((l) => !/^\s*Completar\b/i.test(l)).join('\n').trim()

export async function ensureDefaultPrompts(db: Db) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM ai_prompts')
  if (rows[0].n > 0) return
  for (const p of DEFAULTS) {
    await db.query('INSERT INTO ai_prompts (slug, title, kind, content, sort) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (slug) DO NOTHING', [p.slug, p.title, p.kind, p.content, p.sort])
  }
}

// Datos vivos del negocio que se inyectan siempre (no los edita el usuario).
async function liveFacts(db: Db) {
  const shop = await getSetting(db, 'shop')
  const print = await getSetting(db, 'print')
  const { rows: zones } = await db.query('SELECT name, fee FROM delivery_zones WHERE active ORDER BY name')
  const { rows: cats } = await db.query(`SELECT DISTINCT category FROM products WHERE active AND online_visible AND kind = 'product' ORDER BY 1`)
  const gs = (n: number) => 'Gs. ' + Number(n).toLocaleString('es-PY')
  return [
    `Local: ${shop.name ?? 'Librería Samantha'}. Dirección: ${shop.address || 'sin cargar'}. Horarios: ${shop.hours || 'sin cargar'}. WhatsApp: ${shop.whatsapp || 'sin cargar'}.`,
    zones.length ? `Zonas de delivery: ${zones.map((z) => `${z.name} (${gs(z.fee)})`).join('; ')}.` : 'Zonas de delivery: todavía no hay zonas cargadas.',
    `Categorías de la tienda: ${cats.map((c) => c.category).join(', ') || 'sin productos'}.`,
    `Tarifas de impresión por hoja: blanco y negro ${gs(print.bw ?? 0)}, color ${gs(print.color ?? 0)}. Terminaciones por copia: ${Object.entries(print.finishing ?? {}).map(([k, v]) => `${k} ${gs(Number(v))}`).join(', ')}.`,
  ].join('\n')
}

// Identidad, reglas y conocimiento del negocio (lo que se edita en «Asistente con IA») + datos vivos. Lo usa el agente de la tienda.
export async function assembleKnowledge(db: Db) {
  const { rows } = await db.query('SELECT * FROM ai_prompts WHERE active ORDER BY sort, id')
  const block = (kind: string, head: string) => {
    const items = rows.filter((r) => r.kind === kind)
    return items.length ? `# ${head}\n` + items.map((r) => (kind === 'knowledge' ? `## ${r.title}\n${cleanPrompt(r.content)}` : r.content)).join('\n\n') : ''
  }
  return [block('system', 'Quién sos'), block('rules', 'Reglas del negocio'), block('knowledge', 'Información del negocio'), `# Datos actuales del negocio (siempre vigentes)\n${await liveFacts(db)}`].filter(Boolean).join('\n\n')
}

export async function assembleSystemPrompt(db: Db) {
  const { rows } = await db.query('SELECT * FROM ai_prompts WHERE active ORDER BY sort, id')
  const block = (kind: string, head: string) => {
    const items = rows.filter((r) => r.kind === kind)
    return items.length ? `# ${head}\n` + items.map((r) => (kind === 'knowledge' ? `## ${r.title}\n${cleanPrompt(r.content)}` : r.content)).join('\n\n') : ''
  }
  const facts = await liveFacts(db)
  return [
    block('system', 'Quién sos'),
    block('rules', 'Reglas'),
    block('knowledge', 'Información del negocio'),
    `# Datos actuales del negocio (siempre vigentes)\n${facts}`,
    `# Cómo responder\nCuando el mensaje del cliente venga con "Productos encontrados", presentá solo esos productos, con el mismo número, y cerrá indicando que escriba exactamente "agregar N" (por ejemplo "agregar 1") o "agregar N x 3" para varias unidades. Si no hay coincidencias, decilo y sugerí otra búsqueda.
Escribí en texto plano: sin Markdown, sin asteriscos ni negritas, y sin muletillas en otros idiomas.`,
  ].filter(Boolean).join('\n\n')
}

// ---------------------------------------------------------------- Llamada al modelo
// Proveedores de IA: Niro (formato OpenAI, https://niro.cnid.com.py/docs) o Claude de Anthropic.
export type Provider = 'niro' | 'anthropic'
export const NIRO_URL = 'https://niro.cnid.com.py'

export async function aiProvider(db: Db): Promise<Provider> {
  return (await getSetting(db, 'ai')).provider === 'anthropic' ? 'anthropic' : 'niro'
}

// La clave puede cargarse desde Configuración (cifrada en la base) o por variable de entorno.
export async function aiCredentials(db: Db, provider?: Provider): Promise<{ apiKey: string; source: 'database' | 'env'; provider: Provider } | null> {
  const p = provider ?? (await aiProvider(db))
  const stored = (await getSecret(db, `ai_api_key_${p}`)) ?? (p === 'anthropic' ? await getSecret(db, 'ai_api_key') : null)
  if (stored) return { apiKey: stored, source: 'database', provider: p }
  const env = p === 'niro' ? process.env.NIRO_API_KEY : process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
  return env ? { apiKey: env, source: 'env', provider: p } : null
}

// ¿Está la IA encendida y con clave? Si lo está, responde ella en vez de las reglas de preguntas frecuentes.
export async function aiActive(db: Db) {
  const cfg = await getSetting(db, 'ai')
  return !!cfg.enabled && !!(await aiCredentials(db))
}

const clients = new Map<string, Anthropic>()
function clientFor(apiKey: string, baseURL?: string) {
  const k = apiKey + '|' + (baseURL ?? '')
  if (!clients.has(k)) clients.set(k, new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) }))
  return clients.get(k)!
}

export interface AiResult { text: string; model: string; usage: { input: number; output: number } }
export type Turn = { role: 'user' | 'assistant'; content: string }

// Niro: POST /api/v1/chat/completions con Authorization: Bearer niro_… (formato OpenAI).
// El modelo lo elige el Router de Niro con respaldo automático; por eso solo se envían los mensajes.
export async function niroChat(apiKey: string, baseUrl: string, system: string, turns: Turn[], timeoutMs = 30_000): Promise<AiResult | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ messages: [{ role: 'system', content: system }, ...turns] }),
      signal: ctl.signal,
    })
    const data: any = await res.json().catch(() => ({}))
    if (!res.ok) {
      const why = res.status === 402 ? 'sin saldo en la wallet de Niro' : res.status === 401 ? 'clave inválida o revocada' : data?.error?.message ?? res.status
      console.error('Niro respondió con error:', why)
      return null
    }
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim()
    if (!text) return null
    return { text, model: data.model ?? 'niro', usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 } }
  } finally { clearTimeout(timer) }
}

// Devuelve null si la IA está apagada, sin credenciales, falla o el modelo declina: el chat vuelve a las reglas.
export async function aiReply(db: Db, o: { channel: string; externalId: string; message: string; found: { n: number; name: string; price: number; available: number }[] }): Promise<AiResult | null> {
  const cfg = await getSetting(db, 'ai')
  const cred = cfg.enabled ? await aiCredentials(db) : null
  if (!cred) return null
  try {
    const { rows: hist } = await db.query(
      `SELECT m.role, m.body FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
       WHERE s.channel = $1 AND s.external_id = $2 ORDER BY m.id DESC LIMIT 8`, [o.channel, o.externalId])
    const messages: Turn[] = []
    for (const h of hist.reverse()) {
      const role = h.role === 'bot' ? 'assistant' : 'user'
      if (messages.length && messages[messages.length - 1].role === role) messages[messages.length - 1].content += '\n' + h.body
      else messages.push({ role, content: h.body })
    }
    // El último mensaje del cliente ya está guardado en el historial; se reemplaza por la versión con contexto.
    if (messages.length && messages[messages.length - 1].role === 'user') messages.pop()
    const gs = (n: number) => 'Gs. ' + n.toLocaleString('es-PY')
    const context = o.found.length
      ? `Productos encontrados:\n${o.found.map((f) => `${f.n}. ${f.name} — ${gs(f.price)} — ${f.available > 0 ? 'disponible' : 'sin stock'}`).join('\n')}`
      : 'Productos encontrados: ninguno para esta búsqueda.'
    messages.push({ role: 'user', content: `${o.message}\n\n[${context}]` })
    if (messages[0]?.role !== 'user') messages.shift()
    const system = await assembleSystemPrompt(db)

    if (cred.provider === 'niro') return await niroChat(cred.apiKey, cfg.baseUrl || NIRO_URL, system, messages)

    const client = clientFor(cred.apiKey, cfg.baseUrl || undefined)
    const res = await client.beta.messages.create({
      model: cfg.model || 'claude-opus-5-5',
      max_tokens: Number(cfg.maxTokens) || 700,
      system,
      messages,
      output_config: { effort: cfg.effort || 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    } as any)
    if (res.stop_reason === 'refusal') return null
    const text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim()
    if (!text) return null
    return { text, model: res.model, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } }
  } catch (e) {
    console.error('IA no disponible, se usan las reglas:', (e as Error).message)
    return null
  }
}

// ---------------------------------------------------------------- Rutas del área de prompts
const promptBody = z.object({
  slug: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/, 'Solo minúsculas, números y guiones'),
  title: z.string().min(2).max(80),
  kind: z.enum(['system', 'rules', 'knowledge']),
  content: z.string().max(8000),
  active: z.boolean().default(true),
  sort: z.number().int().default(100),
})

export function aiRoutes(app: FastifyInstance, db: Db, runTest: (message: string, userId: number) => Promise<{ reply: string; source: 'ai' | 'rules'; model?: string; usage?: AiResult['usage']; why?: string }>) {
  app.get('/ai/status', async (req) => {
    requirePerm(req, 'ai.manage')
    const settings = await getSetting(db, 'ai')
    const provider = await aiProvider(db)
    const keys: Record<string, { present: boolean; source: string | null; last4: string | null }> = {}
    for (const p of ['niro', 'anthropic'] as Provider[]) {
      const c = await aiCredentials(db, p)
      keys[p] = { present: !!c, source: c?.source ?? null, last4: c ? c.apiKey.slice(-4) : null }
    }
    return { provider, keys, keyPresent: keys[provider].present, source: keys[provider].source, last4: keys[provider].last4, settings: { ...settings, provider } }
  })
  // La clave nunca vuelve al navegador: solo se guarda (cifrada) o se borra.
  app.put('/ai/key', async (req) => {
    requirePerm(req, 'settings.write')
    const { apiKey, provider } = z.object({ apiKey: z.string().trim().min(20, 'La clave parece incompleta').max(400), provider: z.enum(['niro', 'anthropic']).default('niro') }).parse(req.body)
    await setSecret(db, `ai_api_key_${provider}`, apiKey)
    return { ok: true, last4: apiKey.slice(-4) }
  })
  app.delete('/ai/key', async (req) => {
    requirePerm(req, 'settings.write')
    const provider = z.enum(['niro', 'anthropic']).default('niro').parse((req.query as any)?.provider)
    await deleteSecret(db, `ai_api_key_${provider}`)
    if (provider === 'anthropic') await deleteSecret(db, 'ai_api_key')
    return { ok: true }
  })
  // Lista de modelos de Niro (sirve también para comprobar que la clave funciona).
  app.get('/ai/models', async (req) => {
    requirePerm(req, 'ai.manage')
    const cred = await aiCredentials(db, 'niro')
    if (!cred) throw new HttpError(409, 'Cargá primero la clave de Niro en Configuración')
    const cfg = await getSetting(db, 'ai')
    const res = await fetch(`${(cfg.baseUrl || NIRO_URL).replace(/\/$/, '')}/api/v1/models`, { headers: { authorization: `Bearer ${cred.apiKey}` } })
    const data: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new HttpError(res.status === 401 ? 400 : 502, data?.error?.message ?? 'Niro no respondió')
    return data
  })
  app.get('/prompts', async (req) => {
    requirePerm(req, 'ai.manage')
    return (await db.query('SELECT * FROM ai_prompts ORDER BY sort, id')).rows
  })
  app.post('/prompts', async (req, reply) => {
    requirePerm(req, 'ai.manage')
    const b = promptBody.parse(req.body)
    try {
      const { rows } = await db.query('INSERT INTO ai_prompts (slug, title, kind, content, active, sort, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [b.slug, b.title, b.kind, b.content, b.active, b.sort, req.user!.id])
      return reply.code(201).send(rows[0])
    } catch (e: any) { if (e.code === '23505') throw new HttpError(409, 'Ya existe un prompt con ese identificador'); throw e }
  })
  app.put('/prompts/:id', async (req) => {
    requirePerm(req, 'ai.manage')
    const b = promptBody.partial().parse(req.body)
    const keys = Object.keys(b) as (keyof typeof b)[]
    if (!keys.length) throw new HttpError(400, 'Nada para actualizar')
    const { rows } = await db.query(
      `UPDATE ai_prompts SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_by = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [Number((req.params as any).id), req.user!.id, ...keys.map((k) => b[k])])
    if (!rows[0]) throw new HttpError(404, 'Prompt no encontrado')
    return rows[0]
  })
  app.delete('/prompts/:id', async (req) => {
    requirePerm(req, 'ai.manage')
    await db.query('DELETE FROM ai_prompts WHERE id = $1', [Number((req.params as any).id)])
    return { ok: true }
  })
  app.get('/prompts/preview', async (req) => {
    requirePerm(req, 'ai.manage')
    const system = await assembleSystemPrompt(db)
    return { system, characters: system.length, approxTokens: Math.round(system.length / 3.6) }
  })
  app.post('/prompts/test', async (req) => {
    requirePerm(req, 'ai.manage')
    const { message } = z.object({ message: z.string().min(1).max(500) }).parse(req.body)
    return runTest(message, req.user!.id)
  })
}
