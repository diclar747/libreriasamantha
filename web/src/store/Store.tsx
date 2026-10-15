import { LogoMark } from '../components/Logo'
import type React from 'react'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { gs, useApp } from '../api'
import { Icon } from '../components/Icons'
import ThemePicker from '../components/ThemePicker'
import './store.css'
import { AccountArea, CustomerProvider, ForgotPage, LoginPage, RegisterPage, ResetPage, VerifyPage, cust, uid, useCustomer } from './Account'

async function shop<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api/shop' + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`)
  return data
}

interface CartItem { id: number; name: string; price: number; qty: number; max: number; list?: number | null; image?: string | null }
// Cada categoría tiene su color e ícono (trazo de 24 px).
const CAT_ART: Record<string, { d: string; c: [string, string] }> = {
  'Biblias': { d: 'M4 5.5C4 4.7 4.7 4 5.5 4H11v15H5.5C4.7 19 4 18.3 4 17.5v-12zM20 5.5C20 4.7 19.3 4 18.5 4H13v15h5.5c.8 0 1.5-.7 1.5-1.5v-12z', c: ['#2f3aa8', '#4f5fe0'] },
  'Devocionales': { d: 'M12 4v2M5.6 7.6L7 9M18.4 7.6L17 9M3 15h18M7 15a5 5 0 0 1 10 0M5 19h14', c: ['#3b46c4', '#6a78ee'] },
  'Niños': { d: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM8.5 14c.9 1.4 2.1 2 3.5 2s2.6-.6 3.5-2M9 10h.01M15 10h.01', c: ['#13808f', '#35a9b8'] },
  'Adolescentes': { d: 'M13 3L5 13h6l-1 8 8-10h-6l1-8z', c: ['#5b45c0', '#8b78e8'] },
  'Jóvenes': { d: 'M3 19l6-10 4 6 2-3 6 7H3z', c: ['#2a62c4', '#4a8ae8'] },
  'Mujeres': { d: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z', c: ['#7448b4', '#a07fd8'] },
  'Hombres': { d: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z', c: ['#1f3a8a', '#3b5fc4'] },
  'Matrimonios': { d: 'M9 8a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM15 8a5 5 0 1 0 0 10 5 5 0 0 0 0-10z', c: ['#5a4bb8', '#8a7fe0'] },
  'Agendas': { d: 'M5 6h14v14H5zM5 10h14M9 3v4M15 3v4', c: ['#177b94', '#3aa6c0'] },
  'Libros': { d: 'M5 4h10a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4zM7 18h10', c: ['#3440b8', '#5b6fe6'] },
  'Regalos': { d: 'M4 10h16v10H4zM3 7h18v3H3zM12 7v13M12 7c-2 0-4-.5-4-2.2S10 3 12 7zM12 7c2 0 4-.5 4-2.2S14 3 12 7z', c: ['#6a48b8', '#9a82e0'] },
  'Útiles escolares': { d: 'M4 20l1-4L16 5l3 3L8 19l-4 1zM14 7l3 3', c: ['#14806c', '#34a890'] },
  'Oficina': { d: 'M4 8h16v11H4zM9 8V5h6v3M4 13h16', c: ['#475569', '#64748b'] },
}
const catArt = (name: string) => CAT_ART[name] ?? CAT_ART['Libros']

const visualCategory = (category?: string) => category === 'Oficina' ? 'office' : category === 'Útiles escolares' ? 'school' : 'books'
const CartCtx = createContext<{ open: boolean; setOpen(o: boolean): void; items: CartItem[]; add(p: any, qty?: number): void; setQty(id: number, q: number): void; clear(): void; total: number; count: number }>(null as never)
const useCart = () => useContext(CartCtx)

function CartProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<CartItem[]>(() => { try { return JSON.parse(localStorage.getItem('samantha.cart') ?? '[]') } catch { return [] } })
  useEffect(() => { try { localStorage.setItem('samantha.cart', JSON.stringify(items)) } catch { /* modo privado */ } }, [items])
  const value = useMemo(() => ({
    open, setOpen, items,
    add: (p: any, qty = 1) => { setOpen(true); setItems((c) => {
      const ex = c.find((i) => i.id === p.id)
      const max = 99
      if (ex) return c.map((i) => (i.id === p.id ? { ...i, qty: Math.min(i.qty + qty, max) } : i))
      return [...c, { id: p.id, name: p.name, price: Number(p.price), qty: Math.min(qty, max), max, list: p.list_price ?? null, image: p.image_url ?? null }]
    }) },
    setQty: (id: number, q: number) => setItems((c) => (q <= 0 ? c.filter((i) => i.id !== id) : c.map((i) => (i.id === id ? { ...i, qty: Math.min(q, i.max) } : i)))),
    clear: () => setItems([]),
    total: items.reduce((s, i) => s + i.price * i.qty, 0),
    count: items.reduce((s, i) => s + i.qty, 0),
  }), [items, open])
  return <CartCtx.Provider value={value}>{children}<CartDrawer /></CartCtx.Provider>
}

function CartDrawer() {
  const { open, setOpen, items, setQty, total, count } = useCart()
  const nav = useNavigate()
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', k)
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = '' }
  }, [open])
  return (
    <div className={'cart-drawer-wrap' + (open ? ' open' : '')} aria-hidden={!open}>
      <div className="cart-backdrop" onClick={() => setOpen(false)} />
      <aside className="cart-drawer" role="dialog" aria-label="Tu carrito">
        <header><div><span className="cart-kicker">TU COMPRA</span><h2>Carrito {count > 0 && <span className="cart-count">{count}</span>}</h2></div><button className="cart-close" onClick={() => setOpen(false)} aria-label="Cerrar carrito">×</button></header>
        <div className="cart-body">
          {!items.length && <div className="cart-empty"><span>🛍</span><b>Tu carrito está vacío</b><p>Sumá productos y aparecen acá.</p><button onClick={() => { setOpen(false); nav('/tienda') }}>Explorar productos</button></div>}
          {items.map((i) => (
            <div className="cart-line" key={i.id}>
              <div className="cart-thumb">{i.image ? <img src={i.image} alt="" /> : <span>{i.name.slice(0, 1)}</span>}</div>
              <div className="cart-info"><b>{i.name}</b><small>{gs(i.price)} c/u{i.list && i.list > i.price ? <s> {gs(i.list)}</s> : null}</small>
                <div className="cart-step"><button onClick={() => setQty(i.id, i.qty - 1)} aria-label="Restar">−</button><span>{i.qty}</span><button onClick={() => setQty(i.id, i.qty + 1)} aria-label="Sumar">+</button></div></div>
              <div className="cart-end"><b>{gs(i.price * i.qty)}</b><button onClick={() => setQty(i.id, 0)} aria-label={'Quitar ' + i.name}>Quitar</button></div>
            </div>
          ))}
        </div>
        {items.length > 0 && <footer>
          <div className="cart-total"><span>Subtotal</span><strong>{gs(total)}</strong></div>
          <small>El envío y los descuentos se calculan al finalizar.</small>
          <button className="primary" onClick={() => { setOpen(false); nav('/tienda/checkout') }}>Finalizar compra</button>
          <button onClick={() => setOpen(false)}>Seguir comprando</button>
        </footer>}
      </aside>
    </div>
  )
}

