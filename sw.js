/**
 * Service Worker：PWA 离线/缓存
 * 策略：
 *  - 页面入口（index.html / 导航请求）：网络优先（Network First），保证部署后能拿到新版本
 *  - 带哈希的静态资源（js/css/icons）：缓存优先（Cache First），文件名变更即天然失效
 *  - 数据接口（/api/* 和外部行情）：直连网络，不缓存保证实时
 * 部署路径自适应：GitHub Pages 子路径（/仓库名/）或自定义域名根路径均可用
 */

const CACHE_NAME = 'stock-selector-v3'
// 注册作用域（如 https://user.github.io/repo/），strip 末尾斜杠后拼绝对路径
const SCOPE = new URL(self.registration.scope).pathname.replace(/\/$/, '')
const STATIC_ASSETS = [
  SCOPE + '/',
  SCOPE + '/index.html',
  SCOPE + '/manifest.webmanifest',
]

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
    url.pathname.startsWith(SCOPE + '/api/') ||
    url.hostname.includes('gtimg') ||
    url.hostname.includes('eastmoney') ||
    url.hostname.includes('sina')
  ) {
    return // 直连网络
  }

  // 页面入口（HTML 导航）：网络优先，失败或离线时回退缓存。
  // 若缓存优先，部署新版本后用户会一直拿到旧 index.html（引用旧 JS），更新永远不生效。
  if (e.request.mode === 'navigate' || url.pathname === SCOPE + '/index.html') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy))
          return res
        })
        .catch(() =>
          caches.match(e.request).then((cached) => cached || caches.match(SCOPE + '/')),
        ),
    )
    return
  }

  // 其他静态资源（带哈希的 js/css、图标等）：缓存优先，文件名变更即天然失效
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
