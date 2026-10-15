import type React from 'react'
import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import './styles.css'
import './responsive.css'
import { AppProvider, canSee, useApp } from './api'
import { Icon, type IconName } from './components/Icons'
import { Avatar, Bell, UserMenu } from './components/Topbar'
import { LogoMark } from './components/Logo'
import ThemePicker from './components/ThemePicker'
import { api } from './api'
import Profile from './pages/Profile'
import { InstallProvider, useInstall, useOnline } from './pwa'
import Dashboard from './pages/Dashboard'
import Pos from './pages/Pos'
import Products from './pages/Products'
import Purchases from './pages/Purchases'
import Customers from './pages/Customers'
import Cash from './pages/Cash'
import Sales from './pages/Sales'
import Suppliers from './pages/Suppliers'
import WorkOrders from './pages/WorkOrders'
import Orders from './pages/Orders'
import Accounting from './pages/Accounting'
import Automation from './pages/Automation'
import Settings from './pages/Settings'
import Prompts from './pages/Prompts'
import Reports from './pages/Reports'
import Finance from './pages/Finance'
import Inventory from './pages/Inventory'
import ScanPhone from './pages/ScanPhone'
import { AskProvider } from './ui'
import Store, { PayPage } from './store/Store'
import './modern.css'
import './ui.css'
import './app.css'
import './aurora.css'
import './storefront.css'

type Item = [path: string, label: string, icon: IconName]
const NAV: { group: string; items: Item[] }[] = [
  { group: '', items: [['/admin', 'Panel', 'home']] },
  { group: 'Venta', items: [['/pos', 'Punto de venta', 'pos'], ['/sales', 'Ventas', 'receipt'], ['/cash', 'Caja', 'wallet'], ['/orders', 'Pedidos en línea', 'bag'], ['/workorders', 'Impresiones', 'print']] },
  { group: 'Dinero', items: [['/finanzas', 'Dinero y gastos', 'transfer'], ['/reports', 'Reportes', 'receipt']] },
  { group: 'Inventario', items: [['/products', 'Productos e inventario', 'box'], ['/inventory', 'Conteo de inventario', 'camera'], ['/purchases', 'Compras', 'truck'], ['/suppliers', 'Proveedores', 'factory']] },
  { group: 'Gestión', items: [['/customers', 'Clientes y crédito', 'users'], ['/accounting', 'Contabilidad', 'book'], ['/automation', 'Automatización', 'bolt'], ['/prompts', 'Asistente con IA', 'sparkle'], ['/settings', 'Configuración', 'gear']] },
]
// Accesos de la barra inferior en teléfono, por prioridad (los que el rol pueda ver).
const SHORT: Record<string, string> = { '/admin': 'Inicio', '/pos': 'Vender', '/orders': 'Pedidos', '/products': 'Productos', '/purchases': 'Compras', '/sales': 'Ventas', '/cash': 'Caja', '/customers': 'Clientes' }
const BOTTOM_PRIORITY = ['/admin', '/pos', '/orders', '/products', '/purchases', '/sales', '/cash', '/customers']

const PAGES: [string, React.ReactElement][] = [
  ['/pos', <Pos />], ['/sales', <Sales />], ['/products', <Products />], ['/purchases', <Purchases />], ['/suppliers', <Suppliers />],
  ['/customers', <Customers />], ['/cash', <Cash />], ['/workorders', <WorkOrders />], ['/orders', <Orders />],
  ['/accounting', <Accounting />], ['/finanzas', <Finance />], ['/reports', <Reports />], ['/inventory', <Inventory />], ['/automation', <Automation />], ['/prompts', <Prompts />], ['/settings', <Settings />],
]

function Login() {
  const { login, toast } = useApp()
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="login">
      <form className="card" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await login(u, p) } catch (er: any) { toast(er.message, true) } finally { setBusy(false) } }}>
        <div className="logo logo-login"><LogoMark size={56} /><span><small>Librería</small>Samantha</span></div>
        <p className="muted" style={{ margin: 0 }}>Acceso para usuarios del sistema y administradores.</p>
        <label>Usuario<input value={u} onChange={(e) => setU(e.target.value)} autoFocus autoCapitalize="none" autoComplete="username" /></label>
        <label>Contraseña<input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" /></label>
        <button className="primary" disabled={busy || !u || !p}>{busy ? 'Ingresando…' : 'Ingresar'}</button>
        <NavLink to="/tienda" className="login-back">← Volver a la tienda</NavLink>
      </form>
    </div>
  )
}

