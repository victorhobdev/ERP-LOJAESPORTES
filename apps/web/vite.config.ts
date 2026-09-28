import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

const webRoot = path.dirname(fileURLToPath(import.meta.url))

function serviceWorkerPlugin(): Plugin {
  return {
    name: 'erp-pwa-service-worker',
    generateBundle(_options, bundle) {
      const bundleContent = Object.entries(bundle).sort(([first], [second]) => first.localeCompare(second)).map(([fileName, output]) => {
        return `${fileName}\0${output.type === 'asset' ? String(output.source) : output.code}`
      }).join('\0')
      const staticManifest = readFileSync(path.join(webRoot, 'public', 'manifest.webmanifest'), 'utf8')
      const icons = ['icon-180.png', 'icon-192.png', 'icon-512.png'].map((fileName) => readFileSync(path.join(webRoot, 'public', 'icons', fileName)))
      const revision = createHash('sha256').update(Buffer.concat([Buffer.from(`${bundleContent}\0${staticManifest}\0`), ...icons])).digest('hex').slice(0, 12)
      const template = readFileSync(path.join(webRoot, 'sw.js'), 'utf8')
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: template.replace('__ERP_BUILD_REVISION__', revision) })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorkerPlugin()],
  server: {
    proxy: { '/api': { target: 'http://127.0.0.1:3333', changeOrigin: true, rewrite: (path) => path.replace(/^\/api/, '') } },
  },
  build: { manifest: true },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
})
