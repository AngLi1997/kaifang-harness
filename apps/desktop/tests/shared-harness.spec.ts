import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({ BrowserWindow: vi.fn(), shell: { openExternal: vi.fn() } }))
const { discoverHostFromPlatformHarness, discoverSharedHostUrl, readSharedHarnessUrl, readSharedHostUrl, saveSharedHarnessUrl, sharedHarnessEntryUrl, validateSharedHarnessUrl, validateSharedHostUrl } = await import('../src/shared-harness.ts')

afterEach(() => { vi.unstubAllEnvs() })

it('accepts a Platform origin and resolves its public Harness route', () => {
  expect(validateSharedHarnessUrl(' https://platform.example/ ')).toBe('https://platform.example')
  expect(validateSharedHarnessUrl('https://harness.example')).toBe('https://harness.example')
  expect(validateSharedHarnessUrl('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001')
  expect(sharedHarnessEntryUrl('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001/harness')
  expect(sharedHarnessEntryUrl('https://platform.example')).toBe('https://platform.example/harness')
  for (const value of ['http://harness.example', 'file:///tmp/app', 'https://user:secret@harness.example',
    'https://harness.example/ai/assistant', 'https://harness.example/kaifang/auth/entry',
    'https://harness.example/other', 'https://harness.example/?token=secret',
    'https://harness.example/#login']) {
    expect(validateSharedHarnessUrl(value)).toBeUndefined()
  }
})

it('requires a saved Platform origin and persists editable local settings', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'dsh-shared-harness-'))
  try {
    vi.stubEnv('VITE_HARNESS_WEB_URL', 'https://platform.example')
    expect(await readSharedHarnessUrl(userData)).toBe('')
    expect(await saveSharedHarnessUrl(userData, 'http://127.0.0.1:3001'))
      .toEqual({ ok: true, url: 'http://127.0.0.1:3001' })
    expect(await readSharedHarnessUrl(userData)).toBe('http://127.0.0.1:3001')
    expect(await saveSharedHarnessUrl(userData, ' https://new-platform.example '))
      .toEqual({ ok: true, url: 'https://new-platform.example' })
    expect(await readSharedHarnessUrl(userData)).toBe('https://new-platform.example')
    vi.stubEnv('VITE_HARNESS_WEB_URL', '')
    expect(await readSharedHarnessUrl(userData)).toBe('https://new-platform.example')
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})

it('discovers and remembers a loopback shared Host beside the Platform origin', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'dsh-shared-host-'))
  try {
    expect(validateSharedHostUrl('http://127.0.0.1:3080')).toBe('http://127.0.0.1:3080')
    expect(validateSharedHostUrl('https://harness.example/path')).toBeUndefined()
    expect(await saveSharedHarnessUrl(userData, 'http://127.0.0.1:3001')).toEqual({ ok: true, url: 'http://127.0.0.1:3001' })
    const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ configured: true, account: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    expect(await discoverSharedHostUrl(userData, 'http://127.0.0.1:3001', send, {})).toBe('http://127.0.0.1:3080')
    expect(send).toHaveBeenCalled()
    expect(await readSharedHostUrl(userData)).toBe('http://127.0.0.1:3080')
    expect(await readSharedHarnessUrl(userData)).toBe('http://127.0.0.1:3001')
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})

it('discovers a shared Host from Platform /harness HTTP redirects', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'dsh-harness-redirect-'))
  try {
    await saveSharedHarnessUrl(userData, 'https://platform.example')
    const send = vi.fn(async (input: string) => {
      if (String(input).endsWith('/harness')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://harness.example/' },
        })
      }
      if (String(input).includes('/kaifang/auth/status')) {
        return new Response(JSON.stringify({ configured: true, account: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(null, { status: 404 })
    })
    expect(await discoverHostFromPlatformHarness('https://platform.example', send)).toBe('https://harness.example')
    expect(await discoverSharedHostUrl(userData, 'https://platform.example', send, {})).toBe('https://harness.example')
    expect(await readSharedHostUrl(userData)).toBe('https://harness.example')
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})

it('prefers DSH_SHARED_HOST_URL when the env Host probes healthy', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'dsh-shared-host-env-'))
  try {
    const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ configured: true, account: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    expect(await discoverSharedHostUrl(
      userData,
      'https://platform.example',
      send,
      { DSH_SHARED_HOST_URL: 'https://harness-from-env.example' },
    )).toBe('https://harness-from-env.example')
    expect(String(send.mock.calls[0]?.[0])).toContain('https://harness-from-env.example')
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})