// Íconos de trazo (24 px) del encabezado, los beneficios y los botones.
const SF: Record<string, string> = {
  truck: 'M3 7h11v9H3zM14 10h4l3 3v3h-7M7 19.5a1.5 1.5 0 1 0 0-.01M17 19.5a1.5 1.5 0 1 0 0-.01',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
  shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3zM9 12l2 2 4-4',
  headset: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v5H5a1 1 0 0 1-1-1v-4zM20 14h-3v5h2a1 1 0 0 0 1-1v-4zM17 19c0 1.5-2 2-5 2',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.5-6 8-6s8 2 8 6',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  bag: 'M5 8h14l-1 12H6L5 8zM9 8a3 3 0 0 1 6 0',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  tag: 'M3 12V4h8l10 10-8 8L3 12zM7.5 8h.01',
  chat: 'M4 20l1.3-4A8 8 0 1 1 8.2 18.7L4 20z',
  insta: 'M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM17.5 6.5h.01',
  arrow: 'M5 12h14M13 6l6 6-6 6',
}
function SfIcon({ n, size = 22 }: { n: string; size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={SF[n] ?? SF.bag} /></svg>
}
const CAT_SUB: Record<string, string> = {
  'Biblias': 'Para toda la familia', 'Devocionales': 'Tu tiempo con Dios', 'Niños': 'Libros y recursos', 'Adolescentes': 'Fe para esta etapa', 'Jóvenes': 'Crecer en fe',
  'Mujeres': 'Palabra y encuentro', 'Hombres': 'Fe y propósito', 'Matrimonios': 'Fortalecé tu hogar', 'Agendas': 'Organizá tu año', 'Libros': 'Autores cristianos',
  'Regalos': 'Detalles con propósito', 'Útiles escolares': 'Para el colegio', 'Oficina': 'Papelería y más',
}
const INSTAGRAM = 'https://www.instagram.com/samanthalatienda/'
// Catálogo completo en memoria (se refresca cada minuto): lo usan el encabezado y el inicio.
let allCache: { at: number; p: Promise<any[]> } | null = null
const loadAll = () => {
  if (!allCache || Date.now() - allCache.at > 60_000) allCache = { at: Date.now(), p: shop('/products').catch(() => { allCache = null; return [] as any[] }) }
  return allCache.p
}
/** La tienda tiene su propia paleta: se activa con una clase en <html> para que también la tomen el carrito y los diálogos. */
function useStorefront() {
  useEffect(() => { document.documentElement.classList.add('storefront'); return () => document.documentElement.classList.remove('storefront') }, [])
}

function useSeo(title: string, description: string) {
  useEffect(() => {
    document.title = title
    let m = document.querySelector('meta[name=description]') as HTMLMetaElement | null
    if (!m) { m = document.createElement('meta'); m.name = 'description'; document.head.appendChild(m) }
    m.content = description
  }, [title, description])
}

function Layout({ children }: { children: ReactNode }) {
  useStorefront()
  const { count, setOpen } = useCart()
  const { profile } = useCustomer()
  const nav = useNavigate()
  const loc = useLocation()
  const [sp] = useSearchParams()
  const [info, setInfo] = useState<any>(null)
  const [cats, setCats] = useState<any[]>([])
  const [all, setAll] = useState<any[]>([])
  const [term, setTerm] = useState('')
  useEffect(() => { shop('/info').then(setInfo).catch(() => {}); shop('/categories').then(setCats).catch(() => {}); loadAll().then(setAll) }, [])
  useEffect(() => { setTerm(sp.get('q') ?? '') }, [sp])
  const wa = info?.whatsapp?.replace(/\D/g, '')
  const isHome = loc.pathname.replace(/\/$/, '') === '/tienda'
  const curCat = isHome ? sp.get('cat') ?? '' : ''
  const filtered = isHome && (sp.get('cat') || sp.get('q') || sp.get('oferta'))
  const hasOffers = all.some((p) => p.on_offer)
  const account = profile ? '/tienda/cuenta' : '/tienda/ingresar'
  return (
    <div className="st">
      <div className="sf-util"><span><SfIcon n="truck" size={17} /> Envíos a todo Paraguay</span>
        <nav aria-label="Más">
          <Link to="/tienda/listas">Listas escolares</Link><Link to="/tienda/impresiones">Impresiones</Link><Link to={profile ? '/tienda/cuenta/pedidos' : '/tienda/pedido'}>Mis pedidos</Link>
          {wa && <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" aria-label="WhatsApp" className="sf-soc"><SfIcon n="chat" size={18} /></a>}
          <a href={INSTAGRAM} target="_blank" rel="noreferrer" aria-label="Instagram" className="sf-soc"><SfIcon n="insta" size={18} /></a>
        </nav>
      </div>
      <header className="sf-head">
        <Link to="/tienda" className="sf-logo" aria-label="Librería Samantha, inicio"><LogoMark size={52} /><span><strong>Samantha</strong><small>Librería cristiana</small></span></Link>
        <form className="sf-search" role="search" onSubmit={(e) => { e.preventDefault(); nav(term.trim() ? `/tienda?q=${encodeURIComponent(term.trim())}` : '/tienda') }}>
          <input aria-label="Buscar productos" placeholder="Buscar libros, Biblias, autores…" value={term} onChange={(e) => setTerm(e.target.value)} />
          <button aria-label="Buscar"><SfIcon n="search" size={20} /></button>
        </form>
        <div className="sf-actions">
          <Link to={account} className="sf-act"><SfIcon n="user" size={26} /><span>{profile ? profile.firstName : 'Mi cuenta'}</span>{profile?.unread > 0 && <b className="sf-dot">{profile.unread}</b>}</Link>
          <Link to={profile ? '/tienda/cuenta/favoritos' : '/tienda/ingresar'} className="sf-act"><SfIcon n="heart" size={26} /><span>Favoritos</span></Link>
          <button className="sf-act sf-cart" onClick={() => setOpen(true)} aria-label={`Carrito, ${count} productos`}><SfIcon n="bag" size={26} /><span>Carrito</span><b className="sf-dot">{count}</b></button>
        </div>
      </header>
      <nav className="sf-nav" aria-label="Categorías">
        <Link to="/tienda" className={'sf-nl' + (isHome && !filtered ? ' on' : '')}>Inicio</Link>
        {cats.filter((c) => c.category !== 'Servicios').map((c) => <Link key={c.category} to={`/tienda?cat=${encodeURIComponent(c.category)}`} className={'sf-nl' + (curCat === c.category ? ' on' : '')}>{c.category}</Link>)}
        {hasOffers && <Link to="/tienda?oferta=1" className={'sf-nl sf-offers' + (isHome && sp.get('oferta') ? ' on' : '')}><SfIcon n="tag" size={16} /> Ofertas</Link>}
      </nav>
      <main className={'st-main' + (isHome ? ' sf-full' : '')}>{children}</main>
      <nav className="st-bottom" aria-label="Tienda">
        <NavLink to="/tienda" end>Productos</NavLink>
        <NavLink to="/tienda/listas">Listas</NavLink>
        <NavLink to="/tienda/impresiones">Impresiones</NavLink>
        <NavLink to={account}>{profile ? 'Mi cuenta' : 'Ingresar'}</NavLink>
        <button className="st-bottom-cart" onClick={() => setOpen(true)}>Carrito{count > 0 && <b>{count}</b>}</button>
      </nav>
      <footer className="st-foot">
        <div className="st-foot-brand"><LogoMark size={52} className="st-foot-mark" /><div><b>{info?.name ?? 'Librería Samantha'}</b><p>Biblias, devocionales y libros para acompañar tu camino de fe. Envíos a todo el país.</p></div></div>
        <div><b>Tu compra</b><Link to="/tienda">Explorar productos</Link><Link to="/tienda/pedido">Seguir mi pedido</Link><Link to="/tienda/listas">Listas escolares</Link>{profile ? <Link to="/tienda/cuenta">Mi cuenta</Link> : <Link to="/tienda/registro">Crear mi cuenta</Link>}<Link to="/admin">Acceso del personal</Link></div>
        <div><b>Contacto</b>{info?.address && <span>{info.address}</span>}{info?.hours && <span>{info.hours}</span>}{wa && <a href={`https://wa.me/${wa}?text=${encodeURIComponent('Hola, quiero consultar por un producto')}`} target="_blank" rel="noreferrer">Escribinos por WhatsApp</a>}<a href={INSTAGRAM} target="_blank" rel="noreferrer">Seguinos en Instagram</a></div>
      </footer>
      <ChatWidget />
    </div>
  )
}

function FavButton({ id }: { id: number }) {
  const { favs, toggleFav } = useCustomer()
  const nav = useNavigate()
  const on = favs.includes(id)
  return <button className="st-fav" aria-label={on ? 'Quitar de favoritos' : 'Guardar en favoritos'} title={on ? 'Quitar de favoritos' : 'Guardar en favoritos'} onClick={async (e) => { e.preventDefault(); try { await toggleFav(id) } catch (er: any) { if (er.message === 'login') nav('/tienda/ingresar?next=' + encodeURIComponent(location.pathname)) } }}>{on ? '♥' : '♡'}</button>
}

function ProductCard({ p }: { p: any }) {
  const { add } = useCart()
  const out = p.availability === 'out'
  return (
    <div className="st-card">
      <FavButton id={p.id} />
      <Link to={`/tienda/producto/${p.id}`} className={`st-img visual-${visualCategory(p.category)}`}>{p.image_url ? <img src={p.image_url} alt={p.name} loading="lazy" /> : <span>{p.name.slice(0, 1)}</span>}</Link>
      <span className="st-category">{p.category || 'Librería'}</span>
      <Link to={`/tienda/producto/${p.id}`} className="st-name">{p.name}</Link>
      {p.author && <div className="muted">{p.author}</div>}
      <div className="st-price"><span>{gs(p.price)}</span>{p.on_offer && <s className="muted" style={{ marginLeft: 8, fontSize: 13 }}>{gs(p.list_price)}</s>}</div>
      {p.on_offer && <span className="pill ok">{p.offer_label} · −{p.saving_pct}%</span>}{p.availability === 'low' && <span className="pill warn">Quedan pocas unidades</span>}
      {out ? <span className="pill bad">Agotado</span> : <button className="primary sf-add" onClick={() => add(p)}><SfIcon n="bag" size={17} /> Agregar al carrito</button>}
    </div>
  )
}

function Home() {
  useSeo('Librería Samantha — Biblias, devocionales y libros cristianos', 'Biblias, devocionales, libros para niños, mujeres, hombres y matrimonios. Comprá en línea con envíos a todo Paraguay.')
  const [sp] = useSearchParams()
  const q = sp.get('q') ?? ''
  const cat = sp.get('cat') ?? ''
  const onlyOffers = sp.get('oferta') === '1'
  const filtered = !!(q || cat || onlyOffers)
  const [cats, setCats] = useState<any[]>([])
  const [all, setAll] = useState<any[]>([])
  const [rows, setRows] = useState<any[]>([])
  const [info, setInfo] = useState<any>(null)
  const [more, setMore] = useState(false)
  useEffect(() => { shop('/categories').then(setCats).catch(() => {}); shop('/info').then(setInfo).catch(() => {}); loadAll().then(setAll) }, [])
  useEffect(() => {
    if (!q && !cat) { setRows(all); return }
    const t = setTimeout(() => shop(`/products?q=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}`).then(setRows).catch(() => {}), 150)
    return () => clearTimeout(t)
  }, [q, cat, all])
  useEffect(() => { if (filtered) document.getElementById('catalogo')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, [q, cat, onlyOffers])
  const list = onlyOffers ? all.filter((p) => p.on_offer) : rows
  const shown = !filtered && !more ? list.slice(0, 10) : list
  const title = onlyOffers ? 'Ofertas' : cat ? cat : q ? `Resultados para “${q}”` : 'Productos destacados'
  const thumb = (c: string) => all.find((p) => p.category === c && p.image_url)?.image_url as string | undefined
  const wa = info?.whatsapp?.replace(/\D/g, '')
  const visibleCats = cats.filter((c) => c.category !== 'Servicios')
  return (
    <>
      {!filtered && <section className="sf-hero">
        <div className="sf-wrap sf-hero-in">
          <div className="sf-hero-copy">
            <span className="sf-kicker">Biblias, libros y recursos para</span>
            <h1>Crecer en tu fe cada día</h1>
            <p>Encontrá todo lo que necesitás para tu vida espiritual y la de tu familia.</p>
            <a href="#catalogo" className="sf-btn" onClick={(e) => { e.preventDefault(); document.getElementById('catalogo')?.scrollIntoView({ behavior: 'smooth' }) }}>Ver productos <SfIcon n="arrow" size={18} /></a>
          </div>
          <div className="sf-hero-art"><img src="/images/hero-cristiano.png" alt="Biblia abierta, libros y una cruz con ramas de olivo" /></div>
        </div>
      </section>}

      <section className="sf-wrap sf-circles" aria-label="Categorías">
        <div className="sf-circle-row">
          {visibleCats.map((c) => { const t = thumb(c.category); const a = catArt(c.category); return (
            <Link key={c.category} to={`/tienda?cat=${encodeURIComponent(c.category)}`} className={'sf-circle' + (cat === c.category ? ' on' : '')}>
              <span className="sf-circle-img">{t ? <img src={t.replace('s=md', 's=thumb')} alt="" loading="lazy" /> : <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={a.d} /></svg>}</span>
              <b>{c.category}</b><small>{CAT_SUB[c.category] ?? `${c.count} productos`}</small>
            </Link>) })}
        </div>
      </section>

      <section className="sf-wrap sf-products" id="catalogo">
        <div className="sf-sec-head"><h2>{title}</h2>{(filtered || list.length > 10) && (filtered ? <Link to="/tienda" className="sf-link">Ver todo el catálogo ›</Link> : <button className="sf-link" onClick={() => setMore(!more)}>{more ? 'Ver menos' : 'Ver todos'} ›</button>)}</div>
        <div className="st-grid sf-grid">{shown.map((p) => <ProductCard key={p.id} p={p} />)}</div>
        {!shown.length && <p className="muted sf-empty">No encontramos productos con ese criterio. Probá con otra palabra o elegí una categoría.</p>}
      </section>

      {!filtered && <section className="sf-wrap sf-banners">
        <div className="sf-banner sf-banner-photo"><div><h3>Todo lo puedo en Cristo que me fortalece</h3><span>Filipenses 4:13</span></div></div>
        <div className="sf-banner sf-banner-green"><div><h3>Devocionales para cada etapa de tu vida</h3><Link to="/tienda?cat=Devocionales" className="sf-btn sf-btn-forest">Ver colección</Link></div><img src="/images/hero-cristiano.png" alt="" loading="lazy" /></div>
      </section>}

      {!filtered && <section className="sf-wrap sf-benefits">
        <div><SfIcon n="truck" size={38} /><span><b>Envíos a todo Paraguay</b><small>Rápidos y seguros</small></span></div>
        <div><SfIcon n="card" size={38} /><span><b>Varios medios de pago</b><small>Tarjeta, transferencia y más</small></span></div>
        <div><SfIcon n="shield" size={38} /><span><b>Compra segura</b><small>Tus datos protegidos</small></span></div>
        <div><SfIcon n="headset" size={38} /><span><b>Atención personalizada</b><small>Estamos para ayudarte</small></span></div>
      </section>}

      {wa && <section className="sf-band"><div className="sf-wrap sf-band-in">
        <div><h3>¿Buscás algo en particular?</h3><p>Escribinos por WhatsApp y te ayudamos a elegir: Biblias, devocionales, regalos y más.</p></div>
        <a className="sf-btn" href={`https://wa.me/${wa}?text=${encodeURIComponent('Hola, quiero consultar por un producto')}`} target="_blank" rel="noreferrer"><SfIcon n="chat" size={18} /> Escribir por WhatsApp</a>
      </div></section>}
    </>
  )
}
function ProductPage() {
  const { id } = useParams()
  const { add } = useCart()
  const [p, setP] = useState<any>(null)
  const [qty, setQty] = useState(1)
  const [img, setImg] = useState<number | null>(null)
  useEffect(() => { setP(null); setImg(null); shop('/products/' + id).then(setP).catch(() => setP(false)) }, [id])
  useSeo(p ? `${p.name} — Librería Samantha` : 'Producto — Librería Samantha', p ? (p.description || `${p.name} a ${gs(p.price)}. Retiro en local o delivery.`) : '')
  if (p === false) return <p>No encontramos este producto. <Link to="/tienda">Volver a la tienda</Link></p>
  if (!p) return <p className="muted">Cargando…</p>
  const out = p.availability === 'out'
  return (
    <>
      <p><Link to="/tienda">← Productos</Link></p>
      <div className="st-detail">
        <div><div className={`st-img big visual-${visualCategory(p.category)}`}>{(p.images?.[img ?? 0] ?? p.image_url) ? <img src={p.images?.[img ?? 0] ?? p.image_url} alt={p.name} /> : <span>{p.name.slice(0, 1)}</span>}</div>{p.images?.length > 1 && <div className="row" style={{ marginTop: 8 }}>{p.images.map((u: string, i: number) => <button key={u} onClick={() => setImg(i)} aria-label={`Ver imagen ${i + 1}`} style={{ padding: 0, width: 58, height: 58, borderRadius: 10, overflow: 'hidden', borderColor: (img ?? 0) === i ? 'var(--brand)' : undefined }}><img src={u.replace('s=full', 's=thumb')} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></button>)}</div>}</div>
        <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
          <h1>{p.name}</h1>
          <div className="muted">{[p.author, p.publisher, p.brand, p.category].filter(Boolean).join(' · ')}</div>
          <div className="st-price big">{gs(p.price)}{p.on_offer && <s className="muted" style={{ marginLeft: 10, fontSize: 18 }}>{gs(p.list_price)}</s>}</div>
          {p.on_offer && <span className="pill ok">{p.offer_label} · ahorrás {p.saving_pct}%</span>}
          {p.short_description && <p><b>{p.short_description}</b></p>}<p>{p.description}</p>{(p.edition || p.language || p.subcategory) && <p className="muted">{[p.subcategory, p.edition && 'Edición ' + p.edition, p.language].filter(Boolean).join(' · ')}</p>}
          {out ? <span className="pill bad">Agotado</span> : <>
            <span className={'pill ' + (p.availability === 'low' ? 'warn' : 'ok')}>{p.availability === 'low' ? 'Quedan pocas unidades' : 'Disponible'}</span>
            <div className="row"><input type="number" min={1} max={99} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} style={{ width: 90 }} /><button className="primary" onClick={() => add(p, qty)}>Agregar al carrito</button></div></>}
        </div>
      </div>
      {p.related?.length > 0 && <><h2 style={{ marginTop: 28 }}>También te puede interesar</h2><div className="st-grid">{p.related.map((r: any) => <ProductCard key={r.id} p={r} />)}</div></>}
    </>
  )
}

function CartPage() {
  const { items, setQty, total } = useCart()
  useSeo('Tu carrito — Librería Samantha', 'Revisá tu carrito')
  return (
    <>
      <h1>Tu carrito</h1>
      {!items.length ? <p className="muted">Está vacío. <Link to="/tienda">Ver productos</Link></p> : (
        <div className="card st-cart-page">
          {items.map((i) => (
            <div key={i.id} className="st-line st-cart-item"><span>{i.name}</span><input type="number" min={0} max={i.max} value={i.qty} onChange={(e) => setQty(i.id, Number(e.target.value))} style={{ width: 80 }} aria-label={`Cantidad de ${i.name}`} /><b>{gs(i.price * i.qty)}</b><button onClick={() => setQty(i.id, 0)} aria-label={`Quitar ${i.name}`}>×</button></div>
          ))}
          <div className="st-line"><b>Total productos</b><span /><b>{gs(total)}</b><span /></div>
          <Link to="/tienda/checkout"><button className="primary" style={{ marginTop: 12 }}>Continuar con la compra</button></Link>
        </div>
      )}
    </>
  )
}

function Checkout() {
  const { items, total, clear } = useCart()
  const { profile } = useCustomer()
  const nav = useNavigate()
  const [cities, setCities] = useState<any[]>([])
  const [opts, setOpts] = useState<any>(null)
  const [addrs, setAddrs] = useState<any[]>([])
  const [addrId, setAddrId] = useState<string>('')
  const [newAddr, setNewAddr] = useState(false)
  const [f, setF] = useState({ name: '', phone: '', email: '', ruc: '', billName: '', method: 'pickup', cityId: '', zone: '', address: '', reference: '', neighborhood: '', pay: 'bancard', coupon: '', recName: '', recPhone: '', other: false })
  const [quote, setQuote] = useState<any>(null)
  const [coupon, setCoupon] = useState<{ code: string; discount: number } | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [idem] = useState(() => uid())
  useSeo('Finalizar compra — Librería Samantha', 'Completá tus datos y pagá online')
  useEffect(() => { shop('/cities').then(setCities).catch(() => {}); shop('/payment-options').then(setOpts).catch(() => {}) }, [])
  // con cuenta, los datos se completan solos y se pueden revisar o cambiar antes de confirmar
  useEffect(() => {
    if (!profile) return
    setF((c) => ({ ...c, name: c.name || `${profile.firstName} ${profile.lastName}`, phone: c.phone || profile.whatsapp || profile.phone || '', email: c.email || profile.email, ruc: c.ruc || profile.billingDoc || profile.document || '', billName: c.billName || profile.billingName || '' }))
    cust('/addresses').then((a: any[]) => { setAddrs(a); const d = a.find((x) => x.isDefault) ?? a[0]; if (d) setAddrId(String(d.id)) }).catch(() => {})
  }, [profile?.id])
  const saved = addrs.find((a) => String(a.id) === addrId)
  const useSaved = f.method === 'delivery' && !!saved && !newAddr
  const cityId = useSaved ? String(saved.cityId ?? '') : f.cityId
  useEffect(() => {
    if (f.method !== 'delivery' || !cityId) { setQuote(null); return }
    shop('/delivery/quote?cityId=' + cityId + (f.zone ? '&zone=' + encodeURIComponent(f.zone) : '')).then(setQuote).catch(() => setQuote(null))
  }, [f.method, cityId, f.zone])
  const fee = f.method === 'delivery' && quote?.covered ? Number(quote.fee) : 0
  const discount = coupon?.discount ?? 0
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value })
  const covered = cities.filter((c) => c.covered)
  const addressText = useSaved ? `${saved.street} ${saved.houseNumber ?? ''}`.trim() : f.address
  const deliveryOk = f.method === 'pickup' || (quote?.covered && addressText.trim().length >= 5)
  const rec = useSaved ? { name: saved.recipientName, phone: saved.recipientPhone } : { name: f.other ? f.recName : null, phone: f.other ? f.recPhone : null }

  async function applyCoupon() {
    try { const c = await shop('/coupons/validate', { code: f.coupon, subtotal: total }); setCoupon(c); setErr('') } catch (e: any) { setCoupon(null); setErr(e.message) }
  }
  async function submit() {
    setBusy(true); setErr('')
    const body = {
      customer: { name: f.name, phone: f.phone, email: f.email || null, ruc: f.ruc || null },
      items: items.map((i) => ({ productId: i.id, qty: i.qty })),
      delivery: { method: f.method, cityId: f.method === 'delivery' ? Number(cityId) : null, zone: f.zone || null, address: addressText || null, reference: (useSaved ? saved.reference : f.reference) || null, neighborhood: (useSaved ? saved.neighborhood : f.neighborhood) || null },
      paymentMethod: f.pay, couponCode: coupon?.code ?? null, billing: f.billName || f.ruc ? { name: f.billName || null, ruc: f.ruc || null } : undefined,
      recipient: rec.name ? rec : undefined, idempotencyKey: idem,
    }
    try {
      const r = profile ? await cust('/orders', { body }) : await shop('/orders', body)
      localStorage.setItem('samantha.last-order', JSON.stringify({ number: r.order.number, token: r.order.lookup_token }))
      clear()
      const to = profile ? `/tienda/cuenta/pedidos/${r.order.number}` : `/tienda/pedido/${r.order.number}?token=${r.order.lookup_token}`
      if (f.pay === 'bancard' && r.payment) window.location.href = r.payment.url; else nav(to)
    } catch (e: any) { setErr(e.message); setBusy(false) }
  }
  if (!items.length) return <p className="muted">Tu carrito está vacío. <Link to="/tienda">Ver productos</Link></p>
  return (
    <div className="st-checkout">
      <div className="card" style={{ display: 'grid', gap: 12 }}>
        <h1>Finalizar compra</h1>
        {!profile && <div className="acc-banner">¿Ya tenés cuenta? <Link to="/tienda/ingresar?next=/tienda/checkout">Ingresá</Link> o <Link to="/tienda/registro?next=/tienda/checkout">creá una</Link> para guardar tus datos y seguir tus pedidos. Tu carrito se conserva. También podés comprar sin cuenta.</div>}
        {profile && <div className="acc-banner ok">Comprás como <b>{profile.firstName} {profile.lastName}</b>. Revisá tus datos antes de confirmar.</div>}
        <div className="form">
          <label>Nombre y apellido<input value={f.name} onChange={set('name')} /></label>
          <label>Teléfono / WhatsApp<input value={f.phone} onChange={set('phone')} placeholder="+595…" /></label>
          <label>Correo {profile ? '' : '(opcional)'}<input value={f.email} onChange={set('email')} /></label>
          <label>RUC o CI para la factura (opcional)<input value={f.ruc} onChange={set('ruc')} /></label>
          {f.ruc && <label>Nombre o razón social en la factura<input value={f.billName} onChange={set('billName')} /></label>}
        </div>
        <label>Entrega<select value={f.method} onChange={set('method')}><option value="pickup">Retiro en el local (gratis, sin dirección)</option><option value="delivery">Delivery a domicilio</option></select></label>
        {f.method === 'delivery' && profile && addrs.length > 0 && !newAddr && <div className="acc-stack-s"><b>Dirección de entrega</b>
          {addrs.map((a) => <label key={a.id} className="inline acc-bank" style={{ cursor: 'pointer' }}><input type="radio" style={{ width: 'auto' }} checked={String(a.id) === addrId} onChange={() => setAddrId(String(a.id))} /><span><b>{a.label || 'Dirección'}</b> · {a.street} {a.houseNumber}, {[a.neighborhood, a.cityName].filter(Boolean).join(', ')}{a.recipientName ? ` · recibe ${a.recipientName}` : ''}</span></label>)}
          <button className="small" onClick={() => setNewAddr(true)}>Usar otra dirección</button></div>}
        {f.method === 'delivery' && (!profile || !addrs.length || newAddr) && <div className="form">
          <label>Ciudad<select value={f.cityId} onChange={(e) => setF({ ...f, cityId: e.target.value, zone: '' })}><option value="">Elegir…</option>{covered.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.department}) — {gs(c.fee)}</option>)}</select></label>
          {quote?.specialZones?.length > 0 && <label>Barrio o zona<select value={f.zone} onChange={set('zone')}><option value="">Otro barrio</option>{quote.specialZones.map((z: any) => <option key={z.name} value={z.name}>{z.name} — {gs(z.fee)}</option>)}</select></label>}
          <label>Barrio<input value={f.neighborhood} onChange={set('neighborhood')} /></label>
          <label>Calle y número<input value={f.address} onChange={set('address')} placeholder="Calle, número de casa" /></label>
          <label>Referencia (opcional)<input value={f.reference} onChange={set('reference')} placeholder="Portón verde, frente a la plaza…" /></label>
          <label className="inline" style={{ gridColumn: '1 / -1' }}><input type="checkbox" style={{ width: 'auto' }} checked={f.other} onChange={(e) => setF({ ...f, other: e.target.checked })} /> Lo recibe otra persona</label>
          {f.other && <><label>Nombre de quien recibe<input value={f.recName} onChange={set('recName')} /></label><label>Teléfono de quien recibe<input value={f.recPhone} onChange={set('recPhone')} /></label></>}
          {newAddr && <button className="small" onClick={() => setNewAddr(false)}>Volver a mis direcciones</button>}
          <p className="muted" style={{ gridColumn: '1 / -1', margin: 0 }}>¿Tu ciudad no aparece? Todavía no llegamos: podés retirar en el local o escribirnos por WhatsApp.</p></div>}
        {f.method === 'delivery' && quote && <p className="muted" style={{ margin: 0 }}>Envío a {quote.city}: <b>{gs(quote.fee)}</b>{quote.eta ? ` · ${quote.eta}` : ''}{quote.notes ? ` · ${quote.notes}` : ''}</p>}
        <div><b>Forma de pago</b>
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            <label className="inline"><input type="radio" style={{ width: 'auto' }} checked={f.pay === 'bancard'} onChange={() => setF({ ...f, pay: 'bancard' })} /> Tarjeta de crédito o débito (pago seguro en línea){opts?.card?.demo ? <span className="pill warn">modo de prueba</span> : null}</label>
            {opts?.transfer?.enabled && <label className="inline"><input type="radio" style={{ width: 'auto' }} checked={f.pay === 'transfer'} onChange={() => setF({ ...f, pay: 'transfer' })} /> Transferencia bancaria (subís el comprobante y lo revisamos)</label>}
            {opts?.cod?.enabled && f.method === 'delivery' && <label className="inline"><input type="radio" style={{ width: 'auto' }} checked={f.pay === 'cod'} onChange={() => setF({ ...f, pay: 'cod' })} /> Pago contra entrega (efectivo al recibir)</label>}
          </div></div>
        <div className="row"><input placeholder="Cupón de descuento" value={f.coupon} onChange={set('coupon')} style={{ maxWidth: 220 }} /><button onClick={applyCoupon} disabled={!f.coupon}>Aplicar</button>{coupon && <span className="pill ok">{coupon.code}: −{gs(coupon.discount)}</span>}</div>
        {err && <p className="pill bad" style={{ padding: 10 }}>{err}</p>}
      </div>
      <div className="card" style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
        <h2>Resumen</h2>
        {items.map((i) => <div key={i.id} className="st-line"><span>{i.qty} x {i.name}</span><b>{gs(i.price * i.qty)}</b></div>)}
        {discount > 0 && <div className="st-line"><span>Descuento</span><b>−{gs(discount)}</b></div>}
        <div className="st-line"><span>Envío</span><b>{f.method === 'delivery' && !quote ? 'Elegí tu ciudad' : gs(fee)}</b></div>
        <div className="st-line"><b>Total</b><b className="st-price">{gs(total - discount + fee)}</b></div>
        <p className="muted">{f.pay === 'transfer' ? 'Reservamos tu pedido por un tiempo para que hagas la transferencia y subas el comprobante.' : f.pay === 'cod' ? 'Pagás en efectivo cuando recibís tu pedido. Lo confirmamos antes de enviarlo.' : 'Reservamos tu stock mientras pagás. Al confirmarse el pago te avisamos por WhatsApp.'}</p>
        <button className="primary" disabled={busy || f.name.length < 2 || f.phone.length < 6 || !deliveryOk} onClick={submit}>{busy ? 'Procesando…' : f.pay === 'bancard' ? 'Pagar ahora' : 'Confirmar pedido'}</button>
      </div>
    </div>
  )
}

