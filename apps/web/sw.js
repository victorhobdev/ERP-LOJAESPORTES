/* global URL, self, caches, fetch, Response */

const CACHE_PREFIX = 'erp-shell-'
const CACHE_NAME = `${CACHE_PREFIX}__ERP_BUILD_REVISION__`
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

function isPublicStaticPath(pathname) {
  return pathname === '/manifest.webmanifest'
    || pathname === '/.vite/manifest.json'
    || pathname.startsWith('/assets/')
    || pathname.startsWith('/icons/')
}

function isNavigationRequest(request) {
  if (request.method !== 'GET' || request.destination !== 'document') return false

  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname === '/api' || url.pathname.startsWith('/api/')) return false
  return !request.headers.has('authorization')
}

function isCacheableRequest(request) {
  if (request.method !== 'GET' || request.credentials === 'include') return false

  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.search || url.hash) return false
  if (request.headers.has('authorization')) return false

  return isPublicStaticPath(url.pathname)
    && ['font', 'image', 'manifest', 'script', 'style', ''].includes(request.destination)
}

function cacheResponse(request, response) {
  if (!response.ok || response.type !== 'basic') return Promise.resolve(response)

  return caches.open(CACHE_NAME)
    .then((cache) => cache.put(request, response.clone()))
    .catch(() => undefined)
    .then(() => response)
}

function precacheBuildAssets(cache) {
  return fetch('/.vite/manifest.json')
    .then((response) => {
      if (!response.ok) throw new Error('Vite asset manifest unavailable')
      return response.json()
    })
    .then((manifest) => {
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid Vite asset manifest')
      const assets = Object.values(manifest).filter((entry) => entry && typeof entry === 'object').flatMap((entry) => [
        entry.file,
        ...(entry.css ?? []),
        ...(entry.assets ?? []),
      ])
      const paths = [...new Set(assets.filter((asset) => typeof asset === 'string').map((asset) => `/${asset.replace(/^\//, '')}`))]
      if (paths.length === 0) throw new Error('Vite asset manifest has no build assets')
      return cache.addAll(paths)
    })
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS).then(() => precacheBuildAssets(cache)))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  if (isNavigationRequest(request)) {
    event.respondWith(
      fetch(request)
        .catch(() => caches.match('/index.html').then((cached) => cached ?? Response.error())),
    )
    return
  }

  if (!isCacheableRequest(request)) return

  const network = fetch(request)
    .then((response) => cacheResponse(request, response))
  event.waitUntil(network.catch(() => undefined))
  event.respondWith(
    caches.match(request)
      .catch(() => undefined)
      .then((cached) => cached ?? network.catch(() => Response.error())),
  )
})
