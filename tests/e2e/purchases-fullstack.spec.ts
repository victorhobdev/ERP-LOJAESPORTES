import { appendFileSync, mkdirSync } from 'node:fs'

import { expect, test } from '@playwright/test'

const enabled = process.env['E2E_FULLSTACK'] === '1'
test.skip(!enabled, 'Full-stack de compras exige E2E_FULLSTACK=1 com API e PostgreSQL de teste.')

const username = process.env['E2E_USERNAME'] ?? ''
const password = process.env['E2E_PASSWORD'] ?? ''
const tag = process.env['E2E_TAG'] ?? ''
const variantId = process.env['E2E_VARIANT_ID'] ?? ''
const idsFile = process.env['E2E_PURCHASES_IDS_FILE'] ?? 'e2e-artifacts/purchases-fullstack-ids.json'

const supplierName = `Fornecedor E2E ${tag}`
const sku = `ECP-M-${tag}`

function saveIds(ids: Record<string, string>) {
  mkdirSync('e2e-artifacts', { recursive: true })
  appendFileSync(idsFile, `${JSON.stringify(ids)}\n`)
}

test('compras full-stack: pedido, detalhe, dois recebimentos e replay unico', async ({ page }) => {
  expect(username, 'E2E_USERNAME sintético').not.toBe('')
  expect(tag, 'E2E_TAG sintética').not.toBe('')

  await test.step('login real contra a API', async () => {
    await page.goto('/login')
    await page.getByRole('textbox', { name: 'Usuário' }).fill(username)
    await page.getByLabel('Senha', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Entrar' }).click()
    await page.waitForURL('**/inicio')
  })

  const orderId = await test.step('criar pedido com selecao legivel', async () => {
    await page.goto('/compras/nova')
    await page.getByPlaceholder('Digite ao menos 2 letras').fill(`Fornecedor E2E ${tag}`)
    await page.getByRole('radio', { name: supplierName }).check()
    await page.getByPlaceholder('Clube, modelo ou SKU').fill(sku)
    await page.getByRole('checkbox', { name: new RegExp(sku) }).check()
    await page.getByRole('spinbutton', { name: 'Quantidade' }).fill('4')
    await page.getByRole('textbox', { name: 'Custo unitário' }).fill('50.00')
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/purchase-orders') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Criar pedido' }).click()
    const response = await responsePromise
    expect(response.status()).toBe(201)
    const order = (await response.json()) as { id: string; status: string; finalAmount: string }
    expect(order.status).toBe('placed')
    expect(order.finalAmount).toBe('200.00')
    await expect(page.getByText('Pedido criado.', { exact: true })).toBeVisible()
    return order.id
  })

  await test.step('detalhe com itens e historico', async () => {
    await page.goto(`/compras?status=placed`)
    await expect(page.getByRole('link', { name: new RegExp(supplierName) }).first()).toHaveAttribute('href', `/compras/${orderId}`)
    await page.goto(`/compras/${orderId}`)
    await expect(page.getByRole('heading', { name: `Pedido ${orderId.slice(0, 8)}` })).toBeVisible()
    await expect(page.getByText(supplierName).first()).toBeVisible()
    await expect(page.getByText('Nenhum recebimento registrado.')).toBeVisible()
  })

  await test.step('recebimento parcial com resposta perdida e unico', async () => {
    await page.getByRole('spinbutton', { name: /Receber item/ }).fill('1')

    let interceptedOnce = false
    let serverReceiptId = ''
    await page.route('**/api/purchase-orders/*/receipts', async (route) => {
      if (route.request().method() !== 'POST' || interceptedOnce) return route.continue()
      interceptedOnce = true
      const serverResponse = await route.fetch()
      expect(serverResponse.status()).toBe(201)
      serverReceiptId = ((await serverResponse.json()) as { id: string }).id
      return route.abort('connectionaborted')
    })

    await page.getByRole('button', { name: 'Registrar recebimento' }).click()
    await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible()

    const retryPromise = page.waitForResponse((response) => response.url().includes('/receipts') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Tentar novamente' }).click()
    const retryResponse = await retryPromise
    expect(retryResponse.status()).toBe(201)
    expect(((await retryResponse.json()) as { id: string }).id).toBe(serverReceiptId)
    await expect(page.getByText('Recebimento registrado.', { exact: true })).toBeVisible()
    await page.unroute('**/api/purchase-orders/*/receipts')

    const history = await page.request.get(`/api/purchase-orders/${orderId}`)
    const detail = (await history.json()) as { status: string; receipts: unknown[] }
    expect(detail.status).toBe('partially_received')
    expect(detail.receipts).toHaveLength(1)
  })

  await test.step('recebimento integral conclui o pedido', async () => {
    await page.getByRole('spinbutton', { name: /Receber item/ }).fill('3')
    const responsePromise = page.waitForResponse((response) => response.url().includes('/receipts') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Registrar recebimento' }).click()
    const response = await responsePromise
    expect(response.status()).toBe(201)
    expect(((await response.json()) as { status: string }).status).toBe('fully_received')
    await expect(page.getByText(/totalmente recebido/)).toBeVisible()

    saveIds({ orderId, variantId })
  })
})
