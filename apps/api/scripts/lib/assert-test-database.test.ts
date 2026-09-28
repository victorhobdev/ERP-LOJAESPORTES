import { describe, expect, it } from 'vitest'

import { assertTestDatabaseUrl } from './assert-test-database.js'

const testDatabaseUrl = process.env['TEST_DATABASE_URL']

describe.runIf(!!testDatabaseUrl)('assertTestDatabaseUrl', () => {
  it('accepts the connected test database without writing', async () => {
    const name = await assertTestDatabaseUrl(testDatabaseUrl!)
    expect(name).toMatch(/_test$/)
  })

  it('rejects a non-test database before any write and without leaking secrets', async () => {
    const url = new URL(testDatabaseUrl!)
    const password = url.password
    url.pathname = '/template1'
    const error = await assertTestDatabaseUrl(url.toString()).then(
      () => { throw new Error('expected rejection') },
      (cause: unknown) => cause,
    )
    expect(String(error)).toMatch(/explicit test database/)
    expect(String(error)).toMatch(/"template1"/)
    if (password) expect(String(error)).not.toContain(password)
    expect(String(error)).not.toContain(url.toString())
  })
})
