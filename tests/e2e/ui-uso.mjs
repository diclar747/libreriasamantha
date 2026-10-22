import { chromium } from './pw/node_modules/playwright/index.mjs'
import { login, call, ok as _ok, summary } from './t-lib.mjs'
const out = process.argv[2]; const FOTO = process.argv[3]
const tk = await login('admin', 'admin1234')
const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1187/chrome-linux/chrome', args: ['--no-sandbox'] }); const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
await ctx.addInitScript(([t, u]) => { localStorage.setItem('samantha.token', t); localStorage.setItem('samantha.user', u) }, [tk, JSON.stringify({ id: 3, username: 'admin', name: 'Administrador', role: 'owner' })])
const p = await ctx.newPage(); p.on('pageerror', (e) => console.log('ERR', e.message)); p.on('requestfailed', (r) => console.log('REQFAIL', r.url().slice(-60)))
const ok = _ok
// el usuario teclea dígito a dígito, como en la vida real
const tipear = async (loc, txt) => { await loc.click(); await loc.fill(''); await loc.pressSequentially(txt, { delay: 60 }) }
console.log('== Producto nuevo con foto de celular (10 MB)')
await p.goto('http://127.0.0.1:5199/products', { waitUntil: 'networkidle' }); await p.waitForTimeout(500)
await p.getByRole('button', { name: /Nuevo producto/ }).first().click(); await p.waitForTimeout(500)
await p.locator('input').filter({ hasNot: p.locator('[hidden]') }).first()
const name = p.getByLabel(/^Nombre/).first(); await name.fill('Biblia de estudio prueba')
const precio = p.getByLabel(/Precio de venta/i).first(); await tipear(precio, '1250000')
ok('precio tipeado 1250000 se muestra completo (1.250.000)', (await precio.inputValue()) === '1.250.000', await precio.inputValue())
const costo = p.getByLabel(/^Costo/i).first(); if (await costo.count()) { await tipear(costo, '987654'); ok('costo 987654 → 987.654', (await costo.inputValue()) === '987.654', await costo.inputValue()) }
await p.getByRole('tab', { name: /Imágenes/ }).click(); await p.waitForTimeout(300)
const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.getByText(/Sacá una foto/).click()]); await chooser.setFiles(FOTO); await p.waitForTimeout(1500)
ok('la foto elegida aparece en la galería antes de guardar', (await p.locator('.gallery img').count()) === 1)
await p.screenshot({ path: out + '/uso-producto-foto.png' })
await p.getByRole('button', { name: /^Guardar/ }).first().click(); await p.waitForTimeout(4000)
const list = (await call('GET', '/products?q=Biblia de estudio prueba', { token: tk })).json
const prod = list.find((x) => x.name === 'Biblia de estudio prueba')
ok('producto guardado con precio 1.250.000', prod && Number(prod.price) === 1250000, JSON.stringify(prod).slice(0, 120))
const det = (await call('GET', '/products/' + prod?.id, { token: tk })).json
ok('la foto quedó guardada en el producto', det?.images?.length === 1, JSON.stringify(det?.images))
const img = await fetch('http://127.0.0.1:3099' + (det?.images?.[0]?.url ?? '/x')); ok('la imagen se puede ver (200 image/*)', img.status === 200 && (img.headers.get('content-type') ?? '').startsWith('image/'))
console.log('== Agregar otra foto a un producto existente')
await p.goto('http://127.0.0.1:5199/products', { waitUntil: 'networkidle' }); await p.waitForTimeout(500)
console.log('== Gasto: Luz Gs. 1.250.000')
await p.goto('http://127.0.0.1:5199/gastos', { waitUntil: 'networkidle' }); await p.waitForTimeout(500)
await p.locator('button.small', { hasText: 'Luz' }).first().click(); await p.waitForTimeout(300)
const imp = p.getByLabel('Importe'); await tipear(imp, '1250000'); ok('importe 1250000 → 1.250.000', (await imp.inputValue()) === '1.250.000', await imp.inputValue())
await tipear(imp, '85000'); ok('corrigiendo a 85000 → 85.000', (await imp.inputValue()) === '85.000')
await tipear(imp, '1234567890'); ok('10 dígitos 1234567890 → 1.234.567.890', (await imp.inputValue()) === '1.234.567.890', await imp.inputValue())
await tipear(imp, '320000'); await p.getByRole('button', { name: 'Guardar' }).click(); await p.waitForTimeout(1500)
const ex = (await call('GET', '/expenses', { token: tk })).json
ok('gasto de luz guardado por 320.000', ex.some((e) => Number(e.amount) === 320000 && /Luz/i.test(e.concept)), JSON.stringify(ex.slice(0, 1)).slice(0, 200))
await p.screenshot({ path: out + '/uso-gasto.png' })
await b.close(); process.exit(summary() ? 1 : 0)
