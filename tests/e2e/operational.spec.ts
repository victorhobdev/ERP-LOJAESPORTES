import { expect, test, type Page } from '@playwright/test'

const product = {
  id: '33333333-3333-4333-8333-333333333333', club: 'Flamengo', model: 'Home', totalStock: 2, hasImage: false, variants: [{
    id: '11111111-1111-4111-8111-111111111111', type: 'Masculina', size: 'M', sku: 'FLA-M',
    salePrice: '150.00', currentCost: '80.00', stockQuantity: 2, lowStockThreshold: 1,
  }],
}

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const responses: Record<string, unknown> = {
      '/api/dashboard': { date: '2026-08-30', timezone: 'America/Sao_Paulo', bases: { sales: 'sale_created_at', cash: 'payment_received_at', pending: 'current_state_as_of_request' }, salesCreatedToday: '300.00', confirmedPaymentsToday: '150.00', pendingSalesCount: 1, overdueSalesCount: 0, lowStockVariants: 1, outOfStockVariants: 0, openPurchaseOrders: 1, pendingPurchaseUnits: 3, openCustomerOrders: 1 },
      '/api/auth/session': { user: { displayName: 'Administradora E2E', username: 'admin.e2e', role: 'administrator' }, permissions: ['*'] },
      '/api/users': { items: [{ id: '66666666-6666-4666-8666-666666666666', username: 'admin.e2e', displayName: 'Administradora E2E', role: 'administrator', active: true, createdAt: '2026-08-01T10:00:00.000Z' }], total: 1, page: 1, limit: 20 },
      '/api/health/ready': { status: 'ready', service: 'erp-api', version: '0.0.0', checks: { database: 'up' }, integrations: { catalog: 'not_configured' } },
      '/api/products': { items: [product], total: 1, page: 1, limit: 50 },
      '/api/catalog': { items: [product], total: 1, page: 1, limit: 50 },
      '/api/products/33333333-3333-4333-8333-333333333333': { ...product, description: null, totalStock: 2, lastMovementAt: null },
      '/api/customers': { items: [{ id: '99999999-9999-4999-8999-999999999999', name: 'Cliente Teste', contact: null }], total: 1 },
      '/api/inventory': { items: [{ variantId: product.variants[0].id, productId: product.id, club: product.club, model: product.model, ...product.variants[0] }] },
      '/api/purchase-orders': { items: [{ id: 'po-1', supplierName: 'Fornecedor Teste', orderedOn: '2026-08-30', status: 'placed', pendingQuantity: 3, finalAmount: '240.00' }] },
      '/api/customer-orders': { items: [{ id: 'co-1', customerName: 'Cliente Teste', club: 'Brasil', model: 'Home', type: 'Infantil', size: '10', status: 'pending' }] },
      '/api/reports/financial': { period: { from: '2026-08-10', to: '2026-08-12', timezone: 'America/Sao_Paulo' }, bases: { sales: 'sale_created_at', cash: 'payment_received_at' }, salesBySaleDate: '300.00', confirmedPaymentsByReceiptDate: '150.00', outstandingForPeriodSales: '150.00', historicalCostOfPeriodSales: '160.00', grossProfitOnSalesBasis: '140.00', grossMarginPercentOnSalesBasis: '46.67', averageTicketOnSalesBasis: '150.00', inventoryCostValue: '150.00', inventoryPotentialValue: '300.00', openPurchaseCapital: '60.00', paymentsByMethod: [{ method: 'pix', amount: '150.00' }], dailySeries: [{ date: '2026-08-10', salesBySaleDate: '300.00', confirmedPaymentsByReceiptDate: '150.00' }], receivables: [], receivablesBasis: 'sales_created_in_period_with_open_balance', overdueAsOf: '2026-08-12', updatedAt: '2026-08-12T12:00:00.000Z' },
      '/api/reports/products': { period: { from: '2026-08-01', to: '2026-08-31', timezone: 'America/Sao_Paulo' }, filters: { club: null, type: null, size: null }, timezone: 'America/Sao_Paulo', bases: { sales: 'sale_created_at', stock: 'current_state_as_of_request' }, items: [{ variantId: '11111111-1111-4111-8111-111111111111', club: 'Flamengo', model: 'Home', type: 'Masculina', size: 'M', sku: 'FLA-M', unitsSold: '2', salesAmount: '300.00', historicalCost: '160.00', grossProfit: '140.00', currentStockQuantity: 2, lowStockThreshold: 1, noTurnover: false, lowStock: false }], summary: { variantCount: 1, totalUnitsSold: '2', totalSalesAmount: '300.00', totalGrossProfit: '140.00', noTurnoverCount: 0, lowStockCount: 0, salesByClub: [{ name: 'Flamengo', unitsSold: '2', salesAmount: '300.00', sharePercent: '100.00' }], salesByType: [{ name: 'Masculina', unitsSold: '2', salesAmount: '300.00', sharePercent: '100.00' }], salesBySize: [{ name: 'M', unitsSold: '2', salesAmount: '300.00', sharePercent: '100.00' }] }, updatedAt: '2026-08-31T12:00:00.000Z', stockAsOf: '2026-08-31T12:00:00.000Z' },
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

test('pending sale rejects past due date before any submission', async ({ page }) => {
  let salePosts = 0
  page.on('request', (request) => {
    if (request.url().endsWith('/api/sales') && request.method() === 'POST') salePosts += 1
  })
  await page.goto('/vendas/nova')
  await page.getByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' }).click()
  await page.getByRole('radio', { name: 'Pendente' }).click()
  await page.getByPlaceholder('Digite ao menos 2 letras').fill('Cliente')
  await page.getByRole('radio', { name: /Cliente/ }).first().click()
  await page.getByLabel('Vencimento').fill('2020-01-01')
  await page.getByRole('button', { name: 'Finalizar venda' }).click()
  await expect(page.getByText('O vencimento deve ser uma data futura.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Finalizar venda' })).toBeVisible()
  expect(salePosts).toBe(0)
})