// Pantalla de pago simulada: en producción se reemplaza por el checkout de Bancard (vPOS).
export function PayPage() {
  const { ref } = useParams()
  const [p, setP] = useState<any>(null)
  const [done, setDone] = useState('')
  useSeo('Pago — Librería Samantha', 'Pago seguro')
  useEffect(() => { shop('/pay/' + ref).then(setP).catch(() => setP(false)) }, [ref])
  async function simulate(approved: boolean) {
    const r = await shop(`/pay/${ref}/simulate`, { approved }).catch((e) => ({ error: e.message }))
    setDone((r as any).error ?? (approved ? 'ok' : 'rejected'))
  }
  const last = (() => { try { return JSON.parse(localStorage.getItem('samantha.last-order') ?? 'null') } catch { return null } })()
  if (p === false) return <div className="st-pay card">Pago no encontrado.</div>
  if (!p) return <div className="st-pay card">Cargando…</div>
  return (
    <div className="st-pay card">
      <h1>Pago del pedido {p.number}</h1>
      <div className="st-price big">{gs(p.amount)}</div>
      {done === 'ok' && <><p className="pill ok" style={{ padding: 10 }}>¡Pago aprobado!</p>{last && <Link to={`/tienda/pedido/${last.number}?token=${last.token}`}>Ver mi pedido</Link>}</>}
      {done === 'rejected' && <><p className="pill bad" style={{ padding: 10 }}>Pago rechazado. Podés intentar de nuevo.</p>{last && <Link to={`/tienda/pedido/${last.number}?token=${last.token}`}>Ver mi pedido</Link>}</>}
      {!done && (p.status !== 'pending' ? <p>Este pago ya fue procesado.</p> : p.mock ? (
        <><p className="muted">Entorno de pruebas: simulá la respuesta de la pasarela de pagos.</p>
          <div className="row"><button className="primary" onClick={() => simulate(true)}>Simular pago aprobado</button><button className="danger" onClick={() => simulate(false)}>Simular rechazo</button></div></>
      ) : <p>Redirigiendo a la pasarela…</p>)}
    </div>
  )
}

