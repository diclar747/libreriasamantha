export const API = process.env.API ?? 'http://127.0.0.1:3099/api'
let pass = 0, fail = 0; const fails = []
export const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✔', name) } else { fail++; fails.push(name); console.log('  ✖', name, extra) } }
export const summary = () => { console.log(`\nRESULTADO: ${pass} aprobadas, ${fail} fallidas`); if (fail) console.log('Fallidas:', fails.join(' | ')); return fail }
export async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(API + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text(); let json = null; try { json = JSON.parse(text) } catch { /* no json */ }
  return { status: res.status, json, text }
}
const NEWPW = 'Auditoria-Segura-2026'
export async function login(u, p) {
  let r = await call('POST', '/login', { body: { username: u, password: NEWPW } })
  if (r.json?.token) return r.json.token
  r = await call('POST', '/login', { body: { username: u, password: p } })
  if (r.json?.user?.mustChange) { await call('POST', '/me/password', { token: r.json.token, body: { current: p, next: NEWPW } }); r = await call('POST', '/login', { body: { username: u, password: NEWPW } }) }
  return r.json?.token
}