// En pantallas chicas las tablas se muestran como fichas: cada celda toma su rótulo de la cabecera y su papel
// (título, miniatura, casilla, acciones). Las barras de filtros largas se pliegan detrás de un botón.
function useResponsiveTables() {
  const { pathname } = useLocation()
  useEffect(() => {
    const mark = (el: Element, attr: string, on: boolean) => { if (on !== el.hasAttribute(attr)) on ? el.setAttribute(attr, '') : el.removeAttribute(attr) }
    const label = () => {
      document.querySelectorAll('.main table').forEach((t) => {
        const heads = [...t.querySelectorAll('thead th')].map((h) => h.textContent?.replace(/[▲▼]/g, '').trim() ?? '')
        t.querySelectorAll('tbody tr').forEach((tr) => {
          const cells = [...tr.children]
          const title = cells.find((_, i) => heads[i])
          cells.forEach((td, i) => {
            if (td.hasAttribute('colspan')) return
            if (heads[i] && td.getAttribute('data-label') !== heads[i]) td.setAttribute('data-label', heads[i])
            const only = td.children.length === 1 && !td.textContent?.trim() ? td.firstElementChild : null
            mark(td, 'data-title', td === title)
            mark(td, 'data-check', !heads[i] && !!only?.matches('input[type=checkbox]'))
            mark(td, 'data-media', !heads[i] && !!only?.matches('img, .thumb'))
            mark(td, 'data-actions', !heads[i] && i === cells.length - 1 && !!td.querySelector('button, a'))
            mark(td, 'data-wide', !!heads[i] && td !== title && (td.textContent?.length ?? 0) > 42)
          })
        })
      })
      document.querySelectorAll('.main .toolbar').forEach((tb) => {
        const more = tb.querySelector(':scope > .toolbar-more')
        const many = tb.children.length - (more ? 1 : 0) > 3
        mark(tb, 'data-filters', many)
        tb.classList.toggle('has-more', many)
        if (many && !more) {
          const b = document.createElement('button')
          b.type = 'button'; b.className = 'toolbar-more'; b.textContent = 'Más filtros'
          b.onclick = () => { const open = tb.classList.toggle('open'); b.textContent = open ? 'Ocultar filtros' : 'Más filtros' }
          tb.appendChild(b)
        }
      })
    }
    label()
    let queued = false
    const obs = new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; label() }) })
    const main = document.querySelector('.main')
    if (main) obs.observe(main, { childList: true, subtree: true })
    return () => obs.disconnect()
  }, [pathname])
}