function OrderStatus() {
  const { number } = useParams()
  const [sp] = useState(() => new URLSearchParams(location.search))
  const [o, setO] = useState<any>(null)
  const [num, setNum] = useState(number ?? '')
  const [tok, setTok] = useState(sp.get('token') ?? '')
  const [err, setErr] = useState('')
  const [proof, setProof] = useState<{ file: File | null; amount: string; ref: string; accountId: string }>({ file: null, amount: '', ref: '', accountId: '' })
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState('')
  const lookup = (n = num, t = tok) => shop(`/orders/${n}?token=${t}`).then((r) => { setO(r); setErr(''); setProof((p) => (p.accountId || !r.transfer_accounts?.length ? p : { ...p, accountId: String(r.transfer_accounts[0].id), amount: String(r.total) })) }).catch(() => { setO(null); setErr('No encontramos el pedido. Revisá el número y el código.') })
  useEffect(() => { if (number && tok) { lookup(number, tok); const t = setInterval(() => lookup(number, tok), 8000); return () => clearInterval(t) } }, [number])
  useSeo('Seguimiento de pedido — Librería Samantha', 'Consultá el estado de tu pedido')
  const PAY: any = { pending: 'Pendiente de pago', in_review: 'Comprobante en revisión', approved: 'Pago confirmado', rejected: 'Pago rechazado', refunded: 'Reembolsado' }
  const DEL: any = { pending: 'Todavía sin preparar', preparing: 'En preparación', ready: 'Listo para retirar', dispatched: 'En camino', delivered: 'Entregado', incident: 'Tuvimos un inconveniente: te contactamos' }
  async function sendProof() {
    if (!proof.file) return
    setSending(true); setSent(''); setErr('')
    try {
      const dataBase64: string = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(proof.file!) })
      const r = await shop(`/orders/${o.number}/proof`, { token: tok, accountId: proof.accountId ? Number(proof.accountId) : null, amount: proof.amount ? Number(proof.amount.replace(/\D/g, '')) : null, reference: proof.ref || null, filename: proof.file.name, mime: proof.file.type, dataBase64 })
      setSent(r.message); setProof({ ...proof, file: null }); lookup()
    } catch (e: any) { setErr(e.message) } finally { setSending(false) }
  }
  const canUpload = o && o.payment_method === 'transfer' && ['pending', 'rejected'].includes(o.payment_status) && o.status !== 'cancelled'
  return (
    <div className="card" style={{ maxWidth: 620, margin: '0 auto', display: 'grid', gap: 10 }}>
      <h1>Seguimiento de pedido</h1>
      <div className="row"><input placeholder="N° de pedido (P-000123)" value={num} onChange={(e) => setNum(e.target.value)} /><input placeholder="Código" value={tok} onChange={(e) => setTok(e.target.value)} /><button className="primary" onClick={() => lookup()}>Buscar</button></div>
      {err && <p className="muted">{err}</p>}
      {o && <>
        <h2>{o.number} — {gs(o.total)}</h2>
        <p><span className={'pill ' + (o.payment_status === 'approved' ? 'ok' : o.payment_status === 'rejected' ? 'bad' : 'warn')}>{PAY[o.payment_status]}</span> {o.status === 'cancelled' ? <span className="pill bad">Cancelado</span> : <span className="pill">{DEL[o.delivery_status]}</span>}</p>
        {o.delivery_method === 'delivery' && <p className="muted">Delivery a {o.city ?? ''}{o.address ? ' · ' + o.address : ''}</p>}
        {o.exception && <p className="muted">{o.exception}</p>}
        {o.items.map((i: any, n: number) => <div key={n} className="st-line"><span>{i.qty} x {i.name}</span><b>{gs(i.unit_price * i.qty)}</b></div>)}
        {o.pending_payment_ref && o.payment_status !== 'approved' && o.status !== 'cancelled' && o.payment_method !== 'transfer' && <Link to={`/pay/${o.pending_payment_ref}`}><button className="primary">Ir a pagar</button></Link>}
        {o.payment_method === 'transfer' && o.payment_status === 'in_review' && <div className="card" style={{ background: 'var(--surface-2)' }}><b>Recibimos tu comprobante.</b> Lo estamos revisando; te avisamos por WhatsApp apenas confirmemos la transferencia. Mientras tanto, tu pedido queda reservado.</div>}
        {o.proof_rejected_reason && <p className="pill bad" style={{ padding: 10 }}>No pudimos validar tu comprobante: {o.proof_rejected_reason}. Subí uno nuevo.</p>}
        {canUpload && <div style={{ display: 'grid', gap: 12 }}>
          <h3>Pagá por transferencia a una de estas cuentas</h3>
          {o.transfer_accounts.map((a: any) => <div key={a.id} className="card" style={{ background: 'var(--surface-2)' }}>
            <b>{a.bank_name ?? a.name}</b>{a.is_demo && <span className="pill warn" style={{ marginLeft: 8 }}>Cuenta de demostración</span>}
            <div>N.º de cuenta: <b>{a.account_number}</b>{a.account_type ? ' · ' + a.account_type : ''}</div><div>Titular: <b>{a.holder}</b>{a.holder_document ? ' · ' + a.holder_document : ''}</div>{a.alias && <div>Alias: <b>{a.alias}</b></div>}
            {a.instructions && <div className="muted">{a.instructions}</div>}</div>)}
          <div className="pill ok" style={{ padding: 10 }}>Importe a transferir: <b>{gs(o.total)}</b>. Indicá el número de pedido <b>{o.number}</b> en el concepto.</div>
          <h3>Subí el comprobante</h3>
          <div className="form">
            {o.transfer_accounts.length > 1 && <label>Cuenta a la que transferiste<select value={proof.accountId} onChange={(e) => setProof({ ...proof, accountId: e.target.value })}>{o.transfer_accounts.map((a: any) => <option key={a.id} value={a.id}>{a.bank_name ?? a.name}</option>)}</select></label>}
            <label>Importe transferido<input inputMode="numeric" value={proof.amount} onChange={(e) => setProof({ ...proof, amount: e.target.value })} /></label>
            <label>N.º de operación (opcional)<input value={proof.ref} onChange={(e) => setProof({ ...proof, ref: e.target.value })} /></label>
            <label>Comprobante (foto o PDF)<input type="file" accept="image/*,application/pdf" onChange={(e) => setProof({ ...proof, file: e.target.files?.[0] ?? null })} /></label>
          </div>
          <button className="primary" disabled={!proof.file || sending} onClick={sendProof}>{sending ? 'Enviando…' : 'Enviar comprobante'}</button>
          {sent && <p className="pill ok" style={{ padding: 10 }}>{sent}</p>}</div>}
      </>}
    </div>
  )
}

