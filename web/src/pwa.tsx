import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { LogoMark } from './components/Logo'

interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
interface InstallState { canInstall: boolean; prompt: () => void; installed: boolean; ios: boolean }
const Ctx = createContext<InstallState>({ canInstall: false, prompt: () => {}, installed: false, ios: false })
export const useInstall = () => useContext(Ctx)

export const isStandalone = () => typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true)
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

// La tienda (clientes) y la gestión (equipo) se instalan como apps distintas: cada una con su manifiesto y su color de barra.
const isStore = (path: string) => path === '/' || path.startsWith('/tienda') || path.startsWith('/pay')
const adminBarColor = () => { const t = document.documentElement.dataset.theme; return t === 'dark' ? '#0e1230' : t === 'warm' ? '#faf5ef' : '#f4f5fb' }
function applyArea(path: string) {
  const store = isStore(path)
  const href = store ? '/manifest-store.webmanifest' : '/manifest-admin.webmanifest'
  let link = document.querySelector('link[rel=manifest]') as HTMLLinkElement | null
  if (!link) { link = document.createElement('link'); link.rel = 'manifest'; document.head.appendChild(link) }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', store ? '#2f4a2d' : adminBarColor())
}

export function InstallProvider({ children }: { children: ReactNode }) {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(isStandalone())
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null)
  const { pathname } = useLocation()
  useEffect(() => { applyArea(pathname) }, [pathname])
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setEvt(e as BeforeInstallPromptEvent) }
    const onInstalled = () => { setEvt(null); setInstalled(true) }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    let refresh = false
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(import.meta.env.PROD ? '/sw.js' : '/sw.js?dev=1').then((reg) => {
        // Hay una versión nueva esperando: se avisa y se aplica cuando el usuario lo pide.
        if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting)
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing
          sw?.addEventListener('statechange', () => { if (sw.state === 'installed' && navigator.serviceWorker.controller) setWaiting(sw) })
        })
        const check = () => reg.update().catch(() => {})
        const t = setInterval(check, 60 * 60 * 1000)
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check() })
        return () => clearInterval(t)
      }).catch(() => {})
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (refresh) location.reload() })
      ;(window as any).__applyUpdate = () => { refresh = true }
    }
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled) }
  }, [])
  const update = () => { (window as any).__applyUpdate?.(); waiting?.postMessage({ type: 'SKIP_WAITING' }) }
  return (
    <Ctx.Provider value={{ canInstall: !!evt, prompt: () => { evt?.prompt(); setEvt(null) }, installed, ios: isIos() }}>
      {children}
      {waiting && <div className="pwa-toast" role="status"><span><b>Hay una versión nueva</b><small>Actualizá para ver las últimas mejoras.</small></span><button className="primary" onClick={update}>Actualizar</button><button className="pwa-x" onClick={() => setWaiting(null)} aria-label="Ahora no">×</button></div>}
    </Ctx.Provider>
  )
}

/** Invitación a instalar la app de la tienda (se muestra una vez cada 14 días; en iPhone explica cómo agregarla). */
export function InstallBanner() {
  const { canInstall, prompt, installed, ios } = useInstall()
  const [show, setShow] = useState(false)
  const [help, setHelp] = useState(false)
  useEffect(() => {
    if (installed) return
    let last = 0
    try { last = Number(localStorage.getItem('samantha.install.dismissed') ?? 0) } catch { /* sin almacenamiento */ }
    if (Date.now() - last < 14 * 86400_000) return
    const t = setTimeout(() => setShow(true), 9000)
    return () => clearTimeout(t)
  }, [installed])
  const close = () => { setShow(false); try { localStorage.setItem('samantha.install.dismissed', String(Date.now())) } catch { /* sin almacenamiento */ } }
  if (!show || installed || (!canInstall && !ios)) return null
  return (
    <aside className="pwa-banner" role="dialog" aria-label="Instalar la app de Samantha">
      <LogoMark size={46} />
      <div className="pwa-banner-text">
        <b>Instalá la app</b>
        {help && ios ? <span>Tocá <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="Compartir"><path d="M12 15V3M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" /></svg> Compartir y elegí «Agregar a inicio».</span>
          : <span>Entrá más rápido y seguí tus pedidos desde tu pantalla de inicio.</span>}
      </div>
      {canInstall ? <button className="primary" onClick={() => { prompt(); close() }}>Instalar</button> : !help && <button className="primary" onClick={() => setHelp(true)}>Cómo</button>}
      <button className="pwa-x" onClick={close} aria-label="Ahora no">×</button>
    </aside>
  )
}

export function useOnline() {
  const [on, setOn] = useState(navigator.onLine)
  useEffect(() => {
    const up = () => setOn(true), down = () => setOn(false)
    window.addEventListener('online', up); window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])
  return on
}
