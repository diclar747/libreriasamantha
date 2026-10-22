import { chromium } from './pw/node_modules/playwright/index.mjs'
import { call, login, ok, summary } from './t-lib.mjs'
const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1187/chrome-linux/chrome', args: ['--no-sandbox'] })
const ROUTES = ['/admin', '/pos', '/sales', '/cash', '/orders', '/delivery', '/workorders', '/finanzas', '/gastos', '/reports', '/products', '/inventory', '/purchases', '/suppliers', '/customers', '/accounting', '/automation', '/prompts', '/settings']
const roles = [['caja', 'caja1234', 'cashier'], ['compras', 'compras1234', 'buyer'], ['deposito', 'deposito1234', 'warehouse'], ['web', null, 'support']]
for (const [u, pw, role] of roles) {
  if (!pw) continue
  const tk = await login(u, pw); const me = (await call('GET', '/me/profile', { token: tk })).json
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true }); await ctx.addInitScript(([t, x]) => { localStorage.setItem('samantha.token', t); localStorage.setItem('samantha.user', x) }, [tk, JSON.stringify({ id: me.id, username: u, name: me.name, role })])
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) errs.push(r.status() + ' ' + r.url().replace(/^.*\/api/, '')) })
  const seen = []; for (const r of ROUTES) { await p.goto('http://127.0.0.1:5199' + r, { waitUntil: 'networkidle' }); await p.waitForTimeout(250); const blank = await p.evaluate(() => (document.body.innerText || '').trim().length < 20); const path = new URL(p.url()).pathname; seen.push(`${r}${path !== r ? '→' + path : ''}${blank ? '(EN BLANCO)' : ''}`) }
  console.log(`== ${u} (${role}):`, seen.join('  '))
  ok(`${u}: sin errores 500 ni pantallas en blanco`, errs.length === 0 && !seen.some((s) => s.includes('EN BLANCO')), errs.join('|'))
  await ctx.close()
}
await b.close(); process.exit(summary() ? 1 : 0)
