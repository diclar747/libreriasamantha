import { call, login } from './t-lib.mjs'
import { readFileSync } from 'node:fs'
const tk = await login('admin', 'admin1234')
const routes = readFileSync('get-routes.txt', 'utf8').trim().split('\n')
const QS = ['', '?from=&to=&q=&page=&pageSize=&status=&category=&asOf=', '?from=2026-01-01&to=2026-12-31&page=1', '?q=%27%22%3C&page=-1&pageSize=99999']
const bad = []; let n = 0
for (const r of routes) {
  if (/^\/(logout)/.test(r)) continue
  const path = r.replace(/:[A-Za-z]+/g, '1')
  for (const pre of ['', '/shop']) for (const q of QS) {
    const res = await call('GET', pre + path + q, { token: tk }); n++
    if (res.status >= 500) bad.push(`${res.status} ${pre}${path}${q}  ${String(res.json?.error ?? res.text).slice(0, 80)}`)
  }
}
console.log('llamadas:', n); console.log([...new Set(bad)].join('\n') || 'sin errores 500')
