// Service worker: la app abre sin conexión y la tienda se puede mirar sin red.
// Nunca guarda datos autenticados de la administración (solo el catálogo público).
const VERSION = 'samantha-v1'
const SHELL = ['/', '/tienda', '/favicon.svg', '/icons/icon-192.png']
const PUBLIC_API = /^\/api\/shop\/(info|categories|products|zones|school-lists)/

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

const networkFirst = async (req, fallbackKey) => {
  try {
    const res = await fetch(req)
    if (res.ok) { const c = await caches.open(VERSION); c.put(fallbackKey || req, res.clone()) }
    return res
  } catch {
    const hit = await caches.match(fallbackKey || req)
    if (hit) return hit
    throw new Error('offline')
  }
}
const staleWhileRevalidate = async (req) => {
  const c = await caches.open(VERSION)
  const hit = await c.match(req)
  const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res }).catch(() => hit)
  return hit || net
}

const DEV = new URL(self.location).searchParams.has('dev') // en desarrollo no se guarda nada en caché

self.addEventListener('fetch', (e) => {
  if (DEV) return
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/')) { if (PUBLIC_API.test(url.pathname)) e.respondWith(networkFirst(req)); return }
    if (req.mode === 'navigate') { e.respondWith(networkFirst(req, url.pathname.startsWith('/tienda') ? '/tienda' : '/')); return }
    e.respondWith(staleWhileRevalidate(req)); return
  }
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com')) e.respondWith(staleWhileRevalidate(req))
})

// Notificaciones push (VAPID): el servidor avisa de pedidos, consultas y alertas aunque la app esté cerrada.
self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { d = { title: 'Librería Samantha', body: e.data ? e.data.text() : '' } }
  e.waitUntil(self.registration.showNotification(d.title || 'Librería Samantha', {
    body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: d.tag, data: { url: d.url || '/' },
  }))
})
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || '/'
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { if ('navigate' in c) c.navigate(url); return c.focus() } }
    return self.clients.openWindow(url)
  }))
})