function Shell() {
  const { user, logout } = useApp()
  const online = useOnline()
  const install = useInstall()
  const { pathname } = useLocation()
  const [sheet, setSheet] = useState(false)
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('samantha.nav') === '1' } catch { return false } })
  const toggleNav = () => setCollapsed((c) => { try { localStorage.setItem('samantha.nav', c ? '0' : '1') } catch { /* sin almacenamiento */ } return !c })
  const [profile, setProfile] = useState<any>(null)
  useResponsiveTables()
  useEffect(() => { setSheet(false); window.scrollTo(0, 0) }, [pathname])
  useEffect(() => { document.title = user ? 'Gestión — Librería Samantha' : 'Ingresar — Librería Samantha' }, [user])
  useEffect(() => {
    if (!user) return
    const load = () => api('/me/profile').then(setProfile).catch(() => {})
    load(); window.addEventListener('profile-updated', load)
    return () => window.removeEventListener('profile-updated', load)
  }, [user?.id])

  const groups = useMemo(() => user ? NAV.map((g) => ({ ...g, items: g.items.filter(([to]) => canSee[to].includes(user.role)) })).filter((g) => g.items.length) : [], [user])
  if (!user) return <Login />
  const all = groups.flatMap((g) => g.items)
  const home = all[0]?.[0] ?? '/products'
  const bottom = BOTTOM_PRIORITY.map((p) => all.find(([to]) => to === p)).filter(Boolean).slice(0, 4) as Item[]
  const current = pathname === '/profile' ? (['/profile', 'Mi perfil', 'users'] as Item) : all.find(([to]) => pathname === to || pathname.startsWith(to + '/'))

  return (
    <div className={'shell' + (collapsed ? ' collapsed' : '')}>
      <nav className="side" aria-label="Principal">
        <div className="logo"><LogoMark size={42} /><span><small>Librería</small>Samantha</span><button className="nav-toggle" onClick={toggleNav} aria-label={collapsed ? 'Expandir el menú' : 'Minimizar el menú'} title={collapsed ? 'Expandir menú' : 'Minimizar menú'}>{collapsed ? '»' : '«'}</button></div>
        {groups.map((g) => (
          <div key={g.group || 'top'}>
            {g.group && <div className="group">{g.group}</div>}
            {g.items.map(([to, label, icon]) => <NavLink key={to} to={to} end={to === '/'} title={label}><Icon name={icon} size={20} /><span>{label}</span></NavLink>)}
          </div>
        ))}
        <div className="foot">
          {install.canInstall && <button onClick={install.prompt} className="install"><Icon name="download" size={18} /><span>Instalar app</span></button>}
          <div className="who"><b>{user.name}</b><span>{user.role}</span></div>
          <a href="#" onClick={(e) => { e.preventDefault(); logout() }} title="Salir"><Icon name="logout" size={18} /><span>Salir</span></a>
        </div>
      </nav>

      <header className="topbar">
        <div className="logo" style={{ padding: 0 }}><LogoMark size={34} /></div>
        <h1>{current?.[1] ?? 'Samantha'}</h1>
        <ThemePicker />
        {install.canInstall && <button className="icon-btn" onClick={install.prompt} aria-label="Instalar app"><Icon name="download" /></button>}
        <Bell />
        <UserMenu profile={profile ?? user} onLogout={logout} />
      </header>

      {!online && <div className="offline" role="status"><Icon name="wifioff" size={16} /> Sin conexión. Podés mirar lo ya cargado; las ventas y cambios necesitan internet.</div>}

      <main className="main">
        <Routes>
          <Route path="/admin" element={canSee['/admin'].includes(user.role) ? <Dashboard /> : <Navigate to={home} />} />
          {PAGES.map(([path, el]) => <Route key={path} path={path} element={canSee[path].includes(user.role) ? el : <Navigate to={home} />} />)}
          <Route path="/reports/:id" element={canSee['/reports'].includes(user.role) ? <Reports /> : <Navigate to={home} />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<Navigate to={home} />} />
        </Routes>
      </main>

      <nav className="bottombar" aria-label="Accesos rápidos">
        {bottom.map(([to, label, icon]) => <NavLink key={to} to={to} end={to === '/'}><Icon name={icon} /><span>{SHORT[to] ?? label.split(' ')[0]}</span></NavLink>)}
        <button onClick={() => setSheet(true)} aria-haspopup="dialog"><Icon name="menu" /><span>Más</span></button>
      </nav>

      {sheet && (
        <div className="sheet-backdrop" onClick={() => setSheet(false)}>
          <div className="sheet" role="dialog" aria-label="Menú" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head"><Avatar src={profile?.avatar} name={user.name} /><div><b>{profile?.name ?? user.name}</b><div className="muted">{user.role}</div></div><button className="icon-btn" onClick={() => setSheet(false)} aria-label="Cerrar"><Icon name="close" /></button></div>
            {groups.map((g) => (
              <div key={g.group || 'top'}>
                {g.group && <div className="group">{g.group}</div>}
                <div className="sheet-grid">{g.items.map(([to, label, icon]) => <NavLink key={to} to={to} end={to === '/'}><Icon name={icon} /><span>{label}</span></NavLink>)}</div>
              </div>
            ))}
            <div className="row" style={{ marginTop: 14 }}>
              <NavLink to="/profile" className="btn" style={{ textDecoration: 'none' }}>Mi perfil</NavLink>
              <button onClick={() => { setSheet(false); window.open('/tienda', '_blank') }}>Ver la tienda</button>
              <button className="danger" onClick={logout}>Salir</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <InstallProvider>
        <AppProvider><AskProvider>
          <Routes>
            <Route path="/escanear/:token" element={<ScanPhone />} />
            <Route path="/" element={<Navigate to="/tienda" replace />} />
            <Route path="/tienda/*" element={<Store />} />
            <Route path="/pay/:ref" element={<PayPage />} />
            <Route path="*" element={<Shell />} />
          </Routes>
        </AskProvider></AppProvider>
      </InstallProvider>
    </BrowserRouter>
  </StrictMode>,
)
