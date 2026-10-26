import pkg from '/tmp/pwcore/node_modules/playwright-core/index.js'; const { chromium } = pkg
import { login } from './t-lib.mjs'
const tk = await login('admin', 'admin1234')
const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1187/chrome-linux/chrome', args: ['--no-sandbox'] })
const ROUTES = ['/admin', '/pos', '/sales', '/cash', '/orders', '/delivery', '/workorders', '/finanzas', '/gastos', '/reports', '/products', '/inventory', '/purchases', '/suppliers', '/customers', '/accounting', '/automation', '/prompts', '/settings', '/profile']
const STORE = ['/tienda', '/tienda/carrito', '/tienda/checkout', '/tienda/ingresar', '/tienda/registro', '/tienda/recuperar', '/tienda/pedido', '/tienda/listas', '/tienda/impresiones', '/tienda/cuenta', '/tienda/cuenta/pedidos', '/tienda/cuenta/perfil', '/tienda/cuenta/direcciones', '/tienda/cuenta/favoritos']
const issues = []
for (const [size, [w, h]] of Object.entries({ phone: [390, 844], desk: [1440, 900] })) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: size === 'phone', hasTouch: size === 'phone' })
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('samantha.token', t); localStorage.setItem('samantha.user', u) }, [tk, JSON.stringify({ id: 3, username: 'admin', name: 'Administrador', role: 'owner' })])
  const p = await ctx.newPage(); let cur = ''
  p.on('pageerror', (e) => issues.push([size, cur, 'JS', e.message.slice(0, 160)]))
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && issues.push([size, cur, 'console', m.text().slice(0, 160)]))
  p.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) issues.push([size, cur, 'HTTP ' + r.status(), r.url().replace(/^.*\/api/, '/api').slice(0, 90)]) })
  for (const route of [...ROUTES, ...(size === 'phone' ? STORE : [])]) {
    cur = route
    await p.goto('http://127.0.0.1:5199' + route, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => issues.push([size, route, 'GOTO', e.message.slice(0, 80)]))
    await p.waitForTimeout(400)
    const ov = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (ov > 1) issues.push([size, route, 'DESBORDE', ov + 'px'])
    const empty = await p.evaluate(() => (document.body.innerText || '').trim().length < 20); if (empty) issues.push([size, route, 'PANTALLA EN BLANCO', ''])
    // pestañas
    const tabs = await p.getByRole('tab').all()
    for (let i = 0; i < tabs.length; i++) { cur = `${route} [pestaña ${i + 1}]`; await tabs[i].click().catch(() => {}); await p.waitForTimeout(500)
      const o2 = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (o2 > 1) issues.push([size, cur, 'DESBORDE', o2 + 'px']) }
  }
  await ctx.close()
}
await b.close()
const seen = new Set(); for (const i of issues) { const k = i.join('|'); if (!seen.has(k)) { seen.add(k); console.log(i.join('  |  ')) } }
console.log('TOTAL hallazgos únicos:', seen.size)
