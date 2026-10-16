import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearKaifangSession, establishKaifangSession, readKaifangSession, requestKaifangToken, validatePasswordCredentials, writeKaifangSession,
} from '../src/kaifang-auth.ts'

let userData: string
beforeEach(async () => { userData = await mkdtemp(join(tmpdir(), 'dsh-kaifang-auth-')) })
afterEach(async () => { await rm(userData, { recursive: true, force: true }) })

const credentials = { username: 'admin', password: '123456' }
const connection = { systemUrl: 'http://kaifang.test:9999/lab', webUrl: 'http://localhost:5173' }
const jwt = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`

describe('KaifangLab token request', () => {
  it('posts the credentials to the token endpoint under the configured system URL', async () => {
    const send = vi.fn(async (_input: string, _init?: RequestInit) => Response.json({ code: 200, msg: 'OK', data: { access_token: 'token', username: 'admin' } }))
    expect(await requestKaifangToken(connection.systemUrl, credentials, send, 5_000)).toEqual({ ok: true, token: 'token' })
    const [url, init] = send.mock.calls[0]!
    expect(url).toBe('http://kaifang.test:9999/lab/api/v1/base/access_token')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' } })
    expect(JSON.parse(init!.body as string)).toEqual(credentials)
  })

  it.each([
    ['rejected credentials', async () => Response.json({ code: 400, msg: '密码错误!', data: null }, { status: 400 }), 'invalid-credentials'],
    ['a transport error', async () => { throw new TypeError('fetch failed') }, 'unreachable'],
    ['a non-JSON page', async () => new Response('<html>', { status: 200 }), 'failed'],
    ['a missing token', async () => Response.json({ code: 200, data: {} }), 'failed'],
    ['a server error', async () => Response.json({ code: 500, msg: 'boom' }, { status: 500 }), 'failed'],
  ] as const)('maps %s to %s', async (_name, send, reason) => {
    expect(await requestKaifangToken('http://kaifang.test', credentials, send, 5_000)).toEqual({ ok: false, reason })
  })

  it.each([
    [{ username: ' ', password: 'p' }, 'username-required'],
    [{ username: 'admin', password: '' }, 'password-required'],
    [null, 'username-required'],
  ])('rejects %j as %s', (value, reason) => {
    expect(validatePasswordCredentials(value)).toEqual({ ok: false, reason })
  })
})

describe('KaifangLab session establishment', () => {
  it('reads the profile with the token and resolves a relative picture against the Web URL', async () => {
    const token = jwt({ user_id: 1, exp: 1_900_000_000 })
    const send = vi.fn(async (_input: string, _init?: RequestInit) => Response.json({
      code: 200, data: { username: 'admin', nickname: ' 超级管理员 ', email: 'admin@example.test', avatar: '/favicon.png' },
    }))
    expect(await establishKaifangSession(connection, token, send, 5_000)).toEqual({
      ok: true,
      session: {
        systemUrl: connection.systemUrl, accessToken: token, expiresAt: 1_900_000_000_000,
        user: { username: 'admin', displayName: '超级管理员', email: 'admin@example.test', avatarUrl: 'http://localhost:5173/favicon.png' },
      },
    })
    const [url, init] = send.mock.calls[0]!
    expect(url).toBe('http://kaifang.test:9999/lab/api/v1/base/userinfo')
    expect(init).toMatchObject({ method: 'GET', headers: { token } })
  })

  it('falls back to the username without a nickname and drops a non-http picture', async () => {
    const send = async () => Response.json({ code: 200, data: { username: 'u', nickname: null, email: '', avatar: 'javascript:alert(1)' } })
    expect(await establishKaifangSession(connection, 'opaque', send, 5_000)).toMatchObject({
      ok: true, session: { expiresAt: null, user: { username: 'u', displayName: 'u', email: null, avatarUrl: null } },
    })
  })

  it.each([
    ['a rejected token', async () => Response.json({ code: 401, msg: 'expired' }, { status: 401 }), 'invalid-credentials'],
    ['a profile without username', async () => Response.json({ code: 200, data: {} }), 'failed'],
    ['a transport error', async () => { throw new TypeError('fetch failed') }, 'unreachable'],
  ] as const)('maps %s to %s', async (_name, send, reason) => {
    expect(await establishKaifangSession(connection, 't', send, 5_000)).toEqual({ ok: false, reason })
  })
})

describe('KaifangLab session storage', () => {
  const session = {
    systemUrl: 'http://kaifang.test', accessToken: 't', expiresAt: 2_000,
    user: { username: 'admin', displayName: 'Admin', email: null, avatarUrl: 'http://localhost:5173/favicon.png' },
  }

  it('writes an owner-only document and reads it back while unexpired for the same system', async () => {
    await writeKaifangSession(userData, session)
    const path = join(userData, 'desktop', 'kaifang-session.json')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(session)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readKaifangSession(userData, 'http://kaifang.test', 1_000)).toEqual(session)
    expect(await readKaifangSession(userData, 'http://kaifang.test', 2_000)).toBeUndefined()
    expect(await readKaifangSession(userData, 'http://other.test', 1_000)).toBeUndefined()
  })

  it('keeps a session without a known expiry and ignores absent, corrupt, or profile-less documents', async () => {
    expect(await readKaifangSession(userData, 'http://kaifang.test', 0)).toBeUndefined()
    await mkdir(join(userData, 'desktop'), { recursive: true })
    await writeFile(join(userData, 'desktop', 'kaifang-session.json'), '{')
    expect(await readKaifangSession(userData, 'http://kaifang.test', 0)).toBeUndefined()
    await writeFile(join(userData, 'desktop', 'kaifang-session.json'),
      JSON.stringify({ systemUrl: 'http://kaifang.test', username: 'admin', accessToken: 't', expiresAt: null }))
    expect(await readKaifangSession(userData, 'http://kaifang.test', 0)).toBeUndefined()
    await writeKaifangSession(userData, { ...session, expiresAt: null })
    expect(await readKaifangSession(userData, 'http://kaifang.test', Number.MAX_SAFE_INTEGER)).toEqual({ ...session, expiresAt: null })
  })

  it('clears a stored session and tolerates an absent one', async () => {
    await writeKaifangSession(userData, session)
    await clearKaifangSession(userData)
    expect(await readKaifangSession(userData, 'http://kaifang.test', 1_000)).toBeUndefined()
    await expect(clearKaifangSession(userData)).resolves.toBeUndefined()
  })
})
