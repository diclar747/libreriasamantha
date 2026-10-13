import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { gs, useApp } from '../api'
import './account.css'

// ---------------------------------------------------------------- API del cliente (sesión propia, separada de la del personal)
const CT = 'samantha.ctoken'
export async function cust<T = any>(path: string, opts: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<T> {
  const token = localStorage.getItem(CT)
  const res = await fetch('/api/shop/account' + path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  if (opts.raw) { if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Error ${res.status}`); return (await res.blob()) as any }
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && token) { localStorage.removeItem(CT); window.dispatchEvent(new Event('customer-logout')) }
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Error ${res.status}`), { issues: data.issues })
  return data
}
const fieldErrors = (e: any) => Object.fromEntries((e.issues ?? []).map((i: any) => [i.path?.[0], i.message]))
const fmtDate = (v?: string | null) => (v ? new Date(v.length <= 10 ? v + 'T12:00:00' : v).toLocaleDateString('es-PY', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
const fmtDT = (v?: string | null) => (v ? new Date(v).toLocaleString('es-PY', { dateStyle: 'medium', timeStyle: 'short' }) : '—')
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now())

interface CCtx { profile: any | null; ready: boolean; token: string | null; login(email: string, password: string): Promise<void>; register(b: any): Promise<any>; logout(): Promise<void>; refresh(): Promise<void>; favs: number[]; toggleFav(id: number): Promise<void> }
const Ctx = createContext<CCtx>(null as never)
export const useCustomer = () => useContext(Ctx)

export function CustomerProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<any>(null)
  const [ready, setReady] = useState(false)
  const [favs, setFavs] = useState<number[]>([])
  const refresh = useCallback(async () => {
    if (!localStorage.getItem(CT)) { setProfile(null); setFavs([]); setReady(true); return }
    try { setProfile(await cust('/me')); setFavs(await cust('/favorite-ids')) } catch { setProfile(null) } finally { setReady(true) }
  }, [])
  useEffect(() => { refresh(); const f = () => { setProfile(null); setFavs([]) }; window.addEventListener('customer-logout', f); return () => window.removeEventListener('customer-logout', f) }, [])
  // los cambios que hace el administrador se reflejan solos: se actualiza el aviso de novedades
  useEffect(() => { if (!profile) return; const t = setInterval(refresh, 30000); return () => clearInterval(t) }, [profile?.id])
  const value: CCtx = useMemo(() => ({
    profile, ready, token: localStorage.getItem(CT), refresh, favs,
    login: async (email, password) => { const r = await cust('/login', { body: { email, password } }); localStorage.setItem(CT, r.token); await refresh() },
    register: async (b) => { const r = await cust('/register', { body: b }); localStorage.setItem(CT, r.token); await refresh(); return r },
    logout: async () => { await cust('/logout', { body: {} }).catch(() => {}); localStorage.removeItem(CT); setProfile(null); setFavs([]) },
    toggleFav: async (id) => {
      if (!localStorage.getItem(CT)) throw new Error('login')
      const on = favs.includes(id)
      await cust('/favorites/' + id, { method: on ? 'DELETE' : 'POST', body: on ? undefined : {} })
      setFavs(on ? favs.filter((x) => x !== id) : [...favs, id])
    },
  }), [profile, ready, favs])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function Err({ text }: { text?: string }) { return text ? <small className="acc-err">{text}</small> : null }
const F = ({ label, err, children, span }: { label: string; err?: string; children: ReactNode; span?: boolean }) => <label className={err ? 'has-error' : ''} style={span ? { gridColumn: '1 / -1' } : undefined}>{label}{children}<Err text={err} /></label>

// ---------------------------------------------------------------- Ingreso, registro y recuperación
export function LoginPage() {
  const { login } = useCustomer()
  const nav = useNavigate()
  const [sp] = useSearchParams()
  const [f, setF] = useState({ email: '', password: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const next = sp.get('next') ?? '/tienda/cuenta'
  return (
    <form className="card acc-auth" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(''); try { await login(f.email, f.password); nav(next) } catch (er: any) { setErr(er.message) } finally { setBusy(false) } }}>
      <h1>Ingresar a tu cuenta</h1>
      <p className="muted">Seguí tus pedidos, guardá tus direcciones y comprá más rápido. Tu carrito se conserva.</p>
      <F label="Correo electrónico"><input type="email" autoComplete="email" autoFocus value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></F>
      <F label="Contraseña"><input type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></F>
      {err && <p className="pill bad acc-msg">{err}</p>}
      <button className="primary" disabled={busy || !f.email || !f.password}>{busy ? 'Ingresando…' : 'Ingresar'}</button>
      <div className="acc-links"><Link to="/tienda/recuperar">Olvidé mi contraseña</Link><Link to={'/tienda/registro' + (sp.get('next') ? '?next=' + encodeURIComponent(sp.get('next')!) : '')}>Crear una cuenta</Link></div>
    </form>
  )
}

export function RegisterPage() {
  const { register } = useCustomer()
  const nav = useNavigate()
  const [sp] = useSearchParams()
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', password: '', confirm: '', phone: '', document: '' })
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value })
  const strength = [/.{8,}/, /[A-Za-z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(f.password)).length
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(''); setErrs({})
    const local: Record<string, string> = {}
    if (f.password !== f.confirm) local.confirm = 'Las contraseñas no coinciden'
    if (Object.keys(local).length) { setErrs(local); setBusy(false); return }
    try { await register(f); nav(sp.get('next') ?? '/tienda/cuenta?bienvenida=1') } catch (er: any) { setErrs(fieldErrors(er)); setErr(er.message) } finally { setBusy(false) }
  }
  return (
    <form className="card acc-auth wide" onSubmit={submit}>
      <h1>Crear tu cuenta</h1>
      <p className="muted">Solo necesitamos lo básico. Los datos de facturación y entrega los completás al comprar.</p>
      <div className="form">
        <F label="Nombre" err={errs.firstName}><input autoFocus value={f.firstName} onChange={set('firstName')} /></F>
        <F label="Apellido" err={errs.lastName}><input value={f.lastName} onChange={set('lastName')} /></F>
        <F label="Correo electrónico" err={errs.email}><input type="email" value={f.email} onChange={set('email')} autoComplete="email" /></F>
        <F label="Teléfono / WhatsApp" err={errs.phone}><input value={f.phone} onChange={set('phone')} placeholder="+595…" /></F>
        <F label="Cédula o RUC (opcional)"><input value={f.document} onChange={set('document')} /></F>
        <span />
        <F label="Contraseña" err={errs.password}><input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" /></F>
        <F label="Repetir contraseña" err={errs.confirm}><input type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" /></F>
      </div>
      <div className="acc-strength" aria-label="Seguridad de la contraseña"><i className={'s' + strength} /><span className="muted">{['', 'Débil', 'Regular', 'Buena', 'Muy buena'][strength]} · mínimo 8 caracteres con letras y números</span></div>
      {err && !Object.keys(errs).length && <p className="pill bad acc-msg">{err}</p>}
      <button className="primary" disabled={busy || !f.firstName || !f.lastName || !f.email || !f.password}>{busy ? 'Creando…' : 'Crear cuenta'}</button>
      <div className="acc-links"><Link to="/tienda/ingresar">Ya tengo cuenta</Link></div>
    </form>
  )
}

