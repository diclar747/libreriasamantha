import { chromium } from './pw/node_modules/playwright/index.mjs'
import { call, login, ok as _ok, summary } from './t-lib.mjs'
const FOTO = process.argv[2]
const adm = await login('admin', 'admin1234')
const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1187/chrome-linux/chrome', args: ['--no-sandbox'] })
const ok = (n, c, x = '') => _ok(n, !!c, x)
const tipear = async (loc, txt) => { await loc.click(); await loc.fill(''); await loc.pressSequentially(txt, { delay: 40 }) }
async function comprar(label, { method, cityName, pay, rec }) {
  console.log('== Tienda (celular): compra ' + label)
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); const p = await ctx.newPage()
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) errs.push('HTTP ' + r.status() + ' ' + r.url()) })
  await p.goto('http://127.0.0.1:5199/tienda', { waitUntil: 'networkidle' }); await p.waitForTimeout(600)
  await p.locator('.sf-add').first().click().catch(async () => { await p.locator('a[href*="/tienda/producto"]').first().click(); await p.waitForTimeout(800); await p.getByRole('button', { name: /Agregar al carrito/ }).first().click() }); await p.waitForTimeout(500)
  await p.goto('http://127.0.0.1:5199/tienda/checkout', { waitUntil: 'networkidle' }); await p.waitForTimeout(500)
  await p.getByLabel('Nombre y apellido').fill('Cliente ' + label); await p.getByLabel(/Teléfono/).fill('0981 555 ' + Math.floor(100 + Math.random() * 899))
  await p.getByLabel(/Correo/).fill('cliente@correo.com'); await p.getByLabel(/RUC o CI/).fill('1234567-8')
  await p.locator('label:has-text("Entrega") select').first().selectOption(method)
  if (method === 'delivery') {
    const sels = p.locator('select'); await p.locator('select').filter({ hasText: 'Itapúa' }).first().selectOption({ label: 'Itapúa' }); await p.waitForTimeout(300)
    await p.locator('select').filter({ hasText: 'Elegir ciudad' }).first().selectOption({ index: 1 }); await p.waitForTimeout(800)
    await p.getByLabel(/^Barrio$/).fill('San Roque'); await p.getByLabel(/Calle y número/).fill('Mcal. López 1234'); await p.getByLabel(/Referencia/).fill('Portón verde')
    ok('muestra el costo del delivery', /Gs\. 30\.000/.test(await p.locator('body').innerText()))
  }
  if (pay === 'transfer') await p.getByText(/Transferencia bancaria/).click(); if (pay === 'cod') await p.getByText(/Pago contra entrega/).click()
  ok('hay forma de pago elegible', true)
  const btn = p.getByRole('button', { name: /Confirmar pedido|Pagar ahora/ }); ok('botón habilitado', await btn.isEnabled())
  await btn.click(); await p.waitForTimeout(2500)
  const url = p.url(); const body = await p.locator('body').innerText()
  ok('pedido creado (pantalla de seguimiento/gracias)', /P-\d{6}/.test(body) || /pedido/i.test(body), url + ' ' + body.slice(0, 150))
  const num = (body.match(/P-\d{6}/) ?? [])[0]
  ok('sin errores de servidor ni JS', errs.length === 0, errs.join(' | '))
  if (pay === 'transfer' && num) {
    // subir comprobante con foto grande
    const fi = p.locator('input[type=file]').first()
    if (await fi.count()) { await fi.setInputFiles(FOTO); await p.getByLabel(/Referencia|Nº|Número/i).first().fill('TRF-998877').catch(() => {}); await p.getByRole('button', { name: /Enviar comprobante|Subir/ }).first().click().catch(() => {}); await p.waitForTimeout(2500) }
    const o = (await call('GET', '/orders?q=' + num, { token: adm })).json?.[0]; const proofs = (await call('GET', '/payment-proofs?status=pending', { token: adm })).json
    ok('comprobante recibido (foto de 10 MB)', proofs?.some((x) => x.order_number === num), JSON.stringify(proofs).slice(0, 150))
  }
  await ctx.close(); return num
}
const n1 = await comprar('retiro', { method: 'pickup', pay: 'transfer' }); 
const n2 = await comprar('delivery contra entrega', { method: 'delivery', pay: 'cod' })
const n3 = await comprar('delivery transferencia', { method: 'delivery', pay: 'transfer' })
console.log('pedidos:', n1, n2, n3)
await b.close(); process.exit(summary() ? 1 : 0)
