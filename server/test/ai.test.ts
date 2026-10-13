import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import pg from 'pg'
import { ensureDefaultPrompts } from '../src/ai.js'
import { buildApp } from '../src/app.js'
import { hashPassword } from '../src/auth.js'
import { createPool, migrate, type Db } from '../src/db/client.js'

const BASE = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'
const TEST_DB = 'libreria_samantha_test3'
let db: Db
let app: ReturnType<typeof buildApp>
const tokens: Record<string, string> = {}

async function call(who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url: '/api' + url, payload: payload as any, headers: tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {} })
  return { status: res.statusCode, body: res.json() }
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: BASE })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${TEST_DB}`)
  await admin.end()
  db = createPool(BASE.replace(/\/[^/]*$/, '/' + TEST_DB))
  await migrate(db)
  await ensureDefaultPrompts(db)
  for (const [u, role] of [['boss', 'owner'], ['cash', 'cashier']]) {
    await db.query('INSERT INTO users (username, name, role, password_hash) VALUES ($1,$1,$2,$3)', [u, role, hashPassword('secret123')])
  }
  app = buildApp(db)
  for (const u of ['boss', 'cash']) tokens[u] = (await call('', 'POST', '/login', { username: u, password: 'secret123' })).body.token
})
afterAll(async () => { await db.end() })

describe('Área de prompts y asistente', () => {
  it('solo el administrador gestiona los prompts', async () => {
    expect((await call('cash', 'GET', '/prompts')).status).toBe(403)
    const list = await call('boss', 'GET', '/prompts')
    expect(list.status).toBe(200)
    expect(list.body.map((p: any) => p.slug)).toEqual(expect.arrayContaining(['identidad', 'reglas', 'envios']))
  })

  it('el prompt final mezcla lo editable con los datos vivos del negocio', async () => {
    await call('boss', 'POST', '/delivery-zones', { name: 'Centro', fee: 15000 })
    await db.query(`UPDATE settings SET value = jsonb_set(value, '{address}', '"Av. España 123"') WHERE key = 'shop'`)
    const list = (await call('boss', 'GET', '/prompts')).body
    const envios = list.find((p: any) => p.slug === 'envios')
    await call('boss', 'PUT', `/prompts/${envios.id}`, { content: 'Delivery de lunes a viernes, entrega en 24 horas.' })
    const { system } = (await call('boss', 'GET', '/prompts/preview')).body
    expect(system).toContain('entrega en 24 horas')
    expect(system).toContain('Centro (Gs. 15.000)')
    expect(system).toContain('Av. España 123')
    expect(system).toContain('Nunca confirmes que un pago fue recibido')
  })

  it('un prompt desactivado no llega al asistente y los identificadores no se repiten', async () => {
    const list = (await call('boss', 'GET', '/prompts')).body
    const pagos = list.find((p: any) => p.slug === 'pagos')
    await call('boss', 'PUT', `/prompts/${pagos.id}`, { active: false })
    expect((await call('boss', 'GET', '/prompts/preview')).body.system).not.toContain('Formas de pago')
    expect((await call('boss', 'POST', '/prompts', { slug: 'pagos', title: 'Otro', kind: 'knowledge', content: 'x' })).status).toBe(409)
    expect((await call('boss', 'POST', '/prompts', { slug: 'Mal Slug', title: 'Otro', kind: 'knowledge', content: 'x' })).status).toBe(400)
  })

  it('con la IA apagada el chat sigue funcionando con reglas y la prueba explica por qué', async () => {
    const r = await call('boss', 'POST', '/prompts/test', { message: 'hola' })
    expect(r.status).toBe(200)
    expect(r.body.source).toBe('rules')
    expect(r.body.why).toMatch(/apagada/)
    expect(r.body.reply).toMatch(/asistente/)
  })
})

describe('Perfil, notificaciones y clave de la IA', () => {
  it('el usuario edita su perfil con avatar y cambia la contraseña cerrando otras sesiones', async () => {
    const avatar = 'data:image/png;base64,iVBORw0KGgo='
    const up = await call('boss', 'PUT', '/me/profile', { name: 'Claudio Admin', phone: '+595981123456', email: 'a@b.com', address: 'Asunción', avatar })
    expect(up.body).toMatchObject({ name: 'Claudio Admin', phone: '+595981123456', avatar })
    expect((await call('boss', 'PUT', '/me/profile', { name: 'X', avatar: 'data:text/html;base64,AAAA' })).status).toBe(400)
    const other = (await call('', 'POST', '/login', { username: 'boss', password: 'secret123' })).body.token
    expect((await call('boss', 'POST', '/me/password', { current: 'mala', next: 'nueva-clave-123' })).status).toBe(400)
    expect((await call('boss', 'POST', '/me/password', { current: 'secret123', next: 'nueva-clave-123' })).status).toBe(200)
    const stale = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${other}` } })
    expect(stale.statusCode).toBe(401)
    expect((await call('boss', 'GET', '/me')).status).toBe(200)
  })

  it('una consulta del chat avisa una sola vez y cada rol ve solo lo suyo', async () => {
    const chat = (m: string) => app.inject({ method: 'POST', url: '/api/shop/chat', payload: { sessionId: 'visitante-12345', message: m } })
    await chat('hola, ¿tienen cuadernos?')
    await chat('¿y lápices?')
    const boss = (await call('boss', 'GET', '/notifications')).body
    const chats = boss.items.filter((n: any) => n.type === 'chat_inquiry')
    expect(chats).toHaveLength(1)
    expect(chats[0].body).toContain('cuadernos')
    expect(boss.unread).toBe(1)
    expect((await call('cash', 'GET', '/notifications')).body.items.length).toBe(1) // la caja atiende pedidos y consultas
    await call('boss', 'POST', '/notifications/read', {})
    expect((await call('boss', 'GET', '/notifications')).body.unread).toBe(0)
  })

  it('las preferencias apagan avisos por tipo y las suscripciones push se guardan', async () => {
    await call('cash', 'PUT', '/me/notification-prefs', { chat_inquiry: { inapp: false, push: false } })
    expect((await call('cash', 'GET', '/notifications')).body.items).toHaveLength(0)
    expect((await call('cash', 'PUT', '/me/notification-prefs', { inventado: { inapp: true, push: true } })).status).toBe(400)
    const key = await call('boss', 'GET', '/push/public-key')
    expect(key.body.publicKey).toHaveLength(87)
    expect((await call('boss', 'POST', '/push/subscribe', { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'a' } })).status).toBe(200)
    expect((await call('boss', 'GET', '/me/profile')).body.pushDevices).toBe(1)
    expect((await call('cash', 'POST', '/push/test', {})).status).toBe(409) // sin dispositivos
  })

  it('la clave de la IA se guarda cifrada, no se devuelve y solo la gestiona el administrador', async () => {
    expect((await call('cash', 'PUT', '/ai/key', { apiKey: 'sk-ant-test-1234567890abcd' })).status).toBe(403)
    expect((await call('boss', 'PUT', '/ai/key', { apiKey: 'corta' })).status).toBe(400)
    expect((await call('boss', 'PUT', '/ai/key', { apiKey: 'sk-ant-test-1234567890abcd' })).status).toBe(200)
    const st = (await call('boss', 'GET', '/ai/status')).body
    expect(st).toMatchObject({ keyPresent: true, source: 'database', last4: 'abcd' })
    expect(JSON.stringify(st)).not.toContain('1234567890')
    const raw = (await db.query(`SELECT value FROM secrets WHERE key = 'ai_api_key_niro'`)).rows[0].value
    expect(raw).not.toContain('sk-ant')
    await call('boss', 'DELETE', '/ai/key')
    expect((await call('boss', 'GET', '/ai/status')).body.source).not.toBe('database')
  })

  it('sin IA, el chat responde envíos y pagos con lo cargado en los prompts', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/shop/chat', payload: { sessionId: 'visitante-98765', message: '¿cómo es el delivery?' } })
    expect(r.json().reply).toContain('Zonas y tarifas: Centro (Gs. 15.000)')
    expect(r.json().reply).not.toMatch(/Completar/)
  })
})

