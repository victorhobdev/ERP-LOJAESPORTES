import { appendFileSync, mkdirSync } from 'node:fs'

import { expect, test } from '@playwright/test'

const enabled = process.env['E2E_FULLSTACK'] === '1'
test.skip(!enabled, 'Full-stack de criacao exige E2E_FULLSTACK=1 com API e PostgreSQL de teste.')

const username = process.env['E2E_USERNAME'] ?? ''
const password = process.env['E2E_PASSWORD'] ?? ''
const tag = process.env['E2E_TAG'] ?? ''
const idsFile = process.env['E2E_SALE_CREATION_IDS_FILE'] ?? 'e2e-artifacts/sale-creation-fullstack-ids.json'

const club = 'E2E Vendas FC'
const model = `Modelo ${tag}`
const sku = `EVN-M-${tag}`

/** Data futura (30 dias) em YYYY-MM-DD, computada na execucao para nao virar bomba-relogio. */
function futureDueDate(): string {
  const d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function saveIds(ids: Record<string, string>) {
  mkdirSync('e2e-artifacts', { recursive: true })
  appendFileSync(idsFile, `${JSON.stringify(ids)}\n`)
}

test('criacao full-stack: pendente e parcial sem duplicar efeitos', async ({ page }) => {
  expect(username, 'E2E_USERNAME sintético').not.toBe('')
  expect(tag, 'E2E_TAG sintética').not.toBe('')

  await test.step('login real contra a API', async () => {
    await page.goto('/login')
    await page.getByRole('textbox', { name: 'Usuário' }).fill(username)
    await page.getByLabel('Senha', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Entrar' }).click()
    await page.waitForURL('**/inicio')
  })

  const addButton = page.getByRole('button', { name: `Adicionar ${club} ${model}, tamanho M` })

  const pendingId = await test.step('venda pendente com cliente e vencimento', async () => {
    await page.goto('/vendas/nova')
    await page.getByPlaceholder('Clube, modelo ou SKU').fill(sku)
    await addButton.click()
    await page.getByRole('radio', { name: 'Pendente' }).check()
    await page.getByPlaceholder('Digite ao menos 2 letras').fill(`Cliente E2E ${tag}`)
    await page.getByRole('radio', { name: /Cliente E2E/ }).check()
    await page.getByLabel('Vencimento').fill(futureDueDate())
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/sales') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Finalizar venda' }).click()
    const response = await responsePromise
    expect(response.status()).toBe(201)
    const sale = (await response.json()) as { id: string; status: string }
    expect(sale.status).toBe('pending')
    await expect(page.getByText('Venda concluída', { exact: true })).toBeVisible()
    return sale.id
  })

  const partialId = await test.step('venda parcial com entrada validada em centavos', async () => {
    await page.getByPlaceholder('Clube, modelo ou SKU').fill(sku)
    await addButton.click()
    await page.getByRole('radio', { name: 'Parcialmente pago' }).check()
    await page.getByLabel('Valor inicial').fill('60.00')
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/sales') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Finalizar venda' }).click()
    const response = await responsePromise
    expect(response.status()).toBe(201)
    const sale = (await response.json()) as { id: string; status: string }
    expect(sale.status).toBe('partially_paid')
    await expect(page.getByText('Venda concluída', { exact: true })).toBeVisible()
    return sale.id
  })

  await test.step('efeitos persistidos sem duplicidade', async () => {
    const pending = await page.request.get(`/api/sales/${pendingId}`)
    expect(((await pending.json()) as { status: string; amountDue: string }).status).toBe('pending')
    expect(((await pending.json()) as { amountDue: string }).amountDue).toBe('150.00')

    const partial = await page.request.get(`/api/sales/${partialId}`)
    const partialDetail = (await partial.json()) as { status: string; amountDue: string; payments: Array<{ amount: string }> }
    expect(partialDetail.status).toBe('partially_paid')
    expect(partialDetail.amountDue).toBe('90.00')
    expect(partialDetail.payments).toHaveLength(1)
    expect(partialDetail.payments[0]?.amount).toBe('60.00')

    saveIds({ pendingSaleId: pendingId, partialSaleId: partialId })
  })
})
