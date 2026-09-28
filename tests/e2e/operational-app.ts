import { expect, type Page } from '@playwright/test'

export async function openOperationalApp(page: Page) {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Visão da operação' })).toBeVisible()
}