export function VerifyPage() {
  const [sp] = useSearchParams()
  const { refresh } = useCustomer()
  const [state, setState] = useState<'wait' | 'ok' | 'bad'>('wait')
  const [msg, setMsg] = useState('')
  useEffect(() => { cust('/verify', { body: { token: sp.get('token') ?? '' } }).then(() => { setState('ok'); refresh() }).catch((e) => { setState('bad'); setMsg(e.message) }) }, [])
  return <div className="card acc-auth"><h1>Verificación de correo</h1>
    {state === 'wait' && <p className="muted">Verificando…</p>}
    {state === 'ok' && <><p className="pill ok acc-msg">¡Listo! Tu correo quedó verificado.</p><Link to="/tienda/cuenta"><button className="primary">Ir a mi cuenta</button></Link></>}
    {state === 'bad' && <><p className="pill bad acc-msg">{msg}</p><Link to="/tienda/cuenta/seguridad">Pedir un enlace nuevo</Link></>}</div>
}

export function ForgotPage() {
  const [email, setEmail] = useState('')
  const [done, setDone] = useState<any>(null)
  return (
    <form className="card acc-auth" onSubmit={async (e) => { e.preventDefault(); setDone(await cust('/forgot', { body: { email } })) }}>
      <h1>Recuperar contraseña</h1>
      {!done ? <><p className="muted">Ingresá tu correo y te enviamos un enlace para elegir una contraseña nueva.</p>
        <F label="Correo electrónico"><input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></F><button className="primary" disabled={!email}>Enviar enlace</button></>
        : <><p className="pill ok acc-msg">{done.message}</p>{done.devResetToken && <p className="muted">Modo de prueba (sin correo real): <Link to={'/tienda/restablecer?token=' + done.devResetToken}>abrir el enlace de recuperación</Link></p>}</>}
      <div className="acc-links"><Link to="/tienda/ingresar">Volver a ingresar</Link></div>
    </form>
  )
}
export function ResetPage() {
  const [sp] = useSearchParams()
  const nav = useNavigate()
  const [pw, setPw] = useState({ password: '', confirm: '' })
  const [err, setErr] = useState('')
  return (
    <form className="card acc-auth" onSubmit={async (e) => { e.preventDefault(); if (pw.password !== pw.confirm) { setErr('Las contraseñas no coinciden'); return } try { await cust('/reset', { body: { token: sp.get('token'), password: pw.password } }); nav('/tienda/ingresar') } catch (er: any) { setErr(er.message) } }}>
      <h1>Elegí una contraseña nueva</h1>
      <F label="Contraseña nueva"><input type="password" autoFocus value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} /></F>
      <F label="Repetir contraseña"><input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></F>
      {err && <p className="pill bad acc-msg">{err}</p>}
      <button className="primary" disabled={!pw.password}>Guardar contraseña</button>
    </form>
  )
}

// ---------------------------------------------------------------- Mi cuenta
const MENU: [string, string, string][] = [['', 'Inicio', '⌂'], ['perfil', 'Mi perfil', '☺'], ['direcciones', 'Mis direcciones', '⌖'], ['facturacion', 'Datos de facturación', '▤'], ['pedidos', 'Mis pedidos', '▣'], ['comprobantes', 'Mis comprobantes', '❏'], ['favoritos', 'Favoritos', '♡'], ['notificaciones', 'Notificaciones', '♪'], ['seguridad', 'Seguridad', '⚿']]

export function AccountArea() {
  const { profile, ready, logout, refresh } = useCustomer()
  const nav = useNavigate()
  const [sp] = useSearchParams()
  if (!ready) return <p className="muted">Cargando…</p>
  if (!profile) return <Navigate to={'/tienda/ingresar?next=' + encodeURIComponent(location.pathname)} replace />
  return (
    <div className="acc-shell">
      <aside className="acc-side card">
        <div className="acc-user"><span className="acc-avatar">{profile.firstName[0]}{profile.lastName[0]}</span><div><b>{profile.firstName} {profile.lastName}</b><small className="muted">{profile.email}</small></div></div>
        <nav>{MENU.map(([to, label, ic]) => <NavLink key={to} end={to === ''} to={'/tienda/cuenta' + (to ? '/' + to : '')}><span aria-hidden>{ic}</span>{label}{to === 'notificaciones' && profile.unread > 0 && <b className="acc-badge">{profile.unread}</b>}</NavLink>)}
          <Link to="/tienda"><span aria-hidden>↗</span>Ver tienda</Link>
          <button onClick={async () => { await logout(); nav('/tienda') }}><span aria-hidden>⏻</span>Cerrar sesión</button></nav>
      </aside>
      <section className="acc-main">
        {!profile.emailVerified && <div className="acc-banner">Verificá tu correo <b>{profile.email}</b> para asegurar tu cuenta. <Link to="/tienda/cuenta/seguridad">Reenviar enlace</Link></div>}
        {sp.get('bienvenida') && <div className="acc-banner ok">¡Bienvenido/a, {profile.firstName}! Tu cuenta está lista.</div>}
        <Routes>
          <Route index element={<Home />} /><Route path="perfil" element={<Profile onSaved={refresh} />} /><Route path="direcciones" element={<Addresses />} />
          <Route path="facturacion" element={<Billing onSaved={refresh} />} /><Route path="pedidos" element={<Orders />} /><Route path="pedidos/:number" element={<OrderDetail />} />
          <Route path="comprobantes" element={<Receipts />} /><Route path="favoritos" element={<Favorites />} /><Route path="notificaciones" element={<Notifications onRead={refresh} />} /><Route path="seguridad" element={<Security />} />
        </Routes>
      </section>
    </div>
  )
}

