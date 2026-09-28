import { appendFileSync, mkdirSync } from 'node:fs'

import { expect, test } from '@playwright/test'

test.describe.configure({ retries: 0 })

const enabled = process.env['E2E_FULLSTACK'] === '1'
test.skip(!enabled, 'Full-stack do relatorio exige E2E_FULLSTACK=1 com API e PostgreSQL de teste.')

const username = process.env['E2E_USERNAME'] ?? ''
const password = process.env['E2E_PASSWORD'] ?? ''
const tag = process.env['E2E_TAG'] ?? ''
const partialSaleId = process.env['E2E_PARTIAL_SALE_ID'] ?? ''
const pendingSaleId = process.env['E2E_PENDING_SALE_ID'] ?? ''
const seedSales = process.env['E2E_SEED_SALES'] ?? ''
const seedPayments = process.env['E2E_SEED_PAYMENTS'] ?? ''
const seedAudits = process.env['E2E_SEED_AUDITS'] ?? ''
const from = process.env['E2E_FROM'] ?? ''
const mid = process.env['E2E_MID'] ?? ''
const to = process.env['E2E_TO'] ?? ''
const prevFrom = process.env['E2E_PREV_FROM'] ?? ''
const prevTo = process.env['E2E_PREV_TO'] ?? ''
const idsFile = process.env['E2E_FIN_IDS_FILE'] ?? 'e2e-artifacts/financial-report-ids.json'

function saveIds(ids: Record<string, string>) {
  mkdirSync('e2e-artifacts', { recursive: true })
  appendFileSync(idsFile, `${JSON.stringify(ids)}\n`)
}

test('relatorio financeiro reconcilia periodo atual, anterior e drilldown sem escrita', async ({ page }) => {
  expect(username, 'E2E_USERNAME sintetico').not.toBe('')
  expect(partialSaleId, 'E2E_PARTIAL_SALE_ID sintetico').not.toBe('')

  await test.step('login real contra a API', async () => {
    await page.goto('/login')
    await page.getByRole('textbox', { name: 'Usuário' }).fill(username)
    await page.getByLabel('Senha', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Entrar' }).click()
    await page.waitForURL('**/inicio')
  })

  await test.step('relatorio com comparacao exibe valores e serie zerada', async () => {
    expect(from, 'E2E_FROM sintetico').not.toBe('')
    await page.goto(`/relatorios/financeiro?from=${from}&to=${to}&compare=true`)
    await expect(page.getByRole('heading', { name: 'Relatório financeiro' })).toBeVisible()
    await expect(page.getByText(`Cliente Parcial ${tag}`).first()).toBeVisible()
    await expect(page.getByText('Período anterior').first()).toBeVisible()
    await expect(page.getByText(mid).first()).toBeVisible()
    const apiReport = await page.request.get(`/api/reports/financial?from=${from}&to=${to}&compare=true`)
    expect(apiReport.status()).toBe(200)
    type ReportBody = {
      salesBySaleDate: string
      confirmedPaymentsByReceiptDate: string
      comparison: { salesBySaleDate: string; confirmedPaymentsByReceiptDate: string }
      dailySeries: Array<{ date: string }>
    }
    const body = (await apiReport.json()) as unknown as ReportBody
    expect(body.salesBySaleDate).toBe('250.00')
    expect(body.confirmedPaymentsByReceiptDate).toBe('80.00')
    expect(body.comparison.salesBySaleDate).toBe('100.00')
    expect(body.comparison.confirmedPaymentsByReceiptDate).toBe('100.00')
    expect(body.dailySeries).toHaveLength(3)
    saveIds({
      partialSaleId,
      pendingSaleId,
      from,
      mid,
      to,
      prevFrom,
      prevTo,
      sales: seedSales,
      payments: seedPayments,
      audits: seedAudits,
    })
  })

  await test.step('drilldown leva a venda de origem', async () => {
    const drill = page.getByRole('link', { name: new RegExp(`Cliente Parcial ${tag}`) })
    await expect(drill).toHaveAttribute('href', `/vendas/${partialSaleId}`)
    await drill.click()
    await page.waitForURL(`**/vendas/${partialSaleId}`)
  })
})
