import { expect, test } from '@playwright/test'

const fixtures = [
  ['BARCELONA', 'Corta vento', 'Masculina', { G: 1 }],
  ['BOTAFOGO', 'I 2025', 'Masculina', { P: 1, M: 2, G: 1, GG: 1 }],
  ['BOTAFOGO', 'II 2025 ML', 'Masculina', { GG: 1 }],
  ['BRASIL', '2002 Ronaldo', 'Masculina', { M: 2, G: 1, '2GG': 2 }],
  ['BRASIL', '2006', 'Masculina', { G: 1 }],
  ['FLAMENGO', 'I 2026', 'Feminina', { G: 1 }],
  ['FLUMINENSE', 'Tricolor', 'Masculina', { '2GG': 2 }],
  ['VASCO', '2024 Preta regata', 'Masculina', { M: 1 }],
  ['VASCO', 'Branca 2026 Aline', 'Masculina', { '2GG': 1 }],
  ['BRASIL', 'I 2026', 'Infantil', { '16': 2, '20': 1, '24': 3 }],
  ['FLAMENGO', 'I 2026', 'Infantil', { '18': 1, '22': 2 }],
  ['SEM ESTOQUE', 'Produto zerado', 'Masculina', { M: 0 }],
] as const

const products = fixtures.map(([club, model, type, quantities], index) => ({
  id: `product-${index}`, club, model, description: null, hasImage: index % 2 === 0,
  totalStock: Object.values(quantities).reduce((sum: number, quantity) => sum + quantity, 0), lastMovementAt: null,
  variants: Object.entries(quantities).map(([size, stockQuantity]) => ({
    id: `variant-${index}-${size}`, type, size, sku: `SKU-${index}-${size}`, stockQuantity,
    lowStockThreshold: club === 'FLAMENGO' ? 1 : 0, salePrice: '150.00', currentCost: '80.00',
  })),
}))

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { user: { displayName: 'Gestor', role: 'manager' }, permissions: ['*'] } })
    if (url.pathname === '/api/products') {
      const params = url.searchParams
      expect(params.get('availability')).toBe('in_stock')
      let items = products.map((product) => ({ ...product, variants: product.variants.filter((variant) => variant.stockQuantity > 0
        && (!params.get('type') || variant.type === params.get('type'))
        && (!params.get('size') || variant.size === params.get('size'))) }))
        .filter((product) => product.variants.length > 0
          && (!params.get('search') || `${product.club} ${product.model} ${product.variants.map((variant) => variant.sku).join(' ')}`.toLowerCase().includes(params.get('search')!.toLowerCase()))
          && (!params.get('club') || product.club.toLowerCase().includes(params.get('club')!.toLowerCase()))
          && (params.get('image') !== 'with' || product.hasImage)
          && (params.get('image') !== 'without' || !product.hasImage))
      items = items.sort((first, second) => params.get('sort') === 'stock'
        ? first.totalStock - second.totalStock : first.club.localeCompare(second.club) || first.model.localeCompare(second.model))
      if (params.get('order') === 'desc') items.reverse()
      return route.fulfill({ json: { items, total: items.length, page: 1, limit: 20 } })
    }
    return route.fulfill({ status: 404, json: { message: 'Rota não configurada no teste.' } })
  })
})

test('grade mostra saldo por tamanho, tipo e total sem expandir', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/estoque?availability=all')
  const table = page.getByRole('table', { name: 'Grade adulta' })
  await expect(table).toBeVisible()
  const row = table.getByRole('row', { name: /BOTAFOGO I 2025 Masculina/ })
  await expect(row.getByRole('cell', { name: 'M: 2 unidades', exact: true })).toBeVisible()
  await expect(row.getByRole('cell', { name: 'Total: 5 unidades', exact: true })).toBeVisible()
  await expect(page.getByText('SEM ESTOQUE', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('table', { name: 'Grade infantil' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Expandir/ })).toHaveCount(0)
  await expect(row.getByRole('link')).toHaveAttribute('href', '/estoque/produtos/product-1')
  await expect(page.getByRole('button', { name: 'Anterior' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Próxima' })).toBeDisabled()
  expect(errors).toEqual([])
})

test('busca, filtros extras e ordenacao funcionam com totais do recorte', async ({ page }) => {
  await page.goto('/estoque')
  await page.getByRole('textbox', { name: 'Busca', exact: true }).fill('BRASIL')
  await expect(page.getByRole('textbox', { name: 'Busca', exact: true })).toBeFocused()
  await page.getByRole('combobox', { name: 'Tipo', exact: true }).selectOption('Infantil')
  await expect(page.getByRole('table', { name: 'Grade adulta' })).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Tamanho', exact: true }).fill('24')
  await expect(page.getByLabel('Unidades nesta página')).toHaveText('3')
  await expect(page.getByRole('cell', { name: 'Total: 3 unidades', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Limpar filtros' }).click()
  await expect(page).toHaveURL('/estoque')
  await page.getByRole('button', { name: /Mais filtros/ }).click()
  await page.getByRole('textbox', { name: 'Clube', exact: true }).fill('VASCO')
  await page.getByRole('combobox', { name: 'Imagem', exact: true }).selectOption('with')
  await expect(page.getByRole('table', { name: 'Grade adulta' }).getByText('Branca 2026 Aline')).toBeVisible()
  await expect(page.getByRole('table', { name: 'Grade adulta' }).getByText('2024 Preta regata')).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Ordenar por' }).selectOption('stock:desc')
  await expect(page).toHaveURL(/sort=stock&order=desc/)
  await page.getByRole('textbox', { name: 'Busca', exact: true }).fill('inexistente')
  await expect(page.getByText('Nenhum produto para estes filtros.')).toBeVisible()
  await page.getByRole('button', { name: 'Ver todos os produtos' }).click()
  await expect(page.getByRole('table', { name: 'Grade adulta' })).toBeVisible()
})

test('layout alinha controles no desktop e limita rolagem horizontal a grade no celular', async ({ page }) => {
  await page.goto('/estoque')
  await expect(page.getByRole('table', { name: 'Grade adulta' })).toBeVisible()
  const controls = await page.locator('.inventory-filter-row input, .inventory-filter-row select, .inventory-more').evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect()
    return { height: box.height, bottom: box.bottom }
  }))
  expect(new Set(controls.map((control) => control.height)).size).toBe(1)
  expect(new Set(controls.map((control) => control.bottom)).size).toBe(1)
  await page.screenshot({ path: 'e2e-artifacts/inventory-redesign-desktop.png', fullPage: true })
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const region = page.getByRole('region', { name: 'Grade adulta: role para ver todos os tamanhos', exact: true })
    await region.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    await region.evaluate((element) => { element.scrollLeft = 0 })
    await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0) })
    await page.screenshot({ path: `e2e-artifacts/inventory-redesign-${width}.png`, fullPage: true })
  }
})
