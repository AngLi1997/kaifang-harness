import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  hasPlatformSession, readPlatformSession, writePlatformSession, clearPlatformSession, type PlatformSession,
} from '../src/platform-session.ts'

const sample = (origin: string, expiresAt: number): PlatformSession => ({
  platformOrigin: origin,
  issuer: 'http://localhost:9080/kaifang-meta/iam',
  clientId: 'kaifang-harness',
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt,
  scopes: ['model:invoke'],
  user: { sub: 'u1', tid: 't_system', username: 'admin', displayName: 'Admin', email: null },
})

afterEach(async () => {})

it('persists and reads a Platform session for the matching origin', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'dsh-platform-session-'))
  try {
    expect(await hasPlatformSession(userData, 'http://127.0.0.1:3001', Date.now())).toBe(false)
    await writePlatformSession(userData, sample('http://127.0.0.1:3001', Date.now() + 60_000))
    expect(await hasPlatformSession(userData, 'http://127.0.0.1:3001', Date.now())).toBe(true)
    expect(await hasPlatformSession(userData, 'https://other.example', Date.now())).toBe(false)
    const session = await readPlatformSession(userData, 'http://127.0.0.1:3001', Date.now())
    expect(session?.user.username).toBe('admin')
    await clearPlatformSession(userData)
    expect(await hasPlatformSession(userData, 'http://127.0.0.1:3001', Date.now())).toBe(false)
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})

it('keeps a refreshable expired access token as signed in', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'dsh-platform-session-'))
  try {
    await writePlatformSession(userData, sample('http://127.0.0.1:3001', Date.now() - 5_000))
    expect(await hasPlatformSession(userData, 'http://127.0.0.1:3001', Date.now())).toBe(true)
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})
