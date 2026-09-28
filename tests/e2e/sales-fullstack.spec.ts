import { appendFileSync, mkdirSync } from 'node:fs'

import { expect, test } from '@playwright/test'
import { openOperationalApp } from './operational-app.js'

const enabled = process.env['E2E_FULLSTACK'] === '1'
test.skip(!enabled, 'Full-stack de vendas exige E2E_FULLSTACK=1 com API e PostgreSQL de teste.')

const tag = process.env['E2E_TAG'] ?? ''
const saleId = process.env['E2E_SALE_ID'] ?? ''
const variantId = process.env['E2E_VARIANT_ID'] ?? ''
const idsFile = process.env['E2E_SALES_IDS_FILE'] ?? 'e2e-artifacts/sales-fullstack-ids.json'

const sku = `EVN-M-${tag}`

function saveIds(ids: Record<string, string>) {
  mkdirSync('e2e-artifacts', { recursive: true })
  appendFileSync(idsFile, `${JSON.stringify(ids)}\n`)
}

test('vendas full-stack: listagem, detalhe, pagamento com retry unico e troca', async ({ page }) => {
  const exchangePosts: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/exchanges') && request.method() === 'POST') exchangePosts.push(request.url())
  })
  expect(saleId, 'E2E_SALE_ID sintético').not.toBe('')

  await test.step('abre o painel operacional', async () => {
    await openOperationalApp(page)
  })

  await test.step('listagem com filtro leva ao detalhe', async () => {
    await page.goto('/vendas?status=pending')
    const link = page.locator(`a[href="/vendas/${saleId}"]`)
    await expect(link).toBeVisible()
    await link.click()
    await page.waitForURL(`**/vendas/${saleId}`)
    await expect(page.getByRole('heading', { name: `Venda ${saleId.slice(0, 8)}` })).toBeVisible()
  })

  await test.step('pagamento posterior com resposta perdida gera efeito unico', async () => {
    await page.getByRole('textbox', { name: 'Valor' }).fill('150.00')

    let interceptedOnce = false
    let serverPaymentId = ''
    await page.route('**/api/sales/*/payments', async (route) => {
      if (route.request().method() !== 'POST' || interceptedOnce) return route.continue()
      interceptedOnce = true
      const serverResponse = await route.fetch()
      expect(serverResponse.status()).toBe(201)
      serverPaymentId = ((await serverResponse.json()) as { id: string }).id
      return route.abort('connectionaborted')
    })

    await page.getByRole('button', { name: 'Registrar pagamento' }).click()
    await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible()

    const retryPromise = page.waitForResponse((response) => response.url().includes('/api/sales/') && response.url().endsWith('/payments') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Tentar novamente' }).click()
    const retryResponse = await retryPromise
    expect(retryResponse.status()).toBe(201)
    expect(((await retryResponse.json()) as { id: string }).id).toBe(serverPaymentId)
    await expect(page.getByText('Pagamento registrado.', { exact: true })).toBeVisible()
    await page.unroute('**/api/sales/*/payments')

    await page.reload()
    await expect(page.getByText(/Pago/)).toBeVisible()
    expect(page.getByRole('button', { name: 'Registrar pagamento' })).toHaveCount(0)
    const detail = await page.request.get(`/api/sales/${saleId}`)
    expect(((await detail.json()) as { payments: unknown[] }).payments).toHaveLength(1)
  })

  await test.step('troca auditavel com mesma variante', async () => {
    await page.getByLabel('Item vendido (devolver)').selectOption(variantId)
    await page.getByPlaceholder('Digite ao menos 2 letras').fill(sku)
    await page.getByLabel(new RegExp(sku)).check()
    await page.getByRole('spinbutton', { name: 'Devolver (qtd)' }).fill('1')
    await page.getByRole('spinbutton', { name: 'Entregar (qtd)' }).fill('1')
    await page.getByRole('textbox', { name: 'Motivo da troca' }).fill('Tamanho E2E')

    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/exchanges') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Registrar troca' }).click()
    const response = await responsePromise
    expect(response.status()).toBe(201)
    await expect(page.getByText('Troca registrada.', { exact: true })).toBeVisible()
    await expect(page.getByText('Tamanho E2E')).toBeVisible()
    await expect.poll(() => exchangePosts.length, { message: 'exatamente um POST de troca' }).toBe(1)

    saveIds({ saleId, variantId })
  })
})
