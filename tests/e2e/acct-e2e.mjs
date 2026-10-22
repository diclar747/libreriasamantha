import { chromium } from './pw/node_modules/playwright/index.mjs'
import { call, ok, summary } from './t-lib.mjs'
const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1187/chrome-linux/chrome', args: ['--no-sandbox'] })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); const p = await ctx.newPage()
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('response', async (r) => { if (r.url().includes('/api/') && r.status() >= 400 && r.request().method() !== 'GET') errs.push(r.request().method() + ' ' + r.url().replace(/^.*\/api/, '') + ' ' + r.status() + ' ' + (await r.text().catch(() => '')).slice(0, 90)) })
const email = `cliente${Date.now() % 100000}@correo.com`
console.log('== Registro de cliente en la tienda')
await p.goto('http://127.0.0.1:5199/tienda/registro', { waitUntil: 'networkidle' }); await p.waitForTimeout(500)
console.log('campos:', (await p.locator('label').allInnerTexts()).map((t) => t.split('\n')[0]).join(' | '))
await p.getByLabel('Nombre', { exact: true }).fill('Lucía'); await p.getByLabel('Apellido').fill('Giménez'); await p.getByLabel('Correo electrónico').fill(email)
await p.getByLabel(/Teléfono/).fill('0981 777 888'); await p.getByLabel(/Cédula o RUC/).fill('4.567.890'); await p.getByLabel('Contraseña', { exact: true }).fill('Clave-Segura-2026'); await p.getByLabel('Repetir contraseña').fill('Clave-Segura-2026')
for (const c of await p.locator('input[type=checkbox]').all()) await c.check().catch(() => {})
await p.getByRole('button', { name: /Crear|Registr/ }).first().click(); await p.waitForTimeout(2000)
console.log('url:', p.url(), '|', (await p.locator('body').innerText()).replace(/\n+/g, ' ').slice(0, 200))
ok('cuenta creada', /cuenta|verific|pedidos|Hola/i.test(await p.locator('body').innerText()) && !/error|inválid/i.test(await p.locator('.err, .errbox, .toast.err').allInnerTexts().then((x) => x.join(' '))))
const r = await call('POST', '/shop/account/login', { body: { email, password: 'Clave-Segura-2026' } }); ok('inicio de sesión de la cuenta (API)', r.status === 200, r.text.slice(0, 100))
console.log('== Seguimiento de pedido por número + teléfono'); const od = await call('POST', '/shop/orders/lookup', { body: { number: 'P-000009', phone: '0981 555 000' } }); console.log('lookup', od.status, od.text.slice(0, 100))
ok('sin errores HTTP/JS', errs.length === 0, errs.join(' | '))
await b.close(); process.exit(summary() ? 1 : 0)
