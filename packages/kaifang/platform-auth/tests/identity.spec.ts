import { describe, expect, it } from 'vitest'
import {
  isDeviceAdmittedKaifangUser,
  isKaifangUserPrincipal,
  platformUserKey,
} from '../src/identity.ts'

describe('kaifang user identity', () => {
  it('narrows principals and distinguishes device admission', () => {
    expect(isKaifangUserPrincipal(undefined)).toBe(false)
    expect(isKaifangUserPrincipal({ kind: 'owner' })).toBe(false)
    const browser = {
      kind: 'kaifang-user' as const,
      sub: 'sub',
      tid: 'tid',
      clientId: 'kaifang-harness',
      admission: 'browser' as const,
    }
    const device = { ...browser, admission: 'device' as const }
    expect(isKaifangUserPrincipal(browser)).toBe(true)
    expect(isDeviceAdmittedKaifangUser(browser)).toBe(false)
    expect(isDeviceAdmittedKaifangUser(device)).toBe(true)
    expect(isDeviceAdmittedKaifangUser({
      kind: 'kaifang-user', sub: 'sub', tid: 'tid', clientId: 'kaifang-harness',
    })).toBe(false)
    expect(platformUserKey(browser)).toHaveLength(24)
  })
})
