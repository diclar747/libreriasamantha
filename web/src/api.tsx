import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

export interface User { id: number; username: string; name: string; role: string }

const TOKEN_KEY = 'samantha.token'
const USER_KEY = 'samantha.user'

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY)
  const res = await fetch('/api' + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && token) { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); location.reload() }
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`)
  return data
}

export const gs = (n: number | string | null | undefined) => 'Gs. ' + Number(n ?? 0).toLocaleString('es-PY')
export const paymentMethodLabel = (method: string) => ({ cash: 'Efectivo', card: 'Tarjeta', transfer: 'Transferencia', check: 'Cheque', online: 'Pago en línea', advance: 'Anticipo' })[method as 'cash' | 'card' | 'transfer' | 'check' | 'online' | 'advance'] ?? method

interface Ctx { user: User | null; login(u: string, p: string): Promise<void>; logout(): void; toast(msg: string, err?: boolean): void }
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
  const logout = () => {
    api('/logout', { method: 'POST', body: {} }).catch(() => {})
    localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); setUser(null)
  }
  return (
    <AuthCtx.Provider value={{ user, login, logout, toast }}>
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
  '/reports': ['owner', 'admin', 'accountant', 'buyer', 'warehouse'],
  '/inventory': ['owner', 'admin', 'warehouse'],
  '/purchases': ['owner', 'admin', 'buyer', 'warehouse', 'accountant'],
  '/suppliers': ['owner', 'admin', 'buyer', 'accountant'],
  '/customers': ['owner', 'admin', 'cashier', 'seller', 'accountant', 'support'],
  '/cash': ['owner', 'admin', 'cashier'],
  '/workorders': ['owner', 'admin', 'cashier', 'seller', 'support'],
  '/orders': ['owner', 'admin', 'cashier', 'warehouse', 'support'],
  '/accounting': ['owner', 'admin', 'accountant'],
  '/automation': ['owner', 'admin', 'accountant', 'buyer'],
  '/prompts': ['owner', 'admin'],
  '/settings': ['owner', 'admin'],
}
