import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

export interface User { id: number; username: string; name: string; role: string; mustChange?: boolean }

const TOKEN_KEY = 'samantha.token'
const USER_KEY = 'samantha.user'

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY)
  const res = await fetch('/api' + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && token) { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); location.reload() }
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`)
  return data
}

export const gs = (n: number | string | null | undefined) => 'Gs. ' + Number(n ?? 0).toLocaleString('es-PY')

// Abre el comprobante electrónico (KUDE) del proveedor en una ventana nueva y lo manda a imprimir.
// El HTML se trae con el token (la ruta pide permiso), por eso no se puede abrir la URL directamente.
export async function openKude(invoiceId: number, formato?: string): Promise<void> {
  const w = window.open('', '_blank')
  if (!w) throw new Error('El navegador bloqueó la ventana. Permití las ventanas emergentes para imprimir.')
  w.document.write('<p style="font:14px sans-serif;padding:20px">Cargando comprobante…</p>')
  try {
    const token = localStorage.getItem(TOKEN_KEY)
    const res = await fetch(`/api/invoices/${invoiceId}/kude${formato ? '?formato=' + formato : ''}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) } })
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error ?? 'No se pudo obtener el comprobante') }
    const html = await res.text()
    w.document.open(); w.document.write(html); w.document.close()
    setTimeout(() => { try { w.focus(); w.print() } catch { /* el usuario imprime manualmente */ } }, 500)
  } catch (e) { w.close(); throw e }
}
export const paymentMethodLabel = (method: string) => ({ cash: 'Efectivo', card: 'Tarjeta', transfer: 'Transferencia', check: 'Cheque', online: 'Pago en línea', advance: 'Anticipo' })[method as 'cash' | 'card' | 'transfer' | 'check' | 'online' | 'advance'] ?? method

interface Ctx { user: User | null; login(u: string, p: string): Promise<void>; passwordChanged(): void; logout(): void; toast(msg: string, err?: boolean): void }
const AuthCtx = createContext<Ctx>(null as never)
export const useApp = () => useContext(AuthCtx)

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    try { return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null') } catch { return null }
  })
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null)
  const toast = useCallback((text: string, err = false) => { setMsg({ text, err }); setTimeout(() => setMsg(null), 4000) }, [])
  const login = async (username: string, password: string) => {
    const r = await api('/login', { body: { username, password } })
    localStorage.setItem(TOKEN_KEY, r.token); localStorage.setItem(USER_KEY, JSON.stringify(r.user)); setUser(r.user)
  }
  const passwordChanged = () => setUser((u) => { const n = u ? { ...u, mustChange: false } : u; if (n) localStorage.setItem(USER_KEY, JSON.stringify(n)); return n })
  const logout = () => {
    api('/logout', { method: 'POST', body: {} }).catch(() => {})
    localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); setUser(null)
  }
  return (
    <AuthCtx.Provider value={{ user, login, passwordChanged, logout, toast }}>
      {children}
      {msg && <div className={'toast' + (msg.err ? ' err' : '')}>{msg.text}</div>}
    </AuthCtx.Provider>
  )
}

export const ADMIN_ROLES = ['owner', 'admin']
export const canSee: Record<string, string[]> = {
  '/admin': ['owner', 'admin', 'accountant'],
  '/pos': ['owner', 'admin', 'cashier', 'seller'],
  '/sales': ['owner', 'admin', 'cashier', 'seller'],
  '/products': ['owner', 'admin', 'cashier', 'seller', 'buyer', 'warehouse', 'accountant', 'support'],
  '/finanzas': ['owner', 'admin', 'accountant'],
  '/gastos': ['owner', 'admin', 'accountant'],
  '/reports': ['owner', 'admin', 'accountant', 'buyer', 'warehouse'],
  '/inventory': ['owner', 'admin', 'warehouse'],
  '/purchases': ['owner', 'admin', 'buyer', 'warehouse', 'accountant'],
  '/suppliers': ['owner', 'admin', 'buyer', 'accountant'],
  '/customers': ['owner', 'admin', 'cashier', 'seller', 'accountant', 'support'],
  '/cash': ['owner', 'admin', 'cashier'],
  '/workorders': ['owner', 'admin', 'cashier', 'seller', 'support'],
  '/orders': ['owner', 'admin', 'cashier', 'warehouse', 'support'],
  '/delivery': ['owner', 'admin', 'cashier', 'warehouse', 'support'],
  '/accounting': ['owner', 'admin', 'accountant'],
  '/automation': ['owner', 'admin', 'accountant', 'buyer'],
  '/prompts': ['owner', 'admin'],
  '/settings': ['owner', 'admin'],
}
