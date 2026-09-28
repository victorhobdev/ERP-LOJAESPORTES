import { appendFileSync, mkdirSync } from 'node:fs'

import { expect, test } from '@playwright/test'
import { openOperationalApp } from './operational-app.js'

const enabled = process.env['E2E_FULLSTACK'] === '1'
test.skip(!enabled, 'Full-stack pago exige E2E_FULLSTACK=1 com API e PostgreSQL de teste.')

const club = process.env['E2E_CLUB'] ?? ''
const model = process.env['E2E_MODEL'] ?? ''
const variantId = process.env['E2E_VARIANT_ID'] ?? ''
const sku = process.env['E2E_SKU'] ?? ''
const idsFile = process.env['E2E_IDS_FILE'] ?? 'e2e-artifacts/paid-sale-fullstack-ids.json'

type SaleDetail = {
  id: string
  status: string
  subtotalAmount: string
  discountAmount: string
  finalAmount: string
  amountDue: string
  items: Array<{ variantId: string; quantity: number; unitPrice: string; unitCost: string }>
  payments: Array<{ id: string; amount: string; method: string; status: string }>
}

function saveIds(ids: Record<string, string>) {
  mkdirSync('e2e-artifacts', { recursive: true })
  appendFileSync(idsFile, `${JSON.stringify(ids)}\n`)
}

test('venda paga full-stack: venda, persistencia e retentativa sem duplicar', async ({ page }) => {
  expect(variantId, 'E2E_VARIANT_ID sintético').not.toBe('')
  expect(sku, 'E2E_SKU sintético').not.toBe('')

  await test.step('abre o painel operacional', async () => {
    await openOperationalApp(page)
  })

  const addButton = (size = 'M') => page.getByRole('button', { name: `Adicionar ${club} ${model}, tamanho ${size}` })

  const firstSaleId = await test.step('venda paga com efeito persistido', async () => {
    await page.goto('/vendas/nova')
    await page.getByPlaceholder('Clube, modelo ou SKU').fill(sku)
    await addButton().click()
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/sales') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Finalizar venda' }).click()
    const response = await responsePromise
    expect(response.status()).toBe(201)
    const sale = (await response.json()) as { id: string; status: string; finalAmount: string }
    expect(sale.status).toBe('paid')
    expect(sale.finalAmount).toBe('150.00')
    await expect(page.getByText('Venda concluída')).toBeVisible()

    const detailResponse = await page.request.get(`/api/sales/${sale.id}`)
    expect(detailResponse.status()).toBe(200)
    const detail = (await detailResponse.json()) as SaleDetail
    expect(detail).toMatchObject({ status: 'paid', finalAmount: '150.00', amountDue: '0.00' })
    expect(detail.items).toHaveLength(1)
    expect(detail.items[0]).toMatchObject({ variantId, quantity: 1, unitPrice: '150.00', unitCost: '80.00' })
    expect(detail.payments).toHaveLength(1)
    expect(detail.payments[0]).toMatchObject({ amount: '150.00', method: 'pix', status: 'confirmed' })

    const inventoryResponse = await page.request.get(`/api/inventory?search=${encodeURIComponent(sku)}`)
    expect(inventoryResponse.status()).toBe(200)
    const inventory = (await inventoryResponse.json()) as { items: Array<{ variantId: string; stockQuantity: number }> }
    expect(inventory.items.find((item) => item.variantId === variantId)?.stockQuantity).toBe(4)
    return sale.id
  })

  await test.step('retentativa apos resposta perdida nao duplica', async () => {
    await page.goto('/vendas/nova')
    await page.getByPlaceholder('Clube, modelo ou SKU').fill(sku)
    await addButton().click()

    let serverSaleId = ''
    let interceptedOnce = false
    await page.route('**/api/sales', async (route) => {
      if (route.request().method() !== 'POST' || interceptedOnce) return route.continue()
      interceptedOnce = true
      const serverResponse = await route.fetch()
      expect(serverResponse.status()).toBe(201)
      serverSaleId = ((await serverResponse.json()) as { id: string }).id
      return route.abort('connectionaborted')
    })

    await page.getByRole('button', { name: 'Finalizar venda' }).click()
    await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible()
    await expect(addButton()).toBeDisabled()

    await test.step('recarga preserva a operacao incerta', async () => {
      await page.reload()
      await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible()
      await expect(page.getByPlaceholder('Clube, modelo ou SKU')).toBeDisabled()
      const visibleAddButtons = page.getByRole('button', { name: /^Adicionar / })
      await expect(visibleAddButtons.first()).toBeVisible()
      for (const button of await visibleAddButtons.all()) await expect(button).toBeDisabled()
      await expect(page.getByRole('complementary', { name: 'Carrinho da venda' })).toContainText('E2E-M-')
    })

    const retryPromise = page.waitForResponse((response) => response.url().endsWith('/api/sales') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Tentar novamente' }).click()
    const retryResponse = await retryPromise
    expect(retryResponse.status()).toBe(201)
    const retrySale = (await retryResponse.json()) as { id: string; status: string; finalAmount: string }
    expect(retrySale.id).toBe(serverSaleId)
    await expect(page.getByText('Venda concluída')).toBeVisible()
    await page.unroute('**/api/sales')

    const detailResponse = await page.request.get(`/api/sales/${retrySale.id}`)
    const detail = (await detailResponse.json()) as SaleDetail
    expect(detail.payments).toHaveLength(1)
    expect(detail).toMatchObject({ status: 'paid', finalAmount: '150.00', amountDue: '0.00' })

    const inventoryResponse = await page.request.get(`/api/inventory?search=${encodeURIComponent(sku)}`)
    const inventory = (await inventoryResponse.json()) as { items: Array<{ variantId: string; stockQuantity: number }> }
    expect(inventory.items.find((item) => item.variantId === variantId)?.stockQuantity).toBe(3)

    const salesResponse = await page.request.get('/api/sales?limit=100')
    const sales = (await salesResponse.json()) as { items: Array<{ id: string }> }
    expect(sales.items.filter((item) => item.id === retrySale.id)).toHaveLength(1)
    expect(retrySale.id).not.toBe(firstSaleId)

    saveIds({ saleId: firstSaleId, retrySaleId: retrySale.id, firstServerSaleId: serverSaleId })
  })
})
