import { appendFileSync, mkdirSync } from 'node:fs'

import { expect, test } from '@playwright/test'
import { openOperationalApp } from './operational-app.js'

const enabled = process.env['E2E_FULLSTACK'] === '1'
test.skip(!enabled, 'Full-stack de estoque exige E2E_FULLSTACK=1 com API e PostgreSQL de teste.')

const tag = process.env['E2E_TAG'] ?? ''
const idsFile = process.env['E2E_INVENTORY_IDS_FILE'] ?? 'e2e-artifacts/inventory-fullstack-ids.json'

const club = 'E2E Estoque'
const model = `Modelo ${tag}`
const sku = `EST-M-${tag}`

function saveIds(ids: Record<string, string>) {
  mkdirSync('e2e-artifacts', { recursive: true })
  appendFileSync(idsFile, `${JSON.stringify(ids)}\n`)
}

test('estoque full-stack: cadastro, entrada, historico, filtros, edicao e retry unico', async ({ page }) => {
  expect(tag, 'E2E_TAG sintética').not.toBe('')
  expect(page.viewportSize()).toEqual({ width: 1366, height: 768 })

  await test.step('abre o painel operacional', async () => {
    await openOperationalApp(page)
  })

  const created = await test.step('cadastrar produto com variante', async () => {
    await page.goto('/estoque')
    await page.getByRole('button', { name: 'Novo produto' }).click()
    const form = page.getByRole('region', { name: 'Novo produto' })
    await form.getByRole('textbox', { name: 'Clube' }).fill(club)
    await form.getByRole('textbox', { name: 'Modelo' }).fill(model)
    await form.getByRole('textbox', { name: 'Tamanho' }).fill('M')
    await form.getByRole('textbox', { name: 'SKU' }).fill(sku)
    await form.getByRole('textbox', { name: 'Preço' }).fill('200.00')
    await form.getByRole('textbox', { name: 'Custo' }).fill('100.00')
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/products') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Cadastrar produto' }).click()
    const response = await responsePromise
    expect(response.status()).toBe(201)
    const product = (await response.json()) as { id: string; variants: Array<{ id: string }> }
    expect(product.variants).toHaveLength(1)
    await expect(page.getByText('Produto cadastrado com saldo zero; registre a entrada.')).toBeVisible()
    return product
  })
  const variantId = created.variants[0]!.id

  await test.step('produto zerado nao aparece no estoque', async () => {
    await page.goto(`/estoque?search=${encodeURIComponent(sku)}`)
    await expect(page.getByText('Nenhum produto para estes filtros.')).toBeVisible()
    await expect(page.getByRole('table')).toHaveCount(0)
  })

  await test.step('entrada de estoque com seletor pesquisavel', async () => {
    await page.goto('/estoque/entrada')
    await page.getByPlaceholder('Digite ao menos 2 letras').fill(sku)
    await page.getByLabel(new RegExp(sku)).check()
    await page.getByRole('spinbutton', { name: /Quantidade/ }).fill('5')
    await page.getByRole('textbox', { name: /Motivo/ }).fill('Contagem inicial E2E')
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/inventory/movements') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Registrar ajuste' }).click()
    const response = await responsePromise
    expect(response.status()).toBe(201)
    await expect(page.getByText('Ajuste registrado. Saldo atual: 5.')).toBeVisible()
  })

  await test.step('grade por tamanho em desktop e largura estreita', async () => {
    await page.goto(`/estoque?search=${encodeURIComponent(sku)}`)
    await expect(page.getByRole('table', { name: 'Grade adulta' })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'M: 5 unidades', exact: true })).toBeVisible()
    await page.screenshot({ path: 'e2e-artifacts/inventory-1366.png' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: 'e2e-artifacts/inventory-390.png' })
    await page.setViewportSize({ width: 1366, height: 768 })
  })

  await test.step('detalhe, historico, filtros e edicao', async () => {
    await page.goto(`/estoque/produtos/${created.id}`)
    await expect(page.getByRole('heading', { name: `${club} · ${model}` })).toBeVisible()
    await expect(page.getByText('Ajuste manual')).toBeVisible()
    await expect(page.getByText('+5')).toBeVisible()
    await expect(page.getByText('Contagem inicial E2E')).toBeVisible()

    await page.goto(`/estoque?search=${encodeURIComponent(sku)}`)
    await expect(page.getByRole('row', { name: new RegExp(`${club} ${model} Masculina`) })).toBeVisible()
    expect(page.url()).toContain(`search=${encodeURIComponent(sku)}`)
    await expect(page.getByRole('cell', { name: 'M: 5 unidades', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: `Ver detalhes de ${club} ${model}, Masculina` })).toHaveAttribute('href', `/estoque/produtos/${created.id}`)

    await page.goto(`/estoque/produtos/${created.id}`)
    await page.getByRole('textbox', { name: 'Descrição' }).fill('Descricao E2E auditada')
    await page.getByRole('button', { name: 'Salvar alterações' }).click()
    await expect(page.getByText('Produto atualizado.')).toBeVisible()
    await page.reload()
    await expect(page.getByText('Descricao E2E auditada')).toBeVisible()
  })

  await test.step('resposta perdida no ajuste gera um unico efeito', async () => {
    await page.goto('/estoque/entrada')
    await page.getByPlaceholder('Digite ao menos 2 letras').fill(sku)
    await page.getByLabel(new RegExp(sku)).check()
    await page.getByRole('spinbutton', { name: /Quantidade/ }).fill('3')
    await page.getByRole('textbox', { name: /Motivo/ }).fill('Retry E2E')

    let interceptedOnce = false
    await page.route('**/api/inventory/movements', async (route) => {
      if (route.request().method() !== 'POST' || interceptedOnce) return route.continue()
      interceptedOnce = true
      const serverResponse = await route.fetch()
      expect(serverResponse.status()).toBe(201)
      return route.abort('connectionaborted')
    })

    await page.getByRole('button', { name: 'Registrar ajuste' }).click()
    await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible()

    const retryPromise = page.waitForResponse((response) => response.url().endsWith('/api/inventory/movements') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Tentar novamente' }).click()
    const retryResponse = await retryPromise
    expect(retryResponse.status()).toBe(201)
    await expect(page.getByText('Ajuste registrado. Saldo atual: 8.')).toBeVisible()
    await page.unroute('**/api/inventory/movements')

    const history = await page.request.get(`/api/inventory/movements?variantId=${variantId}`)
    expect(history.status()).toBe(200)
    const movements = (await history.json()) as { items: Array<{ quantityDelta: number }> }
    expect(movements.items).toHaveLength(2)
    expect(movements.items.reduce((sum, item) => sum + item.quantityDelta, 0)).toBe(8)

    saveIds({ productId: created.id, variantId })
  })
})