test('dashboard work queue reaches existing routes without placeholder screens', async ({ page }) => {
  await page.goto('/inicio')
  for (const [name, url, heading] of [
    [/Vendas em aberto/, '/vendas?status=open', 'Vendas'],
    [/Estoque baixo ou zerado/, '/estoque?availability=low', 'Estoque'],
    [/Compras abertas/, '/compras', 'Compras de fornecedores'],
    [/Encomendas em aberto/, '/encomendas', 'Encomendas de clientes'],
  ] as const) {
    await page.goto('/inicio')
    await page.getByRole('link', { name }).click()
    await expect(page).toHaveURL(url)
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
  }
})

test('catalog renders only in-stock products with a compact card and stock drilldown', async ({ page }) => {
  await page.goto('/catalogo')
  await expect(page.getByRole('heading', { name: 'Catálogo', exact: true })).toBeVisible()
  await expect(page.getByText('Flamengo')).toBeVisible()
  await expect(page.locator('.catalog-card-media > small', { hasText: 'Sem imagem' })).toBeVisible()
  await expect(page.getByText('2 unid. em estoque · 1 tam.')).toBeVisible()
  await expect(page).toHaveURL('/catalogo')
  await expect(page.getByRole('button', { name: 'Sincronizar catálogo' })).toBeVisible()
  const detail = page.getByRole('link', { name: 'Abrir estoque' })
  await expect(detail).toHaveAttribute('href', '/estoque/produtos/33333333-3333-4333-8333-333333333333')
  await detail.click()
  await expect(page.getByRole('heading', { name: 'Flamengo · Home' })).toBeVisible()
  await expect(page.getByText('Fundação em construção')).toHaveCount(0)
})

test('settings shows profile and admin user directory without placeholder screens', async ({ page }) => {
  await page.goto('/configuracoes')
  await expect(page.getByRole('heading', { name: 'Configurações' })).toBeVisible()
  await expect(page.getByText('Administradora E2E').first()).toBeVisible()
  await expect(page.getByText('Perfil: Administrador')).toBeVisible()
  await expect(page.getByText('Usuários (1)')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'admin.e2e' })).toBeVisible()
  await expect(page.getByText('Status operacional')).toBeVisible()
  await expect(page.getByText('Versão: 0.0.0')).toBeVisible()
  await expect(page.getByText('API: pronta')).toBeVisible()
  await expect(page.getByText('Banco de dados: em operação')).toBeVisible()
  await expect(page.getByText('Catálogo externo: não configurado')).toBeVisible()
  await expect(page.getByText('Fundação em construção')).toHaveCount(0)
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
