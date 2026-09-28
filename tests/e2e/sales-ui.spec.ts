import path from 'node:path'

import { expect, test } from '@playwright/test'

const shirts = [
  ['Barcelona Corta vento', 'BARCELONA_CORTA_VENTO_MASCULINO.jpg'],
  ['Argentina Kit preto', 'ARGENTINA_KIT_PRETO_MASCULINO.jpg'],
  ['Atlético Mineiro Treino 2025', 'ATLETICO_MINEIRO_TREINO_2025_MASCULINO.jpg'],
] as const
const sales = Array.from({ length: 16 }, (_, index) => ({
  id: `sale-${index}`, customerId: null, customerName: ['Mariana Oliveira', 'Cliente Consumidor', 'Rafael Santos', 'Joana Souza'][index % 4],
  productSummary: shirts.slice(0, index % 3 + 1).map(([label]) => `${label} ×1`).join(' · '),
  productPreviews: shirts.slice(0, index % 3 + 1).map(([label], shirt) => ({ productId: `p-${shirt}`, label, mediaId: `m-${shirt}` })),
  status: ['paid', 'pending', 'partially_paid', 'reversed'][index % 4],
  createdAt: '2026-09-05T14:00:00.000Z', finalAmount: '150.00', amountDue: index % 4 === 1 ? '150.00' : index % 4 === 2 ? '50.00' : '0.00',
}))

test.beforeEach(async ({ page }) => {
  await page.route('**/api/sales?*', async (route) => {
    const status = new URL(route.request().url()).searchParams.get('status')
    const items = sales.filter((sale) => !status || (status === 'open' ? ['pending', 'partially_paid'].includes(sale.status!) : sale.status === status))
    await route.fulfill({ json: { items, total: items.length, page: 1, limit: 20 } })
  })
  await page.route('**/api/catalog/media/*', async (route) => {
    const index = Number(route.request().url().split('m-').at(-1))
    const shirt = shirts[index]
    if (!shirt) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ contentType: 'image/jpeg', path: path.resolve('data/catalogo/imagens', shirt[1]) })
  })
})

test('sales list fits ten readable rows with up to three images and supports mobile widths', async ({ page }) => {
  await page.setViewportSize({ width: 1880, height: 920 })
  await page.goto('/vendas')
  const table = page.getByRole('table', { name: 'Vendas', exact: true })
  await expect(table).toBeVisible()
  const rows = table.locator('tbody tr')
  await expect(rows).toHaveCount(16)
  await expect(rows.nth(2).getByRole('img')).toHaveCount(3)
  expect(await rows.evaluateAll((elements) => elements.filter((element) => {
    const rect = element.getBoundingClientRect()
    return rect.top >= 0 && rect.bottom <= window.innerHeight
  }).length)).toBe(10)
  await expect.poll(() => rows.nth(2).locator('img').evaluateAll((elements) =>
    elements.every((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0))).toBe(true)
  await rows.nth(2).locator('img').evaluateAll((elements) => Promise.all(elements.map((element) => (element as HTMLImageElement).decode())))
  await page.screenshot({ path: 'e2e-artifacts/sales-dense-1880.png' })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.screenshot({ path: 'e2e-artifacts/sales-dense-1366.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'e2e-artifacts/sales-dense-390.png' })
})

test('A receber groups pending and partial sales with clear filter buttons', async ({ page }) => {
  await page.goto('/vendas?status=pending')
  await expect(page).toHaveURL('/vendas?status=open')
  await expect(page.getByRole('button', { name: 'A receber' })).toHaveAttribute('aria-pressed', 'true')
  const rows = page.getByRole('table', { name: 'Vendas', exact: true }).locator('tbody tr')
  await expect(rows).toHaveCount(8)
  await expect(page.getByText('Pendente', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Parcial', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Pago', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Pagas', exact: true }).click()
  await expect(rows).toHaveCount(4)
  await page.getByRole('button', { name: 'Todas', exact: true }).click()
  await expect(page).toHaveURL('/vendas')
  await expect(rows).toHaveCount(16)
})

test('missing or broken photos use a shirt icon without extra text', async ({ page }) => {
  await page.route('**/api/sales?*', (route) => route.fulfill({ json: { items: [{ ...sales[0], productPreviews: [
    { productId: 'p1', label: 'Sem foto cadastrada', mediaId: null },
    { productId: 'p2', label: 'Foto indisponível', mediaId: 'broken' },
    { productId: 'p3', label: 'Barcelona Corta vento', mediaId: 'm-0' },
    { productId: 'p4', label: 'Quarta imagem', mediaId: 'm-1' },
  ] }], total: 1, page: 1, limit: 20 } }))
  await page.goto('/vendas')
  await expect(page.getByRole('img', { name: 'Foto indisponível: sem imagem' })).toBeVisible()
  await expect(page.getByRole('img')).toHaveCount(3)
  await expect(page.getByText('Foto indisponível', { exact: true })).toHaveCount(0)
})
