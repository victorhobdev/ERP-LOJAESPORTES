import { appendFileSync, mkdirSync } from 'node:fs'

import { expect, test } from '@playwright/test'

const enabled = process.env['E2E_FULLSTACK'] === '1'
test.skip(!enabled, 'Full-stack de encomendas exige E2E_FULLSTACK=1 com API e PostgreSQL de teste.')

const username = process.env['E2E_USERNAME'] ?? ''
const password = process.env['E2E_PASSWORD'] ?? ''
const tag = process.env['E2E_TAG'] ?? ''
const idsFile = process.env['E2E_CUSTOMER_ORDERS_IDS_FILE'] ?? 'e2e-artifacts/customer-orders-fullstack-ids.json'

function saveIds(ids: Record<string, string>) {
  mkdirSync('e2e-artifacts', { recursive: true })
  appendFileSync(idsFile, `${JSON.stringify(ids)}\n`)
}

test('encomendas full-stack: criar, filtrar, entregar, cancelar e retry unico', async ({ page }) => {
  expect(username, 'E2E_USERNAME sintético').not.toBe('')
  expect(tag, 'E2E_TAG sintética').not.toBe('')

  await test.step('login real contra a API', async () => {
    await page.goto('/login')
    await page.getByRole('textbox', { name: 'Usuário' }).fill(username)
    await page.getByLabel('Senha', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Entrar' }).click()
    await page.waitForURL('**/inicio')
  })

  const deliveredId = await test.step('criar encomenda livre e avancar ate entregue', async () => {
    await page.goto('/encomendas')
    await page.getByRole('button', { name: 'Nova encomenda' }).click()
    await page.getByRole('textbox', { name: 'Buscar cliente' }).fill(`Cliente E2E ${tag}`)
    await page.getByRole('radio', { name: /Cliente E2E/ }).check()
    await page.getByRole('textbox', { name: 'Clube' }).fill('E2E Encomenda FC')
    await page.getByRole('textbox', { name: 'Modelo' }).fill(`Modelo ${tag}`)
    await page.getByRole('textbox', { name: 'Tamanho' }).fill('M')
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/customer-orders') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Criar encomenda' }).click()
    const response = await responsePromise
    expect(response.status()).toBe(201)
    const created = (await response.json()) as { id: string; status: string }
    expect(created.status).toBe('pending')
    await expect(page.getByText('Encomenda criada.', { exact: true })).toBeVisible()
    return created.id
  })

  await test.step('lista, filtro e detalhe', async () => {
    await page.goto(`/encomendas?search=${encodeURIComponent(`Cliente E2E ${tag}`)}`)
    await expect(page.getByRole('link', { name: /Cliente E2E/ }).first()).toHaveAttribute('href', `/encomendas/${deliveredId}`)
    await page.goto(`/encomendas/${deliveredId}`)
    await expect(page.getByRole('heading', { name: /Encomenda de/ })).toBeVisible()
    await expect(page.getByText('Gestor Encomendas E2E').first()).toBeVisible()
  })

  await test.step('resposta perdida no avancar com retry idempotente', async () => {
    let interceptedOnce = false
    let serverStatus = ''
    await page.route('**/api/customer-orders/*/status', async (route) => {
      if (route.request().method() !== 'PATCH' || interceptedOnce) return route.continue()
      interceptedOnce = true
      const serverResponse = await route.fetch()
      expect(serverResponse.status()).toBe(200)
      serverStatus = ((await serverResponse.json()) as { status: string }).status
      return route.abort('connectionaborted')
    })

    await page.getByRole('button', { name: 'Pedir ao fornecedor' }).click()
    await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible()

    const retryPromise = page.waitForResponse((response) => response.url().includes('/status') && response.request().method() === 'PATCH')
    await page.getByRole('button', { name: 'Tentar novamente' }).click()
    const retryResponse = await retryPromise
    expect(retryResponse.status()).toBe(200)
    expect(((await retryResponse.json()) as { status: string }).status).toBe(serverStatus)
    expect(serverStatus).toBe('supplier_ordered')
    await page.unroute('**/api/customer-orders/*/status')
  })

  await test.step('avancar ate entregue', async () => {
    const firstPromise = page.waitForResponse((response) => response.url().includes('/status') && response.request().method() === 'PATCH')
    await page.getByRole('button', { name: 'Marcar produto chegado' }).click()
    const firstAdvance = await firstPromise
    expect(firstAdvance.status()).toBe(200)
    await expect(page.getByText('Status atualizado.', { exact: true })).toBeVisible()
    const secondPromise = page.waitForResponse((response) => response.url().includes('/status') && response.request().method() === 'PATCH')
    await page.getByRole('button', { name: 'Entregar ao cliente' }).click()
    const secondAdvance = await secondPromise
    expect(secondAdvance.status()).toBe(200)
    await expect(page.getByText('Status atualizado.', { exact: true })).toBeVisible()
    await expect(page.getByText('Encomenda entregue; não há novas ações.')).toBeVisible()
  })

  const cancelledId = await test.step('cancelar com motivo e bloquear sem motivo', async () => {
    await page.goto('/encomendas')
    await page.getByRole('button', { name: 'Nova encomenda' }).click()
    await page.getByRole('textbox', { name: 'Buscar cliente' }).fill(`Cliente E2E ${tag}`)
    await page.getByRole('radio', { name: /Cliente E2E/ }).check()
    await page.getByRole('textbox', { name: 'Clube' }).fill('Outro FC')
    await page.getByRole('textbox', { name: 'Modelo' }).fill(`Modelo ${tag}`)
    await page.getByRole('textbox', { name: 'Tamanho' }).fill('G')
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/customer-orders') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Criar encomenda' }).click()
    const created = (await (await responsePromise).json()) as { id: string }

    await page.goto(`/encomendas/${created.id}`)
    await page.getByRole('button', { name: 'Cancelar encomenda' }).click()
    await page.getByRole('button', { name: 'Confirmar cancelamento' }).click()
    await expect(page.getByText('Cancelamento exige motivo.')).toBeVisible()
    await page.getByLabel('Motivo do cancelamento').fill('Desistencia E2E')
    const cancelPromise = page.waitForResponse((response) => response.url().includes('/status') && response.request().method() === 'PATCH')
    await page.getByRole('button', { name: 'Confirmar cancelamento' }).click()
    const cancelResponse = await cancelPromise
    expect(cancelResponse.status()).toBe(200)
    await expect(page.getByText('Status atualizado.', { exact: true })).toBeVisible()
    await expect(page.getByText('Motivo do cancelamento: Desistencia E2E')).toBeVisible()
    return created.id
  })

  saveIds({ deliveredId, cancelledId })
})
