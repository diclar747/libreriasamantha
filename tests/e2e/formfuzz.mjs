import { chromium } from './pw/node_modules/playwright/index.mjs'
import { login } from './t-lib.mjs'
const tk = await login('admin', 'admin1234')
const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1187/chrome-linux/chrome', args: ['--no-sandbox'] })
const ROUTES = (process.argv[2] ?? '/products,/customers,/suppliers,/purchases,/cash,/finanzas,/gastos,/inventory,/accounting,/workorders,/settings,/orders,/pos,/automation').split(',')
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
await ctx.addInitScript(([t, u]) => { localStorage.setItem('samantha.token', t); localStorage.setItem('samantha.user', u) }, [tk, JSON.stringify({ id: 3, username: 'admin', name: 'Administrador', role: 'owner' })])
const p = await ctx.newPage(); let cur = ''; const log = []
p.on('pageerror', (e) => log.push(`[${cur}] JS ERROR ${e.message.slice(0, 140)}`))
p.on('response', async (r) => { if (r.url().includes('/api/') && r.request().method() !== 'GET' && r.status() >= 400) { let t = ''; try { t = (await r.text()).slice(0, 120) } catch {} log.push(`[${cur}] ${r.request().method()} ${r.url().replace(/^.*\/api/, '')} → ${r.status()} ${t}`) } })
const CREATE = /^(\+\s*)?(Nuev[oa]s?|Agregar|Crear|Añadir|Registrar|Abrir)\b/i
for (const route of ROUTES) {
  await p.goto('http://127.0.0.1:5199' + route, { waitUntil: 'networkidle' }).catch(() => {}); await p.waitForTimeout(500)
  const tabs = (await p.getByRole('tab').count()) || 1
  for (let t = 0; t < tabs; t++) {
    if (await p.getByRole('tab').count()) await p.getByRole('tab').nth(t).click().catch(() => {}); await p.waitForTimeout(400)
    const names = await p.locator('main button, .main button').evaluateAll((els) => els.filter((e) => e.offsetParent && !e.closest('.modal')).map((e) => (e.textContent || '').trim()).filter(Boolean))
    for (const label of [...new Set(names.filter((n) => CREATE.test(n)))]) {
      cur = `${route} · ${label}`
      try {
        await p.locator('main button, .main button').filter({ hasText: label }).first().click({ timeout: 3000 }); await p.waitForTimeout(500)
        const modal = p.locator('.modal, [role=dialog]').last(); if (!(await modal.count())) continue
        // rellenar
        const fields = await modal.locator('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([hidden]), select, textarea').all()
        let i = 0
        for (const f of fields) {
          i++
          const tag = await f.evaluate((e) => e.tagName), type = await f.getAttribute('type'), mode = await f.getAttribute('inputmode'), dis = await f.isDisabled()
          if (dis) continue
          try {
            if (tag === 'SELECT') { const opts = await f.locator('option').evaluateAll((o) => o.map((x) => x.value)); const v = opts.find((x) => x) ; if (v && !(await f.inputValue())) await f.selectOption(v) }
            else if (type === 'date') await f.fill('2026-10-22')
            else if (mode === 'numeric' || type === 'number') { await f.click(); await f.fill(''); await f.pressSequentially('125000', { delay: 15 }) }
            else if (type === 'email') await f.fill(`prueba${i}@correo.com`)
            else if (type === 'password') await f.fill('Prueba-segura-2026')
            else if (type === 'tel') await f.fill('0981123456')
            else if (!(await f.inputValue())) await f.fill(`Prueba ${i} ${Date.now() % 10000}`)
          } catch {}
        }
        const btns = await modal.locator('button.primary').all()
        if (btns.length) { await btns[btns.length - 1].click({ timeout: 3000 }).catch(() => {}); await p.waitForTimeout(900) }
        const toast = await p.locator('.toast').first().textContent({ timeout: 800 }).catch(() => null); if (toast && /error|inválid|falta|no se pudo|interno/i.test(toast)) log.push(`[${cur}] toast: ${toast.slice(0, 120)}`)
        await p.keyboard.press('Escape').catch(() => {}); await p.waitForTimeout(250)
        if (await p.locator('.modal').count()) { await p.locator('.modal button', { hasText: /Cancelar|Cerrar/ }).first().click({ timeout: 800 }).catch(() => {}) }
      } catch (e) { log.push(`[${cur}] no se pudo operar: ${String(e.message).split('\n')[0].slice(0, 100)}`) }
    }
  }
}
await b.close(); console.log([...new Set(log)].join('\n') || 'sin hallazgos')
