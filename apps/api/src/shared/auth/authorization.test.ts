import { describe, expect, it } from 'vitest'

import { hasPermission } from './authorization.js'

describe('RBAC authorization', () => {
  it('allows an exact permission and the administrator wildcard', () => {
    expect(hasPermission(['sales:create', 'inventory:read'], 'sales:create')).toBe(true)
    expect(hasPermission(['*'], 'users:manage')).toBe(true)
  })

  it('denies missing permissions', () => {
    expect(hasPermission(['sales:create', 'inventory:read'], 'reports:read')).toBe(false)
  })
})
