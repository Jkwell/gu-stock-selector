/**
 * Service Worker：PWA 离线/缓存
 * 策略：
 *  - 静态资源（index.html、js、css、icons）：缓存优先（Cache First）
 *  - 数据接口（/api/* 和外部行情）：网络优先（Network First），不缓存保证实时
 */

const CACHE_NAME = 'stock-selector-v1'
const STATIC_ASSETS = ['/', '/index.html', '/manifest.webmanifest']

self.addEventListener('install', (e) => {
  self.skipWaiting()
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)),
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)

  // 数据接口不缓存（实时性优先）
  if (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('gtimg') ||
    url.hostname.includes('eastmoney') ||
    url.hostname.includes('sina')
  ) {
    return // 直连网络
  }

  // 静态资源：缓存优先
  e.respondWith(
    caches.match(e.request).then(
      (cached) =>
        cached ||
        fetch(e.request).then((res) => {
          const copy = res.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy))
          return res
        }),
    ),
  )
})
