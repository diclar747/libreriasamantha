import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ZodError, z } from 'zod'
import { ROLES, authenticate, can, hashPassword, newToken, requirePerm, verifyPassword } from './auth.js'
import { HttpError, type Db } from './db/client.js'
import { catalogRoutes, imageRoutes } from './routes/catalog.js'
import { purchasingRoutes } from './routes/purchasing.js'
import { salesRoutes } from './routes/sales.js'
import { financeRoutes } from './routes/finance.js'
import { workOrderRoutes } from './routes/workorders.js'
import { accountingRoutes } from './accounting.js'
import { serviceRoutes } from './services.js'
import { orderAdminRoutes, printRequestRoutes, shopRoutes, webhookRoutes } from './orders.js'
import { agentRoutes, runAgent } from './agent.js'
import { getSetting } from './services.js'
import { chatRoutes, testChat, winsapWebhookRoutes } from './chatbot.js'
import { aiCredentials, aiRoutes } from './ai.js'
import { profileRoutes } from './notifications.js'
import { treasuryRoutes } from './routes/treasury.js'
import { cashRoutes } from './routes/cash.js'
import { reportRoutes } from './reports/routes.js'
import { PUBLIC_URL } from './payments.js'
import { onlineAdminRoutes, onlineShopRoutes } from './online.js'
import { deliveryAdminRoutes } from './routes/delivery.js'
import { scanPublicRoutes, scanRoutes } from './scanning.js'
import { orderAdminRoutes2, orderRefundRoutes } from './orderadmin.js'
import { portalAdminRoutes, portalRoutes } from './portal.js'

