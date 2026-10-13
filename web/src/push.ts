import { api } from './api'

const toKey = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

export async function currentSubscription() {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription()) ?? null
}

// Pide permiso al usuario y registra este dispositivo para recibir notificaciones push nativas.
export async function enablePush() {
  if (!pushSupported()) throw new Error('Este navegador no admite notificaciones push. En iPhone, primero instalá la app en la pantalla de inicio.')
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('El permiso de notificaciones fue rechazado. Podés habilitarlo desde los ajustes del navegador.')
  const reg = await navigator.serviceWorker.ready
  const { publicKey } = await api('/push/public-key')
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) }))
  await api('/push/subscribe', { body: sub.toJSON() })
}

export async function disablePush() {
  const sub = await currentSubscription()
  if (!sub) return
  await api('/push/unsubscribe', { body: { endpoint: sub.endpoint } }).catch(() => {})
  await sub.unsubscribe()
}
