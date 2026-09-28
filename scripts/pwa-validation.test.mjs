import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

const root = new globalThis.URL('../', import.meta.url)

async function read(relativePath) {
  return readFile(new globalThis.URL(relativePath, root), 'utf8')
}

async function loadWorker({ fetchImpl, matchImpl, shellAddAllError = false, buildAddAllError = false } = {}) {
  const handlers = new Map()
  const addAllCalls = []
  const putCalls = []
  let skipWaitingCalls = 0
  const defaultFetch = async (input) => input === '/.vite/manifest.json'
    ? new globalThis.Response(JSON.stringify({ index: { file: 'assets/app.js', css: ['assets/app.css'] } }), { headers: { 'content-type': 'application/json' } })
    : new globalThis.Response('ok')
  const cache = {
    addAll: async (paths) => {
      addAllCalls.push(paths)
      if (shellAddAllError || (buildAddAllError && addAllCalls.length === 2)) throw new Error('asset precache failed')
    },
    put: async (request) => { putCalls.push(request.url) },
  }
  const context = {
    URL: globalThis.URL,
    Response: globalThis.Response,
    Headers: globalThis.Headers,
    Promise,
    fetch: fetchImpl ?? defaultFetch,
    caches: {
      match: matchImpl ?? (async () => undefined),
      open: async () => cache,
      keys: async () => [],
      delete: async () => true,
    },
    self: {
      location: { origin: 'https://erp.example.test' },
      clients: { claim: async () => undefined },
      skipWaiting: async () => { skipWaitingCalls += 1 },
      addEventListener(type, handler) { handlers.set(type, handler) },
    },
  }
  vm.runInNewContext(await read('apps/web/sw.js'), context)
  return { handlers, addAllCalls, putCalls, get skipWaitingCalls() { return skipWaitingCalls } }
}

test('manifest exposes an installable ERP shell', async () => {
  const manifest = JSON.parse(await read('apps/web/public/manifest.webmanifest'))

  assert.equal(manifest.name, 'ERP 2.0')
  assert.equal(manifest.short_name, 'ERP 2.0')
  assert.equal(manifest.start_url, '/inicio')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.lang, 'pt-BR')
  assert.ok(Array.isArray(manifest.icons))
  assert.deepEqual(
    manifest.icons.map(({ sizes, purpose }) => ({ sizes, purpose })),
    [
      { sizes: '192x192', purpose: 'any' },
      { sizes: '512x512', purpose: 'any maskable' },
    ],
  )

  for (const [relativePath, size] of [['apps/web/public/icons/icon-180.png', 180], ['apps/web/public/icons/icon-192.png', 192], ['apps/web/public/icons/icon-512.png', 512]]) {
    const icon = await readFile(new globalThis.URL(relativePath, root))
    assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(icon.readUInt32BE(16), size)
    assert.equal(icon.readUInt32BE(20), size)
  }
})

test('HTML advertises the manifest and mobile install metadata', async () => {
  const html = await read('apps/web/index.html')

  assert.match(html, /rel="manifest"\s+href="\/manifest\.webmanifest"/)
  assert.match(html, /name="apple-mobile-web-app-capable"\s+content="yes"/)
  assert.match(html, /rel="apple-touch-icon"\s+href="\/icons\/icon-180\.png"/)
})

