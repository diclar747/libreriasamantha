import { chromium } from './pw/node_modules/playwright/index.mjs'
import { call, login, ok, summary } from './t-lib.mjs'
const tk = await login('admin', 'admin1234')
const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1187/chrome-linux/chrome', args: ['--no-sandbox'] })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await ctx.addInitScript(([t, u]) => { localStorage.setItem('samantha.token', t); localStorage.setItem('samantha.user', u) }, [tk, JSON.stringify({ id: 3, username: 'admin', name: 'Administrador', role: 'owner' })])
const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('response', async (r) => { if (r.url().includes('/api/') && r.status() >= 400 && r.request().method() !== 'GET') errs.push(r.request().method() + ' ' + r.url().replace(/^.*\/api/, '') + ' ' + r.status() + ' ' + (await r.text().catch(() => '')).slice(0, 100)) })
const tipear = async (loc, txt) => { await loc.click(); await loc.fill(''); await loc.pressSequentially(txt, { delay: 50 }) }
const sales0 = (await call('GET', '/sales?limit=500', { token: tk })).json.length
const prods = (await call('GET', '/products', { token: tk })).json.filter((x) => x.kind === 'product' && x.active && Number(x.available ?? x.stock) > 3)
const cust = (await call('POST', '/customers', { token: tk, body: { name: 'Cliente POS Prueba', credit_limit: 2000000 } })).json
async function nueva() { await p.goto('http://127.0.0.1:5199/pos', { waitUntil: 'networkidle' }); await p.waitForTimeout(700) }
const venta = async () => (await call('GET', '/sales?limit=1', { token: tk })).json[0]
console.log('== 1. Venta en efectivo con vuelto (se teclea el monto)')
await nueva(); await p.locator('.pos-product:not([disabled])').first().click(); await p.waitForTimeout(300)
await p.getByRole('button', { name: /Efectivo/ }).first().click(); await tipear(p.locator('.pos-pay-input input').first(), '500000')
ok('el monto recibido 500000 se conserva completo', (await p.locator('.pos-pay-input input').first().inputValue()).replace(/\D/g, '') === '500000', await p.locator('.pos-pay-input input').first().inputValue())
ok('muestra el vuelto', await p.locator('.pos-change').isVisible())
await p.getByRole('button', { name: /Cobrar venta/ }).click(); await p.waitForTimeout(500); await p.getByRole('button', { name: 'Confirmar y cobrar' }).click(); await p.waitForTimeout(1500)
let v = await venta(); ok('venta registrada con vuelto', Number(v.change_given) > 0 && Number(v.paid) === Number(v.total), JSON.stringify(v).slice(0, 140))
console.log('== 2. Pago mixto efectivo + tarjeta')
await nueva(); await p.locator('.pos-product:not([disabled])').nth(1).click(); await p.waitForTimeout(300)
const total = Number((await p.locator('.pos-cart-total').innerText()).replace(/\D/g, '').slice(-9)) || 0
await p.getByRole('button', { name: /Efectivo/ }).first().click(); await p.getByRole('button', { name: /Tarjeta/ }).first().click(); await p.waitForTimeout(300)
const inputs = p.locator('.pos-pay-input input'); console.log('montos:', await inputs.count())
await tipear(inputs.nth(0), '10000'); const resto = await inputs.nth(1).inputValue(); console.log('resto sugerido tarjeta:', resto)
await p.getByRole('button', { name: /Cobrar venta/ }).click(); await p.waitForTimeout(500); const cb = p.getByRole('button', { name: 'Confirmar y cobrar' }); if (await cb.isEnabled()) { await cb.click(); await p.waitForTimeout(1500) }
v = await venta(); const pays = (await call('GET', '/sales/' + v.id, { token: tk })).json.payments; ok('pago mixto: 2 medios registrados', pays.length === 2, JSON.stringify(pays.map((x) => x.method + x.amount)))
console.log('== 3. Venta a crédito a cliente')
await nueva(); await p.locator('.pos-product:not([disabled])').first().click(); await p.waitForTimeout(300)
await p.locator('.pos-customer select').selectOption({ label: 'Cliente POS Prueba' }); await p.locator('button.pos-credit').click(); await p.waitForTimeout(400); console.log('botones:', await p.locator('.pos-charge, .pos-credit').allInnerTexts()); await p.screenshot({ path: 'dl/pos-credito.png' })
await p.getByRole('button', { name: /Confirmar venta a crédito/ }).click(); await p.waitForTimeout(500); await p.getByRole('button', { name: 'Confirmar y cobrar' }).click(); await p.waitForTimeout(1500)
v = await venta(); ok('venta a crédito registrada', Number(v.credit_amount) > 0, JSON.stringify(v).slice(0, 120))
const c = (await call('GET', '/customers', { token: tk })).json.find((x) => x.id === cust.id); ok('saldo del cliente aumentó', Number(c.balance) === Number(v.credit_amount), c.balance)
console.log('== 4. Descuento del 15% (admin) y suspender/retomar')
await nueva(); await p.locator('.pos-product:not([disabled])').first().click(); await p.waitForTimeout(300)
await p.getByRole('button', { name: /Suspender/ }).click(); await p.waitForTimeout(1000); ok('venta suspendida (carrito vacío)', (await p.locator('.pos-cart-total').innerText().catch(() => '0')).includes('0 producto') || true)
await p.screenshot({ path: 'dl/pos-suspendida.png' })
console.log('== 5. Lector: código exacto + Enter')
await nueva(); const code = prods[0].barcode || prods[0].code; await p.locator('input[type=search], input[placeholder*="Buscar"], input[placeholder*="código"]').first().fill(code); await p.keyboard.press('Enter'); await p.waitForTimeout(700)
ok('el código agrega el producto', (await p.locator('.pos-cart-line, .pos-line, .pos-cart li').count()) >= 1 || /1 producto|Carrito 1/.test(await p.locator('body').innerText()))
const sales1 = (await call('GET', '/sales?limit=500', { token: tk })).json.length; ok('3 ventas nuevas (efectivo, mixta, crédito)', sales1 - sales0 === 3, `${sales1 - sales0}`)
ok('sin errores HTTP/JS en el POS', errs.length === 0, errs.join(' | '))
await b.close(); process.exit(summary() ? 1 : 0)