const STAGE_KIND: Record<string, string> = { pending: 'warn', confirmed: 'ok', preparing: 'warn', ready_to_ship: 'ok', shipped: 'warn', ready_pickup: 'ok', delivered: 'ok', picked_up: 'ok', cancelled: 'bad' }
export const PAY_LABEL: Record<string, string> = { pending: 'Pago pendiente', in_review: 'Comprobante en revisión', approved: 'Pagado', rejected: 'Pago rechazado', partially_refunded: 'Reembolso parcial', refunded: 'Reembolsado' }

function useLoad<T>(path: string, every = 0) {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState('')
  const reload = useCallback(() => cust<T>(path).then((d) => { setData(d); setErr('') }).catch((e) => setErr(e.message)), [path])
  useEffect(() => { setData(null); reload(); if (every) { const t = setInterval(reload, every); return () => clearInterval(t) } }, [path])
  return { data, err, reload }
}

function Home() {
  const { profile } = useCustomer()
  const d = useLoad<any>('/dashboard', 15000)
  if (!d.data) return <p className="muted">{d.err || 'Cargando…'}</p>
  const x = d.data
  return (
    <div className="acc-stack">
      <div><h1>Hola, {profile.firstName}</h1><p className="muted">Este es el resumen de tu cuenta.</p></div>
      {x.needs.length > 0 && <div className="card acc-needs"><h2>Necesitamos tu atención</h2>{x.needs.map((n: any, i: number) => <Link key={i} to={'/tienda/cuenta/pedidos/' + n.number} className="acc-need"><b>{n.number}</b><span>{n.text}</span><i>→</i></Link>)}</div>}
      <div className="acc-kpis"><div className="card"><small>Pedidos realizados</small><b>{x.stats.orders}</b></div><div className="card"><small>Pedidos activos</small><b>{x.stats.active}</b></div><div className="card"><small>Total comprado</small><b>{gs(x.stats.spent)}</b></div><div className="card"><small>Favoritos</small><b>{x.stats.favorites}</b></div></div>
      <div className="card"><h2>Pedidos en curso</h2>{x.active.map((o: any) => <Link key={o.id} to={'/tienda/cuenta/pedidos/' + o.number} className="acc-row"><span><b>{o.number}</b><small className="muted">{fmtDate(o.createdAt)} · {o.deliveryMethod === 'pickup' ? 'Retiro en local' : 'Delivery'}</small></span><span className={'pill ' + STAGE_KIND[o.stage]}>{o.stageLabel}</span><b>{gs(o.total)}</b></Link>)}{!x.active.length && <p className="muted">No tenés pedidos en curso. <Link to="/tienda">Ir a la tienda</Link></p>}</div>
      <div className="card"><h2>Últimas novedades</h2>{x.notifications.map((n: any) => <div key={n.id} className={'acc-note' + (n.read_at ? '' : ' new')}><b>{n.title}</b><span>{n.body}</span><small className="muted">{fmtDT(n.created_at)}</small></div>)}{!x.notifications.length && <p className="muted">Todavía no hay novedades.</p>}</div>
    </div>
  )
}

function Profile({ onSaved }: { onSaved: () => void }) {
  const { profile } = useCustomer()
  const { toast } = useApp()
  const [f, setF] = useState({ firstName: profile.firstName, lastName: profile.lastName, phone: profile.phone ?? '', whatsapp: profile.whatsapp ?? '', document: profile.document ?? '', billingName: profile.billingName ?? '', billingDoc: profile.billingDoc ?? '' })
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [em, setEm] = useState({ email: '', password: '' })
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value })
  return (
    <div className="acc-stack"><h1>Mi perfil</h1>
      <form className="card" onSubmit={async (e) => { e.preventDefault(); setErrs({}); try { await cust('/me', { method: 'PUT', body: f }); toast('Perfil actualizado'); onSaved() } catch (er: any) { setErrs(fieldErrors(er)); toast(er.message, true) } }}>
        <div className="form"><F label="Nombre" err={errs.firstName}><input value={f.firstName} onChange={set('firstName')} /></F><F label="Apellido" err={errs.lastName}><input value={f.lastName} onChange={set('lastName')} /></F>
          <F label="Teléfono de contacto" err={errs.phone}><input value={f.phone} onChange={set('phone')} /></F><F label="WhatsApp" err={errs.whatsapp}><input value={f.whatsapp} onChange={set('whatsapp')} /></F>
          <F label="Cédula o RUC"><input value={f.document} onChange={set('document')} /></F></div>
        <p className="muted">Cambiar tus datos no modifica pedidos anteriores: cada pedido conserva lo que confirmaste al comprar.</p><button className="primary">Guardar cambios</button>
      </form>
      <form className="card" onSubmit={async (e) => { e.preventDefault(); try { const r = await cust('/me/email', { body: em }); toast(r.message); setEm({ email: '', password: '' }); onSaved() } catch (er: any) { toast(er.message, true) } }}>
        <h2>Correo electrónico</h2><p className="muted">Correo actual: <b>{profile.email}</b>{profile.pendingEmail && <> · pendiente de verificar: <b>{profile.pendingEmail}</b></>}. El cambio se aplica cuando confirmás el enlace que te enviamos al correo nuevo.</p>
        <div className="form"><F label="Correo nuevo"><input type="email" value={em.email} onChange={(e) => setEm({ ...em, email: e.target.value })} /></F><F label="Tu contraseña actual"><input type="password" value={em.password} onChange={(e) => setEm({ ...em, password: e.target.value })} /></F></div>
        <button disabled={!em.email || !em.password}>Cambiar correo</button></form>
    </div>
  )
}

