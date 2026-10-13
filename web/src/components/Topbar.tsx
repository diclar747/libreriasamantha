import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, useApp } from '../api'
import { Icon, type IconName } from './Icons'

export function Avatar({ src, name, size }: { src?: string | null; name: string; size?: 'lg' }) {
  const initials = name.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('')
  return src ? <img className={'avatar' + (size ? ' ' + size : '')} src={src} alt="" /> : <span className={'avatar' + (size ? ' ' + size : '')} aria-hidden="true">{initials}</span>
}

const ICON: Record<string, IconName> = { chat_inquiry: 'chat', order_new: 'bag', order_paid: 'wallet', order_exception: 'bolt', print_request: 'print', low_stock: 'box', invoice_rejected: 'receipt' }
const ago = (iso: string) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'ahora'
  if (s < 3600) return `hace ${Math.round(s / 60)} min`
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`
  return new Date(iso).toLocaleDateString('es-PY', { day: 'numeric', month: 'short' })
}

function useOutside(close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const on = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close() }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('mousedown', on); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', on); document.removeEventListener('keydown', key) }
  }, [])
  return ref
}

export function Bell() {
  const { toast } = useApp()
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<{ items: any[]; unread: number }>({ items: [], unread: 0 })
  const seen = useRef<number | null>(null)
  const ref = useOutside(() => setOpen(false))

  const load = () => api('/notifications').then((d) => {
    const top = d.items[0]?.id ?? 0
    // Aviso dentro de la app cuando llega algo nuevo mientras está abierta.
    if (seen.current !== null && top > seen.current) { const n = d.items[0]; toast(`${n.title}${n.body ? ' — ' + n.body : ''}`) }
    seen.current = Math.max(seen.current ?? 0, top)
    setData(d)
  }).catch(() => {})
  useEffect(() => { load(); const t = setInterval(load, 15000); document.addEventListener('visibilitychange', load); return () => { clearInterval(t); document.removeEventListener('visibilitychange', load) } }, [])
  const readAll = async () => { await api('/notifications/read', { body: {} }); load() }

  return (
    <div className="relative" ref={ref}>
      <button className="icon-btn" aria-label={`Notificaciones${data.unread ? `, ${data.unread} sin leer` : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="bell" />{data.unread > 0 && <span className="badge">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Notificaciones">
          <div className="pop-head"><b>Notificaciones</b><button onClick={readAll} disabled={!data.unread}>Marcar todo como leído</button></div>
          {data.items.map((n) => (
            <button key={n.id} className={'notif' + (n.unread ? ' unread' : '')} onClick={() => { setOpen(false); readAll(); if (n.link) nav(n.link) }}>
              <span className="dot"><Icon name={ICON[n.type] ?? 'bell'} size={18} /></span>
              <span><b>{n.title}</b>{n.body && <p>{n.body}</p>}<time>{ago(n.created_at)}</time></span>
            </button>
          ))}
          {!data.items.length && <p className="muted" style={{ padding: 18, margin: 0 }}>Todavía no hay avisos. Cuando alguien consulte o haga un pedido, lo vas a ver acá y en tu celular.</p>}
          <div style={{ padding: 10 }}><Link to="/profile" onClick={() => setOpen(false)}>Elegir qué avisos recibir</Link></div>
        </div>
      )}
    </div>
  )
}

export function UserMenu({ profile, onLogout }: { profile: any; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useOutside(() => setOpen(false))
  const name = profile?.name ?? ''
  return (
    <div className="relative" ref={ref}>
      <button className="userbtn" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Mi cuenta">
        <Avatar src={profile?.avatar} name={name || '?'} />
        <span className="who"><b>{name}</b><span>{profile?.role}</span></span>
      </button>
      {open && (
        <div className="popover menu" role="menu">
          <Link to="/profile" onClick={() => setOpen(false)}><Icon name="users" size={18} /> Mi perfil</Link>
          <a href="/tienda" target="_blank" rel="noreferrer"><Icon name="bag" size={18} /> Ver la tienda</a>
          <button onClick={onLogout}><Icon name="logout" size={18} /> Salir</button>
        </div>
      )}
    </div>
  )
}