export function buildApp(db: Db, opts: { https?: { key: Buffer; cert: Buffer } } = {}) {
  const logger = process.env.NODE_ENV !== 'test'
  const app = (opts.https ? Fastify({ logger, https: opts.https }) : Fastify({ logger })) as unknown as FastifyInstance
  app.register(cors, { origin: true })

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message })
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Datos inválidos', issues: err.issues })
    if (err.code === '23514' || err.code === '23503') return reply.code(400).send({ error: 'Datos inválidos: ' + err.detail })
    app.log.error(err)
    if (process.env.DEBUG_ERRORS) console.error(err)
    return reply.code(err.statusCode ?? 500).send({ error: err.statusCode ? err.message : 'Error interno' })
  })

  app.register(async (api) => {
    api.post('/login', async (req) => {
      const b = z.object({ username: z.string(), password: z.string() }).parse(req.body)
      const { rows } = await db.query('SELECT * FROM users WHERE username = $1 AND active', [b.username])
      if (!rows[0] || !verifyPassword(b.password, rows[0].password_hash)) throw new HttpError(401, 'Usuario o contraseña incorrectos')
      const token = newToken()
      await db.query('INSERT INTO sessions (token, user_id) VALUES ($1,$2)', [token, rows[0].id])
      const { id, username, name, role } = rows[0]
      return { token, user: { id, username, name, role } }
    })

    // Rutas públicas (tienda, chat, webhooks): sin sesión de usuario.
    api.register(async (pub) => { shopRoutes(pub, db); onlineShopRoutes(pub, db); scanPublicRoutes(pub, db); portalRoutes(pub, db); imageRoutes(pub, db); chatRoutes(pub, db); agentRoutes(pub, db); printRequestRoutes(pub, db) }, { prefix: '/shop' })
    api.register(async (hooks) => { webhookRoutes(hooks, db); winsapWebhookRoutes(hooks, db) }, { prefix: '/webhooks' })

    api.register(async (priv) => {
      priv.addHook('onRequest', (req) => authenticate(db, req))
      priv.get('/me', async (req) => req.user)
      priv.post('/logout', async (req) => {
        await db.query('DELETE FROM sessions WHERE token = $1', [req.headers.authorization?.replace(/^Bearer /, '')])
        return { ok: true }
      })
      priv.get('/users', async (req) => {
        requirePerm(req, 'users.manage')
        return (await db.query('SELECT id, username, name, role, active FROM users ORDER BY name')).rows
      })
      priv.post('/users', async (req, reply) => {
        requirePerm(req, 'users.manage')
        const b = z.object({ username: z.string().min(3), name: z.string().min(1), role: z.enum(ROLES), password: z.string().min(8) }).parse(req.body)
        try {
          const { rows } = await db.query(
            'INSERT INTO users (username, name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, username, name, role',
            [b.username, b.name, b.role, hashPassword(b.password)])
          return reply.code(201).send(rows[0])
        } catch (e: any) {
          if (e.code === '23505') throw new HttpError(409, 'El usuario ya existe')
          throw e
        }
      })
      priv.get('/permissions', async (req) => ({ role: req.user!.role, costs: can(req.user!.role, 'costs.view') }))
      catalogRoutes(priv, db)
      purchasingRoutes(priv, db)
      salesRoutes(priv, db)
      financeRoutes(priv, db)
      workOrderRoutes(priv, db)
      accountingRoutes(priv, db)
      serviceRoutes(priv, db)
      orderAdminRoutes(priv, db)
      onlineAdminRoutes(priv, db)
      deliveryAdminRoutes(priv, db)
      orderAdminRoutes2(priv, db)
      orderRefundRoutes(priv, db)
      portalAdminRoutes(priv, db)
      scanRoutes(priv, db)
      // La prueba del área de prompts usa el mismo agente que la tienda (sin carrito ni sesión de cliente).
      aiRoutes(priv, db, async (m, u) => {
        if ((await getSetting(db, 'ai')).enabled && (await aiCredentials(db, 'niro'))) {
          const out = await runAgent(db, { sid: `admin-test-${u}-prueba`, message: m, cart: [], account: null })
          if (out.source === 'agent') return { reply: out.reply + (out.blocks.length ? `\n\n[Además muestra: ${[...new Set(out.blocks.map((b) => ({ products: 'tarjetas de productos', cart: 'el carrito', checkout: 'el resumen del pedido', order: 'el estado del pedido', orders: 'la lista de pedidos', links: 'botones' } as Record<string, string>)[b.type]))].join(', ')}]` : ''), source: 'ai' as const }
        }
        return testChat(db, m, u)
      })
      profileRoutes(priv, db)
      treasuryRoutes(priv, db)
      cashRoutes(priv, db)
      reportRoutes(priv, db)
    })
  }, { prefix: '/api' })

  // SEO: mapa del sitio y robots para que los buscadores encuentren las páginas de producto.
  app.get('/sitemap.xml', async (_req, reply) => {
    const { rows } = await db.query('SELECT id, name FROM products WHERE active AND online_visible ORDER BY id')
    const base = PUBLIC_URL()
    const urls = [`${base}/tienda`, ...rows.map((p) => `${base}/tienda/producto/${p.id}`)]
    reply.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`)
  })
  app.get('/robots.txt', async (_req, reply) => {
    reply.type('text/plain').send(`User-agent: *
Allow: /tienda
Disallow: /api
Disallow: /pos
Disallow: /admin
Sitemap: ${PUBLIC_URL()}/sitemap.xml
`)
  })

  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
  if (existsSync(webDist)) {
    // Caché: lo versionado (assets con hash) para siempre; el service worker, el manifiesto y las páginas se revalidan siempre,
    // así una app instalada o un teléfono nunca se queda con el ícono o los archivos viejos.
    app.register(fastifyStatic, {
      root: webDist,
      setHeaders: (res, filePath) => {
        const p = filePath.replace(/\\/g, '/')
        if (p.includes('/assets/')) res.header('Cache-Control', 'public, max-age=31536000, immutable')
        else if (/\/(sw\.js|offline\.html|index\.html)$|\.webmanifest$/.test(p)) res.header('Cache-Control', 'no-cache')
        else if (/\/(icons|brand|splash|screenshots|images)\//.test(p)) res.header('Cache-Control', 'public, max-age=86400')
      },
    })
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api') ? reply.code(404).send({ error: 'No encontrado' }) : reply.sendFile('index.html'))
  }
  return app
}