function Billing({ onSaved }: { onSaved: () => void }) {
  const { profile } = useCustomer()
  const { toast } = useApp()
  const [f, setF] = useState({ billingName: profile.billingName ?? '', billingDoc: profile.billingDoc ?? profile.document ?? '' })
  return (
    <div className="acc-stack"><h1>Datos de facturación</h1>
      <form className="card" onSubmit={async (e) => { e.preventDefault(); try { await cust('/me', { method: 'PUT', body: { firstName: profile.firstName, lastName: profile.lastName, phone: profile.phone, whatsapp: profile.whatsapp, document: profile.document, ...f } }); toast('Datos de facturación guardados'); onSaved() } catch (er: any) { toast(er.message, true) } }}>
        <p className="muted">Se usan para tus facturas. Antes de confirmar cada compra podés elegir otros datos.</p>
        <div className="form"><F label="Nombre o razón social"><input value={f.billingName} onChange={(e) => setF({ ...f, billingName: e.target.value })} /></F><F label="Cédula o RUC"><input value={f.billingDoc} onChange={(e) => setF({ ...f, billingDoc: e.target.value })} /></F></div>
        <button className="primary">Guardar</button></form></div>
  )
}

export function AddressForm({ initial, cities, onDone, onCancel }: { initial?: any; cities: any[]; onDone: (a: any) => void; onCancel: () => void }) {
  const { toast } = useApp()
  const [f, setF] = useState<any>({ label: '', recipientName: '', recipientPhone: '', neighborhood: '', street: '', houseNumber: '', reference: '', instructions: '', lat: '', lng: '', isDefault: false, ...(initial ?? {}), cityId: initial?.cityId ?? '' })
  const [other, setOther] = useState(!!initial?.recipientName)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value })
  const departments = [...new Set(cities.map((c) => c.department))]
  const [dep, setDep] = useState(cities.find((c) => c.id === f.cityId)?.department ?? 'Capital')
  async function save() {
    setErrs({})
    const body = { ...f, cityId: f.cityId ? Number(f.cityId) : null, lat: f.lat === '' ? null : Number(f.lat), lng: f.lng === '' ? null : Number(f.lng), recipientName: other ? f.recipientName : '', recipientPhone: other ? f.recipientPhone : '' }
    try { const a = f.id ? await cust('/addresses/' + f.id, { method: 'PUT', body }) : await cust('/addresses', { body }); toast('Dirección guardada'); onDone(a) } catch (e: any) { setErrs(fieldErrors(e)); toast(e.message, true) }
  }
  return (
    <div className="card acc-addr-form">
      <div className="form">
        <F label="Nombre de la dirección"><input value={f.label} onChange={set('label')} placeholder="Casa, trabajo…" /></F>
        <F label="Departamento"><select value={dep} onChange={(e) => { setDep(e.target.value); setF({ ...f, cityId: '' }) }}>{departments.map((d) => <option key={d}>{d}</option>)}</select></F>
        <F label="Ciudad"><select value={f.cityId} onChange={set('cityId')}><option value="">Elegir…</option>{cities.filter((c) => c.department === dep).map((c) => <option key={c.id} value={c.id}>{c.name}{c.covered ? '' : ' (sin delivery)'}</option>)}</select></F>
        <F label="Barrio"><input value={f.neighborhood} onChange={set('neighborhood')} /></F>
        <F label="Calle *" err={errs.street}><input value={f.street} onChange={set('street')} /></F><F label="N.º de casa"><input value={f.houseNumber} onChange={set('houseNumber')} /></F>
        <F label="Referencias" span><input value={f.reference} onChange={set('reference')} placeholder="Portón verde, frente a la plaza…" /></F>
        <F label="Indicaciones para el repartidor" span><input value={f.instructions} onChange={set('instructions')} placeholder="Tocar timbre, llamar al llegar…" /></F>
        <F label="Ubicación en el mapa (latitud, opcional)"><input inputMode="decimal" value={f.lat} onChange={set('lat')} placeholder="-25.2867" /></F><F label="Longitud"><input inputMode="decimal" value={f.lng} onChange={set('lng')} placeholder="-57.6470" /></F>
      </div>
      <button type="button" className="small" onClick={() => navigator.geolocation?.getCurrentPosition((p) => setF((c: any) => ({ ...c, lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6) })))}>Usar mi ubicación actual</button>
      {f.lat !== '' && f.lng !== '' && <a className="muted" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${f.lat}&mlon=${f.lng}#map=17/${f.lat}/${f.lng}`}> Ver en el mapa ↗</a>}
      <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={other} onChange={(e) => setOther(e.target.checked)} /> Lo recibe otra persona</label>
      {other && <div className="form"><F label="Nombre de quien recibe"><input value={f.recipientName} onChange={set('recipientName')} /></F><F label="Teléfono de quien recibe"><input value={f.recipientPhone} onChange={set('recipientPhone')} /></F></div>}
      <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={f.isDefault} onChange={(e) => setF({ ...f, isDefault: e.target.checked })} /> Usar como dirección predeterminada</label>
      <div className="row"><button className="primary" onClick={save} disabled={!f.street}>Guardar dirección</button><button onClick={onCancel}>Cancelar</button></div>
    </div>
  )
}

function Addresses() {
  const { toast } = useApp()
  const list = useLoad<any[]>('/addresses')
  const [cities, setCities] = useState<any[]>([])
  const [edit, setEdit] = useState<any>(null)
  useEffect(() => { fetch('/api/shop/cities').then((r) => r.json()).then(setCities) }, [])
  return (
    <div className="acc-stack"><div className="acc-head"><h1>Mis direcciones</h1><button className="primary" onClick={() => setEdit({})}>Agregar dirección</button></div>
      {edit && <AddressForm initial={edit.id ? edit : undefined} cities={cities} onCancel={() => setEdit(null)} onDone={() => { setEdit(null); list.reload() }} />}
      <div className="acc-grid">{(list.data ?? []).map((a) => (
        <div className="card acc-addr" key={a.id}><div className="row" style={{ justifyContent: 'space-between' }}><b>{a.label || 'Dirección'}</b>{a.isDefault && <span className="pill ok">Predeterminada</span>}</div>
          <p>{a.street} {a.houseNumber}<br />{[a.neighborhood, a.cityName, a.department].filter(Boolean).join(', ')}</p>{a.reference && <p className="muted">{a.reference}</p>}{a.instructions && <p className="muted">Indicaciones: {a.instructions}</p>}{a.recipientName && <p className="muted">Recibe: {a.recipientName} {a.recipientPhone}</p>}
          <div className="row"><button className="small" onClick={() => setEdit(a)}>Editar</button>{!a.isDefault && <button className="small" onClick={async () => { await cust(`/addresses/${a.id}/default`, { body: {} }); list.reload() }}>Hacer predeterminada</button>}<button className="small danger" onClick={async () => { if (confirm('¿Eliminar esta dirección? Tus pedidos anteriores no cambian.')) { await cust('/addresses/' + a.id, { method: 'DELETE' }); toast('Dirección eliminada'); list.reload() } }}>Eliminar</button></div></div>))}
        {list.data && !list.data.length && !edit && <p className="muted">Todavía no guardaste direcciones.</p>}</div></div>
  )
}

