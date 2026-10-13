import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
const Ctx = createContext<{ canInstall: boolean; prompt: () => void }>({ canInstall: false, prompt: () => {} })
export const useInstall = () => useContext(Ctx)

// Un manifest distinto para la tienda (clientes) y para el sistema de gestión (equipo).
function pickManifest() {
  const href = location.pathname === '/' || location.pathname.startsWith('/tienda') || location.pathname.startsWith('/pay') ? '/manifest-store.webmanifest' : '/manifest-admin.webmanifest'
  let link = document.querySelector('link[rel=manifest]') as HTMLLinkElement | null
  if (!link) { link = document.createElement('link'); link.rel = 'manifest'; document.head.appendChild(link) }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href)
}

export function InstallProvider({ children }: { children: ReactNode }) {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null)
  const { pathname } = useLocation()
  useEffect(pickManifest, [pathname])
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setEvt(e as BeforeInstallPromptEvent) }
    const onInstalled = () => setEvt(null)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    if ('serviceWorker' in navigator) navigator.serviceWorker.register(import.meta.env.PROD ? '/sw.js' : '/sw.js?dev=1').catch(() => {})
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled) }
  }, [])
  return <Ctx.Provider value={{ canInstall: !!evt, prompt: () => { evt?.prompt(); setEvt(null) } }}>{children}</Ctx.Provider>
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