describe('Integración con Niro (servidor simulado con el mismo formato que la documentación)', () => {
  let server: http.Server
  let base = ''
  let mode: 'ok' | 'sin-saldo' = 'ok'
  const seen: { auth?: string; body?: any }[] = []

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        if (req.url === '/api/v1/chat/completions' && req.method === 'POST') {
          seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) })
          if (mode === 'sin-saldo') { res.statusCode = 402; return res.end(JSON.stringify({ error: { message: 'Saldo insuficiente' } })) }
          return res.end(JSON.stringify({ id: 'chatcmpl-1', model: 'niro-auto', choices: [{ index: 0, message: { role: 'assistant', content: 'El delivery al centro sale Gs. 15.000 y llega en el día.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138 } }))
        }
        if (req.url === '/api/v1/models') return res.end(JSON.stringify({ models: [{ name: 'Niro AI', category: 'CHAT' }] }))
        res.statusCode = 404; res.end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, () => r()))
    base = `http://127.0.0.1:${(server.address() as any).port}`
    await call('boss', 'PUT', '/ai/key', { provider: 'niro', apiKey: 'niro_clave-de-prueba-123456' })
    await call('boss', 'PUT', '/settings/ai', { enabled: true, provider: 'niro', baseUrl: base })
  })
  afterAll(async () => { await new Promise((r) => server.close(r)) })

  it('el chat usa Niro con Bearer, system prompt y el contexto de productos', async () => {
    const r = await call('boss', 'POST', '/prompts/test', { message: '¿cuánto sale el envío al centro?' })
    expect(r.body).toMatchObject({ source: 'ai', model: 'niro-auto' })
    expect(r.body.reply).toContain('Gs. 15.000')
    const sent = seen[seen.length - 1]
    expect(sent.auth).toBe('Bearer niro_clave-de-prueba-123456')
    expect(sent.body.messages[0].role).toBe('system')
    expect(sent.body.messages[0].content).toContain('Nunca confirmes que un pago fue recibido')
    expect(sent.body.messages[0].content).toContain('Centro (Gs. 15.000)')
    expect(sent.body.messages.at(-1).role).toBe('user')
    expect(sent.body.messages.at(-1).content).toContain('Productos encontrados')
  })

  it('el chat público también responde con la IA', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/shop/chat', payload: { sessionId: 'visitante-niro-01', message: 'necesito saber el costo del envío' } })
    expect(r.json().reply).toContain('Gs. 15.000')
  })

  it('si Niro no tiene saldo, el chat sigue respondiendo con reglas', async () => {
    mode = 'sin-saldo'
    const r = await call('boss', 'POST', '/prompts/test', { message: '¿cómo es el delivery?' })
    expect(r.body.source).toBe('rules')
    expect(r.body.reply).toContain('Zonas y tarifas')
    mode = 'ok'
  })

  it('la conexión se puede comprobar desde Configuración', async () => {
    const r = await call('boss', 'GET', '/ai/models')
    expect(r.body.models[0].name).toBe('Niro AI')
    expect((await call('boss', 'GET', '/ai/status')).body).toMatchObject({ provider: 'niro', keyPresent: true, last4: '3456' })
  })
})