function Orders() {
  const [f, setF] = useState({ q: '', stage: '', from: '', to: '' })
  const [page, setPage] = useState(1)
  const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page: String(page) }).toString()
  const d = useLoad<any>('/orders?' + qs, 20000)
  return (
    <div className="acc-stack"><h1>Mis pedidos</h1>
      <div className="card"><div className="form"><F label="Buscar por número"><input value={f.q} onChange={(e) => { setF({ ...f, q: e.target.value }); setPage(1) }} placeholder="P-000123" /></F>
        <F label="Estado"><select value={f.stage} onChange={(e) => { setF({ ...f, stage: e.target.value }); setPage(1) }}><option value="">Todos</option><option value="active">En curso</option><option value="delivered">Entregados</option><option value="picked_up">Retirados</option><option value="cancelled">Cancelados</option></select></F>
        <F label="Desde"><input type="date" value={f.from} onChange={(e) => { setF({ ...f, from: e.target.value }); setPage(1) }} /></F><F label="Hasta"><input type="date" value={f.to} onChange={(e) => { setF({ ...f, to: e.target.value }); setPage(1) }} /></F></div></div>
      {(d.data?.items ?? []).map((o: any) => (
        <Link key={o.id} to={o.number} className="card acc-order">
          <div className="acc-thumbs">{o.thumbs.map((t: string, i: number) => <img key={i} src={t.replace('s=md', 's=thumb')} alt="" />)}{!o.thumbs.length && <span>▣</span>}</div>
          <div><b>{o.number}</b><small className="muted">{fmtDate(o.createdAt)} · {o.units} {o.units === 1 ? 'producto' : 'productos'} · {o.deliveryMethod === 'pickup' ? 'Retiro en local' : 'Delivery'}</small>
            <div className="row"><span className={'pill ' + STAGE_KIND[o.stage]}>{o.stageLabel}</span><span className={'pill ' + (o.paymentStatus === 'approved' ? 'ok' : o.paymentStatus === 'rejected' ? 'bad' : 'warn')}>{PAY_LABEL[o.paymentStatus]}</span></div></div>
          <b className="acc-total">{gs(o.total)}</b></Link>))}
      {d.data && !d.data.items.length && <div className="card"><p className="muted">No encontramos pedidos. <Link to="/tienda">Ir a la tienda</Link></p></div>}
      {d.data && d.data.pages > 1 && <div className="row"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button><span>{page} / {d.data.pages}</span><button disabled={page >= d.data.pages} onClick={() => setPage(page + 1)}>›</button></div>}
    </div>
  )
}

