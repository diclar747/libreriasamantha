// Service worker de Samantha: la app abre sin conexión, las fotos y el catálogo se guardan para verlos de nuevo
// y las actualizaciones se avisan al usuario. Nunca guarda datos de la administración (todo /api/ autenticado).
const VERSION = 'samantha-v4'
const SHELL = `shell-${VERSION}`, ASSETS = `assets-${VERSION}`, IMAGES = `img-${VERSION}`, API = `api-${VERSION}`
const CURRENT = [SHELL, ASSETS, IMAGES, API]
const PRECACHE = ['/', '/tienda', '/offline.html', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/brand/samantha-lockup.png', '/brand/samantha-wordmark.png', '/manifest-store.webmanifest', '/manifest-admin.webmanifest']
const PUBLIC_API = /^\/api\/shop\/(info|categories|products|zones|school-lists)/
const DEV = new URL(self.location).searchParams.has('dev') // en desarrollo no se guarda nada en caché

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(new Request(u, { cache: 'reload' }))))))
})
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (!CURRENT.includes(k)) await caches.delete(k)
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable()
    await self.clients.claim()
  })())
})
// La página pide aplicar la actualización cuando el usuario toca «Actualizar».
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting() })

const trim = async (name, max) => { const c = await caches.open(name); const keys = await c.keys(); for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]) }
const cacheFirst = async (req, name, max) => {
  const c = await caches.open(name); const hit = await c.match(req); if (hit) return hit
  const res = await fetch(req); if (res.ok) { c.put(req, res.clone()); if (max) trim(name, max) } return res
}
const networkFirst = async (req, name) => {
  const c = await caches.open(name)
  try { const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res } catch { const hit = await c.match(req); if (hit) return hit; throw new Error('offline') }
}
const staleWhileRevalidate = async (req, name) => {
  const c = await caches.open(name); const hit = await c.match(req)
  const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res }).catch(() => hit)
  return hit || net
}
const navigate = async (e) => {
  const c = await caches.open(SHELL); const key = new URL(e.request.url).pathname.startsWith('/tienda') ? '/tienda' : '/'
  try {
    const res = (await e.preloadResponse) || (await fetch(e.request))
    if (res.ok) c.put(key, res.clone())
    return res
  } catch {
    if (new URL(e.request.url).pathname === '/offline.html') return (await c.match('/offline.html')) || Response.error()
    return (await c.match(key)) || (await c.match('/')) || (await c.match('/offline.html')) || Response.error()
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (DEV || req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname.startsWith('/api/shop/img/')) e.respondWith(cacheFirst(req, IMAGES, 180))
      else if (PUBLIC_API.test(url.pathname)) e.respondWith(networkFirst(req, API))
      return
    }
    if (req.mode === 'navigate') { e.respondWith(navigate(e)); return }
    if (url.pathname.startsWith('/assets/')) { e.respondWith(cacheFirst(req, ASSETS)); return }
    if (/^\/(icons|brand|images|splash|screenshots)\//.test(url.pathname) || /\.(webmanifest|svg)$/.test(url.pathname)) { e.respondWith(staleWhileRevalidate(req, ASSETS)); return }
    return
  }
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com')) e.respondWith(staleWhileRevalidate(req, ASSETS))
})

// Notificaciones push (VAPID): el servidor avisa de pedidos, consultas y alertas aunque la app esté cerrada.
self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { d = { title: 'Samantha', body: e.data ? e.data.text() : '' } }
  e.waitUntil(self.registration.showNotification(d.title || 'Samantha', {
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
