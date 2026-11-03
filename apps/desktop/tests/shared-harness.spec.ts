import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({ BrowserWindow: vi.fn(), shell: { openExternal: vi.fn() } }))
const { readSharedHarnessUrl, saveSharedHarnessUrl, sharedHarnessEntryUrl, validateSharedHarnessUrl } = await import('../src/shared-harness.ts')

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
