import { expect, test, type Page } from '@playwright/test'

const product = {
  id: 'product-1', club: 'Flamengo', model: 'Home', variants: [{
    id: '11111111-1111-4111-8111-111111111111', type: 'Masculina', size: 'M', sku: 'FLA-M',
    salePrice: '150.00', currentCost: '80.00', stockQuantity: 2, lowStockThreshold: 1,
  }],
}

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const responses: Record<string, unknown> = {
      '/api/dashboard': { date: '2026-08-30', timezone: 'America/Sao_Paulo', salesCreatedToday: '300.00', confirmedPaymentsToday: '150.00', pendingSalesCount: 1, overdueSalesCount: 0, lowStockVariants: 1, outOfStockVariants: 0, openPurchaseOrders: 1, pendingPurchaseUnits: 3, openCustomerOrders: 1 },
      '/api/products': { items: [product] },
      '/api/inventory': { items: [{ variantId: product.variants[0].id, productId: product.id, club: product.club, model: product.model, ...product.variants[0] }] },
      '/api/purchase-orders': { items: [{ id: 'po-1', supplierName: 'Fornecedor Teste', orderedOn: '2026-08-30', status: 'placed', pendingQuantity: 3, finalAmount: '240.00' }] },
      '/api/customer-orders': { items: [{ id: 'co-1', customerName: 'Cliente Teste', club: 'Brasil', model: 'Home', type: 'Infantil', size: '10', status: 'pending' }] },
      '/api/reports/financial': { salesBySaleDate: '300.00', confirmedPaymentsByReceiptDate: '150.00', outstandingForPeriodSales: '150.00', grossProfitOnSalesBasis: '140.00', grossMarginPercentOnSalesBasis: '46.67' },
      '/api/reports/products': { items: [{ club: 'Flamengo', model: 'Home', type: 'Masculina', size: 'M', unitsSold: 2, salesAmount: '300.00', grossProfit: '140.00', currentStockQuantity: 2 }] },
    }
    if (path === '/api/sales' && route.request().method() === 'POST') return route.fulfill({ status: 201, json: { id: 'sale-1', status: 'paid', finalAmount: '150.00' } })
    const exact = responses[path]
    const prefix = Object.entries(responses).find(([key]) => path.startsWith(key))?.[1]
    await route.fulfill({ status: exact ?? prefix ? 200 : 404, json: exact ?? prefix ?? { message: 'Not found' } })
  })
}

test.beforeEach(async ({ page }) => mockApi(page))

test('dashboard and navigation are keyboard reachable at the target viewport', async ({ page }) => {
  await page.goto('/inicio')
  await expect(page.getByRole('heading', { name: 'Visão da operação' })).toBeVisible()
  await expect(page.getByText('R$ 150,00')).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Pular para o conteúdo' })).toBeFocused()
  await expect(page.getByRole('navigation', { name: 'Navegação principal' })).toBeVisible()
})

test('paid sale remains one submission and clears its cart after confirmation', async ({ page }) => {
  await page.goto('/vendas/nova')
  await page.getByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' }).click()
  await expect(page.getByRole('complementary', { name: 'Carrinho da venda' })).toContainText('FLA-M')
  const requestPromise = page.waitForRequest((request) => request.url().endsWith('/api/sales') && request.method() === 'POST')
  await page.getByRole('button', { name: 'Finalizar venda' }).click()
  const request = await requestPromise
  expect(request.headers()['idempotency-key']).toBeTruthy()
  expect(request.postDataJSON()).toMatchObject({ discountAmount: '0.00', payment: { amount: '150.00', method: 'pix' } })
  await expect(page.getByText('Venda concluída')).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Carrinho da venda' })).not.toContainText('FLA-M')
})

test('operational lists and reconciled reports render without placeholder screens', async ({ page }) => {
  for (const [path, heading] of [
    ['/estoque', 'Estoque'], ['/compras', 'Compras de fornecedores'], ['/encomendas', 'Encomendas de clientes'],
    ['/relatorios/financeiro', 'Relatório financeiro'], ['/relatorios/produtos', 'Relatório de produtos'],
  ] as const) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    await expect(page.getByText('Fundação em construção')).toHaveCount(0)
  }
})