test('service worker only caches safe static same-origin GET requests', async () => {
  const worker = await read('apps/web/sw.js')
  const viteConfig = await read('apps/web/vite.config.ts')

  assert.match(worker, /request\.method\s*!==\s*['"]GET['"]|request\.method\s*===\s*['"]GET['"]/)
  assert.match(worker, /url\.origin\s*!==\s*self\.location\.origin/)
  assert.match(worker, /isPublicStaticPath\(url\.pathname\)/)
  assert.match(worker, /pathname\.startsWith\(['"]\/assets\//)
  assert.match(worker, /url\.search/)
  assert.match(worker, /request\.headers\.has\(['"]authorization['"]\)/i)
  assert.match(worker, /cache\.put/)
  assert.match(worker, /event\.waitUntil\(network\.catch\(/)
  assert.match(worker, /precacheBuildAssets/)
  assert.match(worker, /cache\.addAll\(paths\)/)
  assert.match(worker, /__ERP_BUILD_REVISION__/)
  assert.match(worker, /skipWaiting/)
  assert.match(viteConfig, /build:\s*\{\s*manifest:\s*true\s*\}/)
})

test('service worker leaves API, query and credentialed requests untouched', async () => {
  const { handlers } = await loadWorker()
  const fetchHandler = handlers.get('fetch')
  assert.equal(typeof fetchHandler, 'function')

  for (const request of [
    { method: 'POST', credentials: 'same-origin', url: 'https://erp.example.test/api/sales', destination: '', headers: new globalThis.Headers() },
    { method: 'GET', credentials: 'same-origin', url: 'https://erp.example.test/api/sales', destination: '', headers: new globalThis.Headers() },
    { method: 'GET', credentials: 'same-origin', url: 'https://erp.example.test/assets/app.js?v=secret', destination: 'script', headers: new globalThis.Headers() },
    { method: 'GET', credentials: 'include', url: 'https://erp.example.test/assets/app.js', destination: 'script', headers: new globalThis.Headers() },
    { method: 'GET', credentials: 'same-origin', url: 'https://erp.example.test/assets/app.js', destination: 'script', headers: new globalThis.Headers({ authorization: 'Bearer redacted' }) },
  ]) {
    let intercepted = false
    fetchHandler({ request, respondWith() { intercepted = true } })
    assert.equal(intercepted, false, `request should bypass the worker: ${request.method} ${request.url}`)
  }
})

test('service worker handles a safe static GET without touching API routes', async () => {
  const { handlers } = await loadWorker()
  const fetchHandler = handlers.get('fetch')
  let responsePromise
  const request = { method: 'GET', credentials: 'same-origin', url: 'https://erp.example.test/assets/app.js', destination: 'script', headers: new globalThis.Headers() }

  fetchHandler({ request, waitUntil() {}, respondWith(promise) { responsePromise = promise } })
  assert.ok(responsePromise)
  const response = await responsePromise
  assert.equal(response.status, 200)
})

test('service worker serves the cached shell for an offline navigation without caching the document', async () => {
  const cachedIndex = new globalThis.Response('<html>cached shell</html>')
  const { handlers, putCalls } = await loadWorker({
    fetchImpl: async () => { throw new Error('offline') },
    matchImpl: async (request) => request === '/index.html' ? cachedIndex : undefined,
  })
  const fetchHandler = handlers.get('fetch')
  const request = { method: 'GET', credentials: 'include', url: 'https://erp.example.test/inicio', destination: 'document', headers: new globalThis.Headers() }
  let responsePromise

  fetchHandler({ request, waitUntil() {}, respondWith(promise) { responsePromise = promise } })
  const response = await responsePromise
  assert.equal(await response.text(), '<html>cached shell</html>')
  assert.deepEqual(putCalls, [])
})

test('service worker keeps cache-hit revalidation alive until the replacement is stored', async () => {
  const cached = new globalThis.Response('cached')
  const { handlers, putCalls } = await loadWorker({
    fetchImpl: async () => new Promise((resolve) => globalThis.setTimeout(() => resolve({ ok: true, type: 'basic', clone() { return this } }), 10)),
    matchImpl: async () => cached,
  })
  const fetchHandler = handlers.get('fetch')
  const request = { method: 'GET', credentials: 'same-origin', url: 'https://erp.example.test/assets/app.js', destination: 'script', headers: new globalThis.Headers() }
  let responsePromise
  const waits = []
  const event = { request, waitUntil(promise) { waits.push(promise) }, respondWith(promise) { responsePromise = promise } }

  fetchHandler(event)
  assert.equal(waits.length, 1)
  const response = await responsePromise
  assert.equal(await response.text(), 'cached')
  await Promise.all(waits)
  assert.deepEqual(putCalls, [request.url])
})

test('service worker does not activate when the build manifest or its assets cannot be precached', async () => {
  const successful = await loadWorker()
  let installPromise
  successful.handlers.get('install')({ waitUntil(promise) { installPromise = promise } })
  await installPromise
  assert.equal(successful.addAllCalls.length, 2)
  assert.deepEqual([...successful.addAllCalls[1]], ['/assets/app.js', '/assets/app.css'])
  assert.equal(successful.skipWaitingCalls, 1)

  const failed = await loadWorker({ fetchImpl: async (input) => input === '/.vite/manifest.json'
    ? new globalThis.Response('unavailable', { status: 503 })
    : new globalThis.Response('ok') })
  let failedInstall
  failed.handlers.get('install')({ waitUntil(promise) { failedInstall = promise } })
  await assert.rejects(failedInstall, /Vite asset manifest unavailable/)
  assert.equal(failed.skipWaitingCalls, 0)

  const failedAssets = await loadWorker({ buildAddAllError: true })
  let failedAssetInstall
  failedAssets.handlers.get('install')({ waitUntil(promise) { failedAssetInstall = promise } })
  await assert.rejects(failedAssetInstall, /asset precache failed/)
  assert.equal(failedAssets.skipWaitingCalls, 0)
})
