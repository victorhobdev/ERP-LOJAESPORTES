import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { defineConfig, devices } from '@playwright/test'

const e2eMediaDir = process.env['E2E_MEDIA_DIR'] || path.resolve('e2e-artifacts/media')
const e2eSyncDir = process.env['E2E_SYNC_DIR'] ?? path.resolve('e2e-artifacts/catalog-sync')
mkdirSync(e2eMediaDir, { recursive: true })
mkdirSync(e2eSyncDir, { recursive: true })

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1366, height: 768 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } } }],
  webServer: process.env['E2E_FULLSTACK'] === '1'
    ? [
        {
          command: 'pnpm --filter @erp/api serve:e2e',
          port: 3333,
          reuseExistingServer: false,
          env: {
            DATABASE_URL: process.env['E2E_DATABASE_URL'] ?? '',
            MEDIA_STORAGE_DIR: e2eMediaDir,
            CATALOG_SYNC_LOCAL_DIR: e2eSyncDir,
            E2E_USER_ID: process.env['E2E_USER_ID'] ?? '',
            PORT: '3333',
            HOST: '127.0.0.1',
            CORS_ORIGINS: 'http://127.0.0.1:4173',
            NODE_ENV: 'test',
          },
        },
        {
          command: 'pnpm --filter @erp/web preview --host 127.0.0.1 --port 4173',
          port: 4173,
          reuseExistingServer: false,
        },
      ]
    : {
        command: 'pnpm --filter @erp/web preview --host 127.0.0.1 --port 4173',
        port: 4173,
        reuseExistingServer: false,
      },
})