function SchoolLists() {
  const { add } = useCart()
  const nav = useNavigate()
  const [lists, setLists] = useState<any[]>([])
  const [open, setOpen] = useState<any>(null)
  useSeo('Listas escolares — Librería Samantha', 'Comprá la lista completa de útiles de tu colegio y grado en un solo paso')
  useEffect(() => { shop('/school-lists').then(setLists).catch(() => {}) }, [])
  const total = open?.items.reduce((s: number, i: any) => s + i.price * i.qty, 0) ?? 0
  return (
    <>
      <h1>Listas escolares</h1><p className="muted">Elegí tu colegio y grado y llevá la lista completa.</p>
      <div className="st-chips">{lists.map((l) => <button key={l.id} className={open?.id === l.id ? 'primary' : ''} onClick={() => shop('/school-lists/' + l.id).then(setOpen)}>{l.school} — {l.grade}</button>)}</div>
      {!lists.length && <p className="muted">Todavía no cargamos listas. Escribinos por WhatsApp con la foto de tu lista.</p>}
      {open && <div className="card">
        {open.items.map((i: any) => <div key={i.id} className="st-line"><span>{i.qty} x {i.name} {i.availability === 'out' && <span className="pill bad">Agotado</span>}</span><b>{gs(i.price * i.qty)}</b></div>)}
        <div className="st-line"><b>Total de la lista</b><b className="st-price">{gs(total)}</b></div>
        <button className="primary" style={{ marginTop: 12 }} onClick={() => { open.items.filter((i: any) => i.availability !== 'out').forEach((i: any) => add(i, i.qty)); nav('/tienda/carrito') }}>Agregar toda la lista al carrito</button>
      </div>}
    </>
  )
}

