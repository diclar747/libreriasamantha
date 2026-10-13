import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, useApp } from '../api'
import { Avatar } from '../components/Topbar'
import { Icon } from '../components/Icons'
import { currentSubscription, disablePush, enablePush, pushSupported } from '../push'

const ROLE: Record<string, string> = { owner: 'Propietario', admin: 'Administrador', cashier: 'Cajero/a', seller: 'Vendedor/a', buyer: 'Compras', warehouse: 'Depósito', accountant: 'Contador/a', support: 'Atención al cliente' }

// Recorta al centro y reduce a 256 px para que el avatar pese pocos KB.
function toAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const s = Math.min(img.width, img.height)
      const c = document.createElement('canvas'); c.width = c.height = 256
      c.getContext('2d')!.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256)
      resolve(c.toDataURL('image/jpeg', 0.86))
    }
    img.onerror = () => reject(new Error('No se pudo leer la imagen'))
    img.src = URL.createObjectURL(file)
  })
}

export default function Profile() {
  const { user, toast } = useApp()
  const [p, setP] = useState<any>(null)
  const [pw, setPw] = useState({ current: '', next: '', again: '' })
  const [deviceOn, setDeviceOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  const load = () => api('/me/profile').then(setP).catch((e) => toast(e.message, true))
  useEffect(() => { load(); currentSubscription().then((s) => setDeviceOn(!!s)) }, [])
  const refreshBar = () => window.dispatchEvent(new Event('profile-updated'))
  if (!p) return <p className="muted">Cargando tu perfil…</p>
  const set = (k: string) => (e: any) => setP({ ...p, [k]: e.target.value })

  async function save() {
    try { await api('/me/profile', { method: 'PUT', body: { name: p.name, phone: p.phone || null, email: p.email || null, address: p.address || null } }); toast('Perfil guardado'); refreshBar() } catch (e: any) { toast(e.message, true) }
  }
  async function pickAvatar(f: File) {
    try {
      const avatar = await toAvatar(f)
      await api('/me/profile', { method: 'PUT', body: { name: p.name, phone: p.phone || null, email: p.email || null, address: p.address || null, avatar } })
      setP({ ...p, avatar }); toast('Foto actualizada'); refreshBar()
    } catch (e: any) { toast(e.message, true) }
  }
  async function removeAvatar() {
    await api('/me/profile', { method: 'PUT', body: { name: p.name, phone: p.phone || null, email: p.email || null, address: p.address || null, avatar: null } }).catch((e) => toast(e.message, true))
    setP({ ...p, avatar: null }); refreshBar()
  }
  async function changePassword() {
    if (pw.next !== pw.again) return toast('Las contraseñas nuevas no coinciden', true)
    try { await api('/me/password', { body: { current: pw.current, next: pw.next } }); toast('Contraseña cambiada. Se cerraron tus otras sesiones.'); setPw({ current: '', next: '', again: '' }) } catch (e: any) { toast(e.message, true) }
  }
  async function togglePref(key: string, channel: 'inapp' | 'push', value: boolean) {
    const types = p.notificationTypes.map((t: any) => (t.key === key ? { ...t, [channel]: value } : t))
    setP({ ...p, notificationTypes: types })
    const t = types.find((x: any) => x.key === key)
    await api('/me/notification-prefs', { method: 'PUT', body: { [key]: { inapp: t.inapp, push: t.push } } }).catch((e) => toast(e.message, true))
  }
  async function toggleDevice() {
    setBusy(true)
    try {
      if (deviceOn) { await disablePush(); setDeviceOn(false); toast('Este dispositivo dejó de recibir notificaciones push') }
      else { await enablePush(); setDeviceOn(true); toast('Listo: este dispositivo recibirá notificaciones push') }
      load()
    } catch (e: any) { toast(e.message, true) } finally { setBusy(false) }
  }
  async function testPush() {
    try { const r = await api('/push/test', { body: {} }); toast(r.sent ? 'Te enviamos una notificación de prueba' : 'No se pudo entregar la prueba; reactivá este dispositivo', !r.sent) } catch (e: any) { toast(e.message, true) }
  }

  return (
    <>
      <div className="card profile-hero">
        <div className="relative">
          <Avatar src={p.avatar} name={p.name} size="lg" />
          <button className="icon-btn" style={{ position: 'absolute', right: -6, bottom: -2, width: 34, height: 34, background: 'var(--surface)' }} onClick={() => file.current?.click()} aria-label="Cambiar foto"><Icon name="camera" size={18} /></button>
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && pickAvatar(e.target.files[0])} />
        </div>
        <div style={{ flex: 1, minWidth: 200, paddingTop: 62 }}>
          <h1 style={{ margin: 0 }}>{p.name}</h1>
          <span className="muted">{ROLE[p.role] ?? p.role} · @{p.username}</span>
        </div>
        {p.avatar && <button onClick={removeAvatar} style={{ marginTop: 62 }}>Quitar foto</button>}
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card" style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
          <h2>Mis datos</h2>
          <label>Nombre<input value={p.name ?? ''} onChange={set('name')} autoComplete="name" /></label>
          <label>Teléfono<input value={p.phone ?? ''} onChange={set('phone')} inputMode="tel" autoComplete="tel" placeholder="+595…" /></label>
          <label>Correo<input value={p.email ?? ''} onChange={set('email')} inputMode="email" autoComplete="email" /></label>
          <label>Dirección<input value={p.address ?? ''} onChange={set('address')} autoComplete="street-address" /></label>
          <button className="primary" onClick={save} disabled={(p.name ?? '').length < 2}>Guardar cambios</button>
        </div>

        <div className="card" style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
          <h2>Cambiar contraseña</h2>
          <label>Contraseña actual<input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></label>
          <label>Contraseña nueva (mínimo 8 caracteres)<input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" /></label>
          <label>Repetir contraseña nueva<input type="password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} autoComplete="new-password" /></label>
          <button onClick={changePassword} disabled={!pw.current || pw.next.length < 8}>Cambiar contraseña</button>
          <p className="muted" style={{ margin: 0 }}>Al cambiarla se cierran tus sesiones en otros dispositivos.</p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div><h2 style={{ marginBottom: 2 }}>Notificaciones</h2><span className="muted">Elegí qué querés enterarte y dónde: en la campana de la app y/o como notificación push en este dispositivo.</span></div>
          <div className="row">
            <button className={deviceOn ? '' : 'primary'} onClick={toggleDevice} disabled={busy || !pushSupported()}>{deviceOn ? 'Desactivar en este dispositivo' : 'Activar en este dispositivo'}</button>
            {deviceOn && <button onClick={testPush}>Enviar prueba</button>}
          </div>
        </div>
        {!pushSupported() && <p className="callout" style={{ marginTop: 12 }}>Este navegador no admite notificaciones push. En iPhone, instalá primero la app en la pantalla de inicio (Compartir → Agregar a inicio).</p>}
        <p className="muted">Dispositivos con push activo: <b>{p.pushDevices}</b></p>
        <div className="prefs" style={{ marginTop: 6 }}>
          <span className="h">Aviso</span><span className="h">En la app</span><span className="h">Push</span>
          {p.notificationTypes.map((t: any) => (
            <div key={t.key} style={{ display: 'contents' }}>
              <div><b>{t.label}</b><div className="muted" style={{ fontSize: 12 }}>{t.hint}</div></div>
              <label className="switch"><input type="checkbox" checked={t.inapp} onChange={(e) => togglePref(t.key, 'inapp', e.target.checked)} aria-label={`${t.label}: en la app`} /></label>
              <label className="switch"><input type="checkbox" checked={t.push} onChange={(e) => togglePref(t.key, 'push', e.target.checked)} aria-label={`${t.label}: push`} /></label>
            </div>
          ))}
        </div>
        {['owner', 'admin'].includes(user!.role) && <p style={{ marginTop: 14 }}>¿Querés cambiar la API de IA o los datos del negocio? <Link to="/settings">Ir a Configuración</Link></p>}
      </div>
    </>
  )
}
