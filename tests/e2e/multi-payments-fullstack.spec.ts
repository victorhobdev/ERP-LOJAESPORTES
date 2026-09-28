import { appendFileSync, mkdirSync } from 'node:fs'

import { expect, test } from '@playwright/test'
import { openOperationalApp } from './operational-app.js'

const enabled = process.env['E2E_FULLSTACK'] === '1'
test.skip(!enabled, 'Full-stack de pagamentos exige E2E_FULLSTACK=1 com API e PostgreSQL de teste.')
test.describe.configure({ retries: 0 })

const saleId = process.env['E2E_SALE_ID'] ?? ''
const idsFile = process.env['E2E_MULTI_PAYMENTS_IDS_FILE'] ?? 'e2e-artifacts/multi-payments-fullstack-ids.json'

function saveIds(ids: Record<string, string>) {
  mkdirSync('e2e-artifacts', { recursive: true })
  appendFileSync(idsFile, `${JSON.stringify(ids)}\n`)
}

test('vendas full-stack: dois pagamentos sequenciais sem duplicar efeitos', async ({ page }) => {
  expect(saleId, 'E2E_SALE_ID sintético').not.toBe('')

  await test.step('abre o painel operacional', async () => {
    await openOperationalApp(page)
  })

  const firstId = await test.step('primeiro pagamento parcial com resposta perdida', async () => {
    await page.goto(`/vendas/${saleId}`)
    await expect(page.getByRole('heading', { name: `Venda ${saleId.slice(0, 8)}` })).toBeVisible()
    await page.getByRole('textbox', { name: 'Valor' }).fill('90.00')

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

    const firstAttemptPromise = page.waitForRequest((request) => request.url().includes('/api/sales/') && request.url().endsWith('/payments') && request.method() === 'POST')
    await page.getByRole('button', { name: 'Registrar pagamento' }).click()
    const firstAttempt = await firstAttemptPromise
    await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible()

    const retryPromise = page.waitForResponse((response) => response.url().includes('/api/sales/') && response.url().endsWith('/payments') && response.request().method() === 'POST')
    const retryRequestPromise = page.waitForRequest((request) => request.url().includes('/api/sales/') && request.url().endsWith('/payments') && request.method() === 'POST')
    await page.getByRole('button', { name: 'Tentar novamente' }).click()
    const retryResponse = await retryPromise
    const retryRequest = await retryRequestPromise
    expect(retryResponse.status()).toBe(201)
    expect(((await retryResponse.json()) as { id: string }).id).toBe(serverPaymentId)
    expect(retryRequest.headers()['idempotency-key']).toBe(firstAttempt.headers()['idempotency-key'])
    expect(retryRequest.postData()).toBe(firstAttempt.postData())
    await expect(page.getByText('Pagamento registrado.', { exact: true })).toBeVisible()
    await page.unroute('**/api/sales/*/payments')
    return serverPaymentId
  })

  await test.step('segundo pagamento quita com nova chave', async () => {
    const paymentsSection = page.locator('section[aria-label="Pagamentos"]')
    await expect(page.getByText(/saldo devido.*60,00/)).toBeVisible()
    await expect(paymentsSection.locator('tbody tr')).toHaveCount(1)
    await expect(paymentsSection.getByText(/90,00/)).toBeVisible()
    const detail = await page.request.get(`/api/sales/${saleId}`)
    const partial = (await detail.json()) as { status: string; amountDue: string; payments: Array<{ id: string; amount: string }> }
    expect(partial.status).toBe('partially_paid')
    expect(partial.amountDue).toBe('60.00')
    expect(partial.payments.map((payment) => payment.id)).toEqual([firstId])

    await page.getByRole('textbox', { name: 'Valor' }).fill('60.00')
    const responsePromise = page.waitForResponse((response) => response.url().includes('/api/sales/') && response.url().endsWith('/payments') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Registrar pagamento' }).click()
    const response = await responsePromise
    expect(response.status()).toBe(201)
    const second = (await response.json()) as { id: string; status: string; amountDue: string }
    expect(second.status).toBe('paid')
    expect(second.amountDue).toBe('0.00')
    expect(second.id).not.toBe(firstId)
    await expect(page.getByText('Pagamento registrado.', { exact: true })).toBeVisible()

    const paidSection = page.locator('section[aria-label="Pagamentos"]')
    await expect(paidSection.locator('tbody tr')).toHaveCount(2)
    await expect(page.getByText(/saldo devido.*0,00/)).toBeVisible()
    await expect(page.getByText(/Pago/)).toBeVisible()

    const final = await page.request.get(`/api/sales/${saleId}`)
    const paid = (await final.json()) as { status: string; amountDue: string; payments: Array<{ id: string; amount: string; status: string }> }
    expect(paid.status).toBe('paid')
    expect(paid.amountDue).toBe('0.00')
    expect(paid.payments).toHaveLength(2)
    expect(paid.payments.map((payment) => payment.amount).sort()).toEqual(['60.00', '90.00'])

    saveIds({ saleId })
  })
})
