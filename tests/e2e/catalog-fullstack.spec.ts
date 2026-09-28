import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

import { expect, test } from '@playwright/test'
import { openOperationalApp } from './operational-app.js'

const enabled = process.env['E2E_FULLSTACK'] === '1'
test.skip(!enabled, 'Full-stack de catalogo exige E2E_FULLSTACK=1 com API e PostgreSQL de teste.')

const tag = process.env['E2E_TAG'] ?? ''

const club = 'E2E Catalogo'

// PNG 1x1 valido (assinatura + IHDR + IDAT + IEND).
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('catalogo full-stack: upload de imagem, leitura de midia e sincronizacao local', async ({ page }, testInfo) => {
  const attemptTag = testInfo.retry === 0 ? tag : `${tag}-retry-${testInfo.retry}`
  const model = `Modelo ${attemptTag}`
  const sku = `CAT-M-${attemptTag}`

  expect(tag, 'E2E_TAG sintética').not.toBe('')
  expect(page.viewportSize()).toEqual({ width: 1366, height: 768 })

  await test.step('abre o painel operacional', async () => {
    await openOperationalApp(page)
  })

  await test.step('cadastrar produto com variante', async () => {
    await page.goto('/estoque')
    await page.getByRole('button', { name: 'Novo produto' }).click()
    const form = page.getByRole('region', { name: 'Novo produto' })
    await form.getByRole('textbox', { name: 'Clube' }).fill(club)
    await form.getByRole('textbox', { name: 'Modelo' }).fill(model)
    await form.getByRole('textbox', { name: 'Tamanho' }).fill('M')
    await form.getByRole('textbox', { name: 'SKU' }).fill(sku)
    await form.getByRole('textbox', { name: 'Preço' }).fill('120.00')
    await form.getByRole('textbox', { name: 'Custo' }).fill('60.00')
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/products') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Cadastrar produto' }).click()
    const response = await responsePromise
    expect(response.status()).toBe(201)
    const product = (await response.json()) as { variants: Array<{ id: string }> }
    expect(product.variants).toHaveLength(1)
    const movement = await page.request.post('/api/inventory/movements', {
      data: { variantId: product.variants[0]!.id, quantityDelta: 1, reason: 'Disponibilizar produto para catálogo E2E' },
      headers: { 'idempotency-key': `catalog-initial-stock-${attemptTag}` },
    })
    expect(movement.status()).toBe(201)
  })

  await test.step('upload de imagem real pelo catalogo', async () => {
    await page.goto(`/catalogo?search=${encodeURIComponent(club)}`)
    const input = page.getByLabel(`Enviar imagem de ${club} ${model}`)
    const artifacts = path.join('e2e-artifacts', 'catalog')
    mkdirSync(artifacts, { recursive: true })
    const imagePath = path.join(artifacts, `escudo-${attemptTag}.png`)
    writeFileSync(imagePath, Buffer.from(pngBase64, 'base64'))
    await input.setInputFiles(imagePath)
    const image = page.getByRole('img', { name: `Imagem: ${club} ${model}`, exact: true })
    await expect(image).toBeVisible()
    const src = await image.getAttribute('src')
    expect(src).toContain('/api/catalog/media/')
    await page.screenshot({ path: 'e2e-artifacts/catalog-1366.png' })
  })

  await test.step('midia e servida pela API com tipo e conteudo corretos', async () => {
    await page.goto(`/catalogo?search=${encodeURIComponent(club)}`)
    const image = page.getByRole('img', { name: `Imagem: ${club} ${model}`, exact: true })
    await expect(image).toBeVisible()
    const src = await image.getAttribute('src')
    expect(src).not.toBeNull()
    const fetched = await page.request.get(src!)
    expect(fetched.status()).toBe(200)
    expect(fetched.headers()['content-type']).toBe('image/png')
    const body = await fetched.body()
    expect(body.length).toBeGreaterThan(0)
    expect(body.equals(Buffer.from(pngBase64, 'base64'))).toBe(true)
  })

  await test.step('sincronizacao local conclui com o item depositado no diretorio', async () => {
    // Caminho de resolucao real por ambiente: a API le CATALOG_SYNC_LOCAL_DIR
    // configurado no webServer (mesmo diretorio absoluto definido no playwright.config).
    const syncDir = process.env['E2E_SYNC_DIR'] ?? path.resolve('e2e-artifacts/catalog-sync')
    rmSync(syncDir, { recursive: true, force: true })
    mkdirSync(syncDir, { recursive: true })
    writeFileSync(path.join(syncDir, `${club}__${model}.png`), Buffer.from(pngBase64, 'base64'))
    const response = await page.request.post('/api/catalog/sync', {
      headers: { 'idempotency-key': `catalog-local-sync-${attemptTag}` },
    })
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'completed', provider: 'local', itemCount: 1, errorCount: 0 })
  })

  await test.step('evidencia visual em largura estreita', async () => {
    await page.goto(`/catalogo?search=${encodeURIComponent(club)}`)
    await expect(page.getByRole('heading', { name: model, exact: true })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: 'e2e-artifacts/catalog-390.png' })
    await page.setViewportSize({ width: 1366, height: 768 })
  })
})