function PrintRequest() {
  useSeo('Impresiones y fotocopias — Librería Samantha', 'Pedí tu presupuesto de impresión, copias, anillado y plastificado')
  const [f, setF] = useState({ customerName: '', phone: '', description: '', copies: 1, pages: 1, color: false, finishing: '' })
  const [done, setDone] = useState<any>(null)
  const [err, setErr] = useState('')
  const set = (k: string, num = false) => (e: any) => setF({ ...f, [k]: num ? Number(e.target.value) : e.target.value })
  async function send() { try { setDone(await shop('/print-requests', { ...f, finishing: f.finishing || null })); setErr('') } catch (e: any) { setErr(e.message) } }
  if (done) return <div className="card" style={{ maxWidth: 520, margin: '0 auto' }}><h1>¡Solicitud enviada!</h1><p>Número <b>{done.number}</b>. Presupuesto estimado <b>{gs(done.estimatedPrice)}</b>. Te confirmamos por WhatsApp antes de cobrar; enviá el archivo a nuestro WhatsApp.</p></div>
  return (
    <div className="card" style={{ maxWidth: 620, margin: '0 auto', display: 'grid', gap: 12 }}>
      <h1>Impresiones y fotocopias</h1>
      <div className="form">
        <label>Nombre<input value={f.customerName} onChange={set('customerName')} /></label>
        <label>Teléfono / WhatsApp<input value={f.phone} onChange={set('phone')} /></label>
        <label>¿Qué necesitás imprimir?<input value={f.description} onChange={set('description')} /></label>
        <label>Copias<input type="number" min={1} value={f.copies} onChange={set('copies', true)} /></label>
        <label>Páginas por copia<input type="number" min={1} value={f.pages} onChange={set('pages', true)} /></label>
        <label>Terminación<select value={f.finishing} onChange={set('finishing')}><option value="">Ninguna</option><option value="anillado">Anillado</option><option value="plastificado">Plastificado</option></select></label>
      </div>
      <label className="row" style={{ flexDirection: 'row' }}><input type="checkbox" style={{ width: 'auto' }} checked={f.color} onChange={(e) => setF({ ...f, color: e.target.checked })} /> A color</label>
      {err && <p className="pill bad" style={{ padding: 10 }}>{err}</p>}
      <button className="primary" onClick={send} disabled={f.customerName.length < 2 || f.phone.length < 6 || f.description.length < 3}>Pedir presupuesto</button>
    </div>
  )
}

