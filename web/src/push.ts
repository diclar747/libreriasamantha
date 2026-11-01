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

// ---------------------------------------------------------------- Tienda: suscripción de marketing (visitante anónimo)
async function shopPost(path: string, body: unknown) {
  const res = await fetch('/api/shop' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Error')
  return res.json().catch(() => ({}))
}

// Suscribe el navegador del cliente para recibir campañas de ofertas. Pide el permiso nativo recién al llamarse.
export async function subscribeOffers(accountId?: number | null) {
  if (!pushSupported()) throw new Error('Este navegador no admite notificaciones. En iPhone, primero agregá la tienda a tu pantalla de inicio.')
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('No se concedió el permiso de notificaciones.')
  const reg = await navigator.serviceWorker.ready
  const r = await fetch('/api/shop/push/public-key'); const { publicKey } = await r.json()
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) }))
  await shopPost('/push/subscribe', { ...sub.toJSON(), accountId: accountId ?? null })
}

export async function unsubscribeOffers() {
  const sub = await currentSubscription()
  if (!sub) return
  await shopPost('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {})
  await sub.unsubscribe()
}