function OrderDetail() {
  const { number } = useParams()
  const { toast } = useApp()
  const nav = useNavigate()
  const d = useLoad<any>('/orders/' + number, 8000)
  const [panel, setPanel] = useState<null | 'cancel' | 'return' | 'message' | 'proof'>(null)
  const [text, setText] = useState('')
  const [ret, setRet] = useState<Record<number, number>>({})
  const [photos, setPhotos] = useState<File[]>([])
  const [proof, setProof] = useState<{ file: File | null; amount: string; ref: string; accountId: string }>({ file: null, amount: '', ref: '', accountId: '' })
  const [opts, setOpts] = useState<any>(null)
  const o = d.data
  useEffect(() => { if (o?.payment.method === 'transfer') fetch('/api/shop/payment-options').then((r) => r.json()).then(setOpts) }, [o?.payment.method])
  if (!o) return <p className="muted">{d.err || 'Cargando…'}</p>
  const act = async (fn: () => Promise<any>, ok: string) => { try { await fn(); toast(ok); setPanel(null); setText(''); d.reload() } catch (e: any) { toast(e.message, true) } }
  const toB64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f) })
  const pay = async () => { try { const r = await fetch(`/api/shop/orders/${o.number}/retry-payment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: o.token }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); location.href = j.url } catch (e: any) { toast(e.message, true) } }
  const sendProof = () => act(async () => {
    const res = await fetch(`/api/shop/orders/${o.number}/proof`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: o.token, accountId: proof.accountId ? Number(proof.accountId) : null, amount: proof.amount ? Number(proof.amount.replace(/\D/g, '')) : null, reference: proof.ref || null, filename: proof.file!.name, mime: proof.file!.type, dataBase64: await toB64(proof.file!) }) })
    if (!res.ok) throw new Error((await res.json()).error)
  }, 'Comprobante enviado: lo revisamos y te avisamos')
  const reorder = async () => {
    const r = await cust('/orders/' + o.number + '/reorder', { body: {} })
    const cart = (() => { try { return JSON.parse(localStorage.getItem('samantha.cart') ?? '[]') } catch { return [] } })()
    for (const i of r.items.filter((x: any) => x.availability !== 'out')) { const ex = cart.find((c: any) => c.id === i.id); if (ex) ex.qty += i.qty; else cart.push({ id: i.id, name: i.name, price: i.price, qty: i.qty, max: 99, list: i.listPrice, image: i.image }) }
    localStorage.setItem('samantha.cart', JSON.stringify(cart))
    toast(r.unavailable.length ? `Agregamos lo disponible. Sin stock: ${r.unavailable.join(', ')}` : 'Agregamos los productos con los precios de hoy', !!r.unavailable.length)
    if (r.items.some((i: any) => i.priceChanged)) toast('Algunos precios cambiaron desde tu compra anterior; revisalos en el carrito', true)
    location.href = '/tienda/checkout'
  }
  const invoice = async (id: number, num: string) => { try { const blob = await cust<Blob>(`/orders/${o.number}/invoice/${id}`, { raw: true }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${num}.pdf`; a.click() } catch (e: any) { toast(e.message, true) } }
  const has = (a: string) => o.actions.includes(a)
  const dl = o.delivery

  return (
    <div className="acc-stack">
      <div className="acc-head"><div><button className="link" onClick={() => nav('/tienda/cuenta/pedidos')}>← Mis pedidos</button><h1>Pedido {o.number}</h1><span className="muted">Realizado el {fmtDT(o.createdAt)}</span></div><span className={'pill big ' + STAGE_KIND[o.stage]}>{o.stageLabel}</span></div>
      <div className="card"><p style={{ margin: 0 }}>{o.stageText}{o.cancelReason ? ` Motivo: ${o.cancelReason}.` : ''}{dl.eta && o.stage === 'shipped' ? ` Llega aproximadamente el ${fmtDate(dl.eta)}.` : ''}</p>
        {o.status === 'cancelled' && o.payment.status === 'approved' && <p className="pill warn acc-msg">Tu reembolso está en proceso.</p>}
        {o.cancelRequested && <p className="pill warn acc-msg">Solicitaste cancelar este pedido: lo estamos revisando.</p>}
        {o.status !== 'cancelled' && <ol className="acc-progress">{o.progress.map((p: any) => <li key={p.stage} className={(p.done ? 'done ' : '') + (p.current ? 'current' : '')}><i>{p.done ? '✓' : ''}</i><b>{p.label}</b><small>{p.at ? fmtDT(p.at) : ''}</small></li>)}</ol>}</div>

      <div className="acc-actions">
        {has('pay') && <button className="primary" onClick={pay}>Completar el pago</button>}{has('proof') && <button className="primary" onClick={() => setPanel('proof')}>Subir comprobante</button>}
        {has('cancel') && <button onClick={() => setPanel('cancel')}>Solicitar cancelación</button>}{has('return') && <button onClick={() => setPanel('return')}>Solicitar devolución</button>}
        <button onClick={() => setPanel('message')}>Consultar sobre este pedido</button><button onClick={reorder}>Volver a comprar</button></div>

      {panel === 'proof' && <div className="card acc-stack-s"><h2>Pagá por transferencia</h2>
        {(opts?.transfer?.accounts ?? []).map((a: any) => <div key={a.id} className="acc-bank"><b>{a.bank_name ?? a.name}</b>{a.is_demo && <span className="pill warn">Cuenta de demostración</span>}<span>N.º {a.account_number} · {a.account_type}</span><span>Titular: {a.holder} {a.holder_document}</span>{a.alias && <span>Alias: {a.alias}</span>}</div>)}
        <p className="pill ok acc-msg">Importe: {gs(o.money.total)} · Concepto: {o.number}</p>
        <div className="form">{(opts?.transfer?.accounts?.length ?? 0) > 1 && <F label="Cuenta usada"><select value={proof.accountId} onChange={(e) => setProof({ ...proof, accountId: e.target.value })}>{opts.transfer.accounts.map((a: any) => <option key={a.id} value={a.id}>{a.bank_name ?? a.name}</option>)}</select></F>}
          <F label="Importe transferido"><input inputMode="numeric" value={proof.amount} onChange={(e) => setProof({ ...proof, amount: e.target.value })} placeholder={String(o.money.total)} /></F><F label="N.º de operación"><input value={proof.ref} onChange={(e) => setProof({ ...proof, ref: e.target.value })} /></F>
          <F label="Comprobante (foto o PDF)"><input type="file" accept="image/*,application/pdf" onChange={(e) => setProof({ ...proof, file: e.target.files?.[0] ?? null })} /></F></div>
        <div className="row"><button className="primary" disabled={!proof.file} onClick={sendProof}>Enviar comprobante</button><button onClick={() => setPanel(null)}>Cancelar</button></div>
        <small className="muted">Adjuntar el comprobante no confirma el pago: el local lo revisa y te avisa.</small></div>}
      {panel === 'cancel' && <div className="card acc-stack-s"><h2>Solicitar cancelación</h2><F label="Contanos el motivo"><textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></F><div className="row"><button className="danger" disabled={text.length < 3} onClick={() => act(() => cust(`/orders/${o.number}/cancel-request`, { body: { reason: text } }), 'Enviamos tu solicitud')}>Enviar solicitud</button><button onClick={() => setPanel(null)}>Volver</button></div></div>}
      {panel === 'message' && <div className="card acc-stack-s"><h2>Consultar sobre el pedido {o.number}</h2><F label="Tu mensaje"><textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></F><div className="row"><button className="primary" disabled={text.length < 2} onClick={() => act(() => cust(`/orders/${o.number}/message`, { body: { text } }), 'Mensaje enviado')}>Enviar</button><button onClick={() => setPanel(null)}>Volver</button></div></div>}
      {panel === 'return' && <div className="card acc-stack-s"><h2>Solicitar devolución</h2>
        {o.items.map((i: any) => <div key={i.id} className="acc-row"><span>{i.name} <small className="muted">(comprados {i.qty})</small></span><input type="number" min={0} max={i.qty} style={{ width: 80 }} value={ret[i.id] ?? 0} onChange={(e) => setRet({ ...ret, [i.id]: Math.min(i.qty, Math.max(0, Number(e.target.value))) })} /></div>)}
        <F label="Motivo"><textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} /></F><F label="Fotos del producto (opcional, hasta 4)"><input type="file" accept="image/*" multiple onChange={(e) => setPhotos([...(e.target.files ?? [])].slice(0, 4))} /></F>
        <div className="row"><button className="primary" disabled={text.length < 3 || !Object.values(ret).some((n) => n > 0)} onClick={() => act(async () => cust(`/orders/${o.number}/return-request`, { body: { reason: text, items: Object.entries(ret).filter(([, n]) => n > 0).map(([id, qty]) => ({ orderItemId: Number(id), qty })), photos: await Promise.all(photos.map(async (p) => ({ filename: p.name, mime: p.type, dataBase64: await toB64(p) }))) } }), 'Solicitud de devolución enviada')}>Enviar solicitud</button><button onClick={() => setPanel(null)}>Volver</button></div>
        <small className="muted">La devolución del dinero se registra cuando recibimos y verificamos el producto.</small></div>}

      <div className="acc-two">
        <div className="card"><h2>Productos</h2>{o.items.map((i: any) => <div key={i.id} className="acc-item">{i.image_url ? <img src={i.image_url.replace('s=md', 's=thumb')} alt="" /> : <span className="acc-noimg">▣</span>}<span><b>{i.name}</b><small className="muted">{i.qty} × {gs(i.unit_price)}</small></span><b>{gs(i.qty * i.unit_price)}</b></div>)}
          <div className="acc-sum"><div><span>Subtotal</span><b>{gs(o.money.subtotal)}</b></div>{o.money.discount > 0 && <div><span>Descuento {o.money.coupon ? `(${o.money.coupon})` : ''}</span><b>−{gs(o.money.discount)}</b></div>}<div><span>Envío</span><b>{gs(o.money.shipping)}</b></div><div className="t"><span>Total</span><b>{gs(o.money.total)}</b></div></div></div>
        <div className="acc-stack-s">
          <div className="card"><h2>Pago</h2><p><span className={'pill ' + (o.payment.status === 'approved' ? 'ok' : o.payment.status === 'rejected' ? 'bad' : 'warn')}>{PAY_LABEL[o.payment.status]}</span> · {o.payment.method === 'transfer' ? 'Transferencia bancaria' : o.payment.method === 'cod' ? 'Contra entrega' : 'Tarjeta en línea'}</p>
            <div className="acc-sum"><div><span>Pagado</span><b>{gs(o.money.paid)}</b></div><div><span>Pendiente</span><b>{gs(o.money.pending)}</b></div>{o.money.refunded > 0 && <div><span>Reembolsado</span><b>{gs(o.money.refunded)}</b></div>}</div></div>
          <div className="card"><h2>{dl.method === 'pickup' ? 'Retiro en el local' : 'Entrega a domicilio'}</h2>
            {dl.method === 'delivery' ? <p>{dl.address}<br />{[dl.neighborhood, dl.city, dl.department].filter(Boolean).join(', ')}{dl.reference && <><br /><span className="muted">{dl.reference}</span></>}<br />Recibe: <b>{dl.recipientName}</b> {dl.recipientPhone}</p> : <p>Retirás en Librería Samantha.</p>}
            {dl.carrier && <p>Transporte: <b>{dl.carrier}</b>{dl.trackingNumber && <> · Seguimiento {dl.trackingUrl ? <a href={dl.trackingUrl} target="_blank" rel="noreferrer">{dl.trackingNumber}</a> : dl.trackingNumber}</>}</p>}
            {dl.note && <p className="muted">Nota del local: {dl.note}</p>}{dl.receivedBy && <p>{dl.method === 'pickup' ? 'Retiró' : 'Recibió'}: <b>{dl.receivedBy}</b> · {fmtDT(dl.deliveredAt)}</p>}
            {dl.attempts.map((a: any, i: number) => <p key={i} className="pill warn acc-msg">Intento fallido ({fmtDate(a.at)}): {a.reason}{a.rescheduled_for ? ` · nuevo intento ${fmtDate(a.rescheduled_for)}` : ''}</p>)}</div>
          <div className="card"><h2>Facturación</h2><p>{o.billing.name}<br /><span className="muted">{o.billing.document || 'Sin RUC / CI'}</span></p>
            {o.invoices.map((i: any) => <button key={i.id} className="small" onClick={() => invoice(i.id, i.number)}>⬇ {i.kind === 'credit_note' ? 'Nota de crédito' : 'Factura'} {i.number}</button>)}{!o.invoices.length && <small className="muted">La factura aparece acá cuando se emite.</small>}</div>
        </div>
      </div>
      {!!o.returns.length && <div className="card"><h2>Devoluciones</h2>{o.returns.map((r: any) => <div key={r.id} className="acc-note new"><b>{r.number} · {{ requested: 'Solicitada', approved: 'Aprobada: devolvé el producto', rejected: 'Rechazada', received: 'Producto recibido', refunded: 'Reembolsada', closed: 'Cerrada' }[r.status as string]}</b><span>{(r.items ?? []).map((i: any) => `${i.qty} × ${i.name}`).join(', ')} — {r.reason}</span>{r.admin_response && <span>Respuesta: {r.admin_response}</span>}{r.instructions && <span>Cómo devolverlo: {r.instructions}</span>}{Number(r.refund_amount) > 0 && <span>Reembolsado: {gs(r.refund_amount)}</span>}</div>)}</div>}
      {!!o.messages.length && <div className="card"><h2>Mensajes</h2>{o.messages.map((m: any) => <div key={m.id} className={'acc-note' + (m.author_type === 'staff' ? ' new' : '')}><b>{m.author_type === 'staff' ? 'Librería Samantha' : 'Vos'}</b><span>{m.note}</span><small className="muted">{fmtDT(m.created_at)}</small></div>)}</div>}
      <div className="card"><h2>Historial de actualizaciones</h2><ul className="acc-timeline">{[...o.history].reverse().map((h: any, i: number) => <li key={i}><b>{h.title}</b>{h.note && <span>{h.note}</span>}<small className="muted">{fmtDT(h.at)}</small></li>)}</ul></div>
    </div>
  )
}