const CHIPS = ['Buscar cuadernos', 'Costos de envío', 'Formas de pago', 'Listas escolares', 'Pedir una impresión', 'Ver mi carrito']

function ChatWidget() {
  const loc = useLocation()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msgs, setMsgs] = useState<{ from: 'me' | 'bot'; text: string }[]>([{ from: 'bot', text: '¡Hola! Soy el asistente de Librería Samantha. Te ayudo con productos, precios, envíos y tu pedido. ¿Qué necesitás?' }])
  const [text, setText] = useState('')
  const sid = useRef((() => { try { let s = localStorage.getItem('samantha.chat'); if (!s) { s = crypto.randomUUID(); localStorage.setItem('samantha.chat', s) } return s } catch { return crypto.randomUUID() } })())
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [msgs, open, busy])
  const say = async (raw: string) => {
    const t = raw.trim(); if (!t || busy) return
    setText(''); setMsgs((m) => [...m, { from: 'me', text: t }]); setBusy(true)
    const r = await shop('/chat', { sessionId: sid.current, message: t }).catch(() => ({ reply: 'No pude responder ahora. Probá de nuevo en un momento o escribinos por WhatsApp.' }))
    setMsgs((m) => [...m, { from: 'bot', text: r.reply }]); setBusy(false)
  }
  const render = (t: string) => t.split('\n').map((line, i) => {
    const num = line.match(/^(\d+)\.\s/)
    const parts = line.split(/(https?:\/\/\S+)/).map((p, j) => (/^https?:/.test(p) ? <a key={j} href={p}>{p.includes('/pay/') ? 'Ir a pagar' : p}</a> : p))
    return <div key={i} className="bline">{parts}{num && <button className="mini" onClick={() => say('agregar ' + num[1])}>Agregar</button>}</div>
  })
  if (loc.pathname.startsWith('/tienda/checkout')) return null
  return (
    <>
      {!open && <button className="st-chat-fab primary" onClick={() => setOpen(true)} aria-label="Abrir el asistente virtual">💬 Asistente</button>}
      {open && <div className="st-chat" role="dialog" aria-label="Asistente virtual">
        <div className="st-chat-head"><div><b>Asistente Samantha</b><small>Responde al instante, todo el día</small></div><button onClick={() => setOpen(false)} aria-label="Cerrar">×</button></div>
        <div className="st-chat-body">
          {msgs.map((m, i) => <div key={i} className={'bubble ' + m.from}>{render(m.text)}</div>)}
          {msgs.length === 1 && <div className="chips">{CHIPS.map((c) => <button key={c} onClick={() => say(c)}>{c}</button>)}</div>}
          {busy && <div className="bubble bot typing" aria-label="Escribiendo"><i /><i /><i /></div>}
          <div ref={end} />
        </div>
        <form className="st-chat-in" onSubmit={(e) => { e.preventDefault(); say(text) }}><input value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribí tu consulta…" aria-label="Mensaje" /><button className="primary" disabled={busy || !text.trim()}>Enviar</button></form>
      </div>}
    </>
  )
}

export default function Store() {
  return (
    <CustomerProvider><CartProvider>
      <Layout>
        <Routes>
          <Route path="ingresar" element={<LoginPage />} />
          <Route path="registro" element={<RegisterPage />} />
          <Route path="verificar" element={<VerifyPage />} />
          <Route path="recuperar" element={<ForgotPage />} />
          <Route path="restablecer" element={<ResetPage />} />
          <Route path="cuenta/*" element={<AccountArea />} />
          <Route index element={<Home />} />
          <Route path="producto/:id" element={<ProductPage />} />
          <Route path="carrito" element={<CartPage />} />
          <Route path="checkout" element={<Checkout />} />
          <Route path="pedido" element={<OrderStatus />} />
          <Route path="pedido/:number" element={<OrderStatus />} />
          <Route path="listas" element={<SchoolLists />} />
          <Route path="impresiones" element={<PrintRequest />} />
        </Routes>
      </Layout>
    </CartProvider></CustomerProvider>
  )
}
