import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({ BrowserWindow: vi.fn(), shell: { openExternal: vi.fn() } }))

const {
  attachSharedHostRemoteClient,
  desktopBootTransport,
  shouldNotifySharedHostAttachFailure,
} = await import('../src/shared-host-attach.ts')
const { saveSharedHarnessUrl } = await import('../src/shared-harness.ts')

afterEach(() => { vi.unstubAllEnvs() })

describe('desktopBootTransport', () => {
  it('aligns streamBaseUrl with the active Host for cold-start Remote Client boot', () => {
    expect(desktopBootTransport({
      ownsHost: false,
      activeHostUrl: 'http://127.0.0.1:3080/',
    })).toEqual({ ownsHost: false, streamBaseUrl: 'http://127.0.0.1:3080' })
    expect(desktopBootTransport({
      ownsHost: true,
      activeHostUrl: 'http://127.0.0.1:4123/',
    })).toEqual({ ownsHost: true, streamBaseUrl: 'http://127.0.0.1:4123' })
  })
})

describe('shouldNotifySharedHostAttachFailure', () => {
  it('surfaces only signed-in attach failures that left Desktop on the local Host', () => {
    expect(shouldNotifySharedHostAttachFailure(true, {
      ok: false,
      reason: 'host-unreachable',
      detail: 'down',
    })).toBe(true)
    expect(shouldNotifySharedHostAttachFailure(true, {
      ok: false,
      reason: 'device-ticket-failed',
      detail: '401',
    })).toBe(true)
    expect(shouldNotifySharedHostAttachFailure(true, {
      ok: false,
      reason: 'no-session',
      detail: 'none',
    })).toBe(false)
    expect(shouldNotifySharedHostAttachFailure(false, {
      ok: false,
      reason: 'host-unreachable',
      detail: 'down',
    })).toBe(false)
    expect(shouldNotifySharedHostAttachFailure(true, {
      ok: true,
      hostUrl: 'http://127.0.0.1:3080/',
      cookie: 'dsh=1',
    })).toBe(false)
  })
})

describe('attachSharedHostRemoteClient', () => {
  const session = {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 60_000,
    scopes: ['model:invoke'],
  }

  it('returns ownsHost-ready Remote Client fields when discover and device ticket succeed', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dsh-attach-ok-'))
    try {
      await saveSharedHarnessUrl(userData, 'http://127.0.0.1:3001')
      const discover = vi.fn().mockResolvedValue('http://127.0.0.1:3080')
      const exchange = vi.fn().mockResolvedValue({
        cookie: 'dsh-auth=ticket',
        tokens: {
          accessToken: 'next-access',
          refreshToken: 'next-refresh',
          expiresAt: session.expiresAt + 1_000,
          scopes: session.scopes,
        },
      })
      const result = await attachSharedHostRemoteClient({
        userData,
        platformOrigin: 'http://127.0.0.1:3001',
        session,
        discover,
        exchange,
      })
      expect(result).toEqual({
        ok: true,
        hostUrl: 'http://127.0.0.1:3080/',
        cookie: 'dsh-auth=ticket',
        tokens: {
          accessToken: 'next-access',
          refreshToken: 'next-refresh',
          expiresAt: session.expiresAt + 1_000,
          scopes: session.scopes,
        },
      })
      // desktopBootTransport echoes the Host the caller selects. Dual-plane boot keeps the shell local.
      expect(desktopBootTransport({
        ownsHost: false,
        activeHostUrl: result.ok ? result.hostUrl : 'http://127.0.0.1:9/',
      })).toEqual({ ownsHost: false, streamBaseUrl: 'http://127.0.0.1:3080' })
    } finally {
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('reports observable host-unreachable and device-ticket failures', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'dsh-attach-fail-'))
    try {
      expect(await attachSharedHostRemoteClient({
        userData,
        platformOrigin: '',
        session,
        discover: vi.fn(),
        exchange: vi.fn(),
      })).toMatchObject({ ok: false, reason: 'no-platform' })

      expect(await attachSharedHostRemoteClient({
        userData,
        platformOrigin: 'http://127.0.0.1:3001',
        session: undefined,
        discover: vi.fn(),
        exchange: vi.fn(),
      })).toMatchObject({ ok: false, reason: 'no-session' })

      const unreachable = await attachSharedHostRemoteClient({
        userData,
        platformOrigin: 'http://127.0.0.1:3001',
        session,
        discover: vi.fn().mockResolvedValue(undefined),
        exchange: vi.fn(),
      })
      expect(unreachable).toMatchObject({ ok: false, reason: 'host-unreachable' })
      expect(shouldNotifySharedHostAttachFailure(true, unreachable)).toBe(true)

      const ticketFailed = await attachSharedHostRemoteClient({
        userData,
        platformOrigin: 'http://127.0.0.1:3001',
        session,
        discover: vi.fn().mockResolvedValue('http://127.0.0.1:3080'),
        exchange: vi.fn().mockRejectedValue(new Error('shared Host device ticket failed: HTTP 401')),
      })
      expect(ticketFailed).toMatchObject({
        ok: false,
        reason: 'device-ticket-failed',
        detail: expect.stringContaining('401'),
      })
      expect(shouldNotifySharedHostAttachFailure(true, ticketFailed)).toBe(true)
    } finally {
      await rm(userData, { recursive: true, force: true })
    }
  })
})