function Receipts() {
  const { toast } = useApp()
  const d = useLoad<any>('/orders?page=1')
  const [rows, setRows] = useState<any[]>([])
  useEffect(() => { (async () => { const out: any[] = []; for (const o of d.data?.items ?? []) { if (o.paymentStatus === 'pending') continue; const det = await cust('/orders/' + o.number); for (const i of det.invoices) out.push({ ...i, order: o.number, date: o.createdAt }); if (det.payment.status === 'approved') out.push({ id: 0, kind: 'payment', number: 'Pago ' + o.number, total: det.money.paid, order: o.number, date: o.createdAt }) } setRows(out) })().catch(() => {}) }, [d.data])
  return (
    <div className="acc-stack"><h1>Mis comprobantes</h1>
      <div className="card">{rows.map((r, i) => <div key={i} className="acc-row"><span><b>{r.kind === 'credit_note' ? 'Nota de crédito' : r.kind === 'payment' ? 'Comprobante de pago' : 'Factura'} {r.kind === 'payment' ? '' : r.number}</b><small className="muted">Pedido {r.order} · {fmtDate(r.date)}</small></span><b>{gs(r.total)}</b>
        {r.id ? <button className="small" onClick={async () => { try { const blob = await cust<Blob>(`/orders/${r.order}/invoice/${r.id}`, { raw: true }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = r.number + '.pdf'; a.click() } catch (e: any) { toast(e.message, true) } }}>Descargar PDF</button> : <Link to={'/tienda/cuenta/pedidos/' + r.order}>Ver pedido</Link>}</div>)}
        {!rows.length && <p className="muted">Todavía no hay comprobantes disponibles. Aparecen cuando se confirma el pago y se emite la factura.</p>}</div></div>
  )
}

function Favorites() {
  const { toggleFav } = useCustomer()
  const d = useLoad<any[]>('/favorites')
  return (
    <div className="acc-stack"><h1>Favoritos</h1>
      <div className="acc-grid">{(d.data ?? []).map((p) => <div key={p.id} className="card acc-fav">{p.image_url ? <img src={p.image_url} alt="" /> : <span className="acc-noimg">▣</span>}<Link to={'/tienda/producto/' + p.id}><b>{p.name}</b></Link><span>{gs(p.price)}{p.on_offer && <s className="muted"> {gs(p.list_price)}</s>}</span>{p.availability === 'out' && <span className="pill bad">Agotado</span>}<button className="small" onClick={async () => { await toggleFav(p.id); d.reload() }}>Quitar de favoritos</button></div>)}
        {d.data && !d.data.length && <p className="muted">Marcá productos con el corazón para encontrarlos acá.</p>}</div></div>
  )
}

function Notifications({ onRead }: { onRead: () => void }) {
  const { profile } = useCustomer()
  const { toast } = useApp()
  const d = useLoad<any>('/notifications', 15000)
  const [prefs, setPrefs] = useState<Record<string, any>>(profile.notifPrefs ?? {})
  useEffect(() => { cust('/notifications/read', { body: {} }).then(onRead).catch(() => {}) }, [])
  const get = (t: string, c: string) => prefs[t]?.[c] !== false
  const setP = async (t: string, c: string, v: boolean) => {
    const next = { ...prefs, [t]: { inapp: get(t, 'inapp'), whatsapp: get(t, 'whatsapp'), email: get(t, 'email'), [c]: v } }
    setPrefs(next); try { await cust('/prefs', { method: 'PUT', body: Object.fromEntries(Object.keys(profile.notifTypes).map((k) => [k, { inapp: next[k]?.inapp !== false, whatsapp: next[k]?.whatsapp !== false, email: next[k]?.email !== false }])) }) } catch (e: any) { toast(e.message, true) }
  }
  return (
    <div className="acc-stack"><h1>Notificaciones</h1>
      <div className="card">{(d.data?.items ?? []).map((n: any) => <div key={n.id} className={'acc-note' + (n.read_at ? '' : ' new')}><b>{n.title}</b><span>{n.body}</span><small className="muted">{fmtDT(n.created_at)}{n.order_number && <> · <Link to={'/tienda/cuenta/pedidos/' + n.order_number}>Ver pedido</Link></>}</small></div>)}{d.data && !d.data.items.length && <p className="muted">No tenés notificaciones.</p>}</div>
      <div className="card"><h2>Cómo querés recibir los avisos</h2><table className="acc-table"><thead><tr><th>Aviso</th><th>En mi cuenta</th><th>WhatsApp</th><th>Correo</th></tr></thead>
        <tbody>{Object.entries(profile.notifTypes).map(([k, label]) => <tr key={k}><td>{label as string}</td>{['inapp', 'whatsapp', 'email'].map((c) => <td key={c}><input type="checkbox" style={{ width: 'auto' }} checked={get(k, c)} onChange={(e) => setP(k, c, e.target.checked)} /></td>)}</tr>)}</tbody></table></div></div>
  )
}

function Security() {
  const { profile, logout } = useCustomer()
  const { toast } = useApp()
  const nav = useNavigate()
  const sess = useLoad<any[]>('/sessions')
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
  const [errs, setErrs] = useState<Record<string, string>>({})
  return (
    <div className="acc-stack"><h1>Seguridad</h1>
      <form className="card" onSubmit={async (e) => { e.preventDefault(); if (pw.next !== pw.confirm) { setErrs({ confirm: 'Las contraseñas no coinciden' }); return } setErrs({}); try { await cust('/password', { body: { current: pw.current, next: pw.next } }); toast('Contraseña actualizada. Cerramos tus otras sesiones.'); setPw({ current: '', next: '', confirm: '' }); sess.reload() } catch (er: any) { setErrs(fieldErrors(er)); toast(er.message, true) } }}>
        <h2>Cambiar contraseña</h2><div className="form"><F label="Contraseña actual"><input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></F><F label="Contraseña nueva" err={errs.next}><input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></F><F label="Repetir" err={errs.confirm}><input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></F></div><button className="primary" disabled={!pw.current || !pw.next}>Cambiar contraseña</button></form>
      {!profile.emailVerified && <div className="card"><h2>Verificar correo</h2><p className="muted">Todavía no verificaste {profile.email}.</p><button onClick={async () => { const r = await cust('/resend-verification', { body: {} }); toast('Te enviamos el enlace'); if (r.devVerifyToken) nav('/tienda/verificar?token=' + r.devVerifyToken) }}>Reenviar enlace de verificación</button></div>}
      <div className="card"><h2>Sesiones abiertas</h2>{(sess.data ?? []).map((s) => <div key={s.id} className="acc-row"><span><b>{s.current ? 'Esta sesión' : 'Otro dispositivo'}</b><small className="muted">{(s.user_agent ?? '').slice(0, 70)} · última actividad {fmtDT(s.last_seen)}</small></span>{!s.current && <button className="small danger" onClick={async () => { await cust('/sessions/' + s.id, { method: 'DELETE' }); sess.reload() }}>Cerrar</button>}</div>)}
        <button onClick={async () => { await logout(); nav('/tienda') }}>Cerrar esta sesión</button></div></div>
  )
}
