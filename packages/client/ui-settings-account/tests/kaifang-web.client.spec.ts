// @vitest-environment jsdom
/** Plain-browser KaifangLab session, settings, password sign-in, and browser callback handling. */
import { beforeEach, expect, it, vi } from 'vitest'
import { browserKaifang, DEFAULT_KAIFANG_CONNECTION, KAIFANG_CALLBACK_KEY, WebKaifang, type WebKaifangOptions } from '../src/client/kaifang-web.ts'

const connection = { systemUrl: 'http://kaifang.test:9999/lab', webUrl: 'http://kaifang.test:5173', authCode: 'code' }
const token = `h.${btoa(JSON.stringify({ user_id: 1, exp: 1_900_000_000 })).replace(/=+$/, '')}.s`

function profile(nickname: string | null = ' 超级管理员 ') {
  return Response.json({ code: 200, data: { username: 'admin', nickname, email: 'admin@example.test', avatar: '/favicon.png' } })
}

function create(overrides: Partial<WebKaifangOptions> = {}) {
  const open = vi.fn<(url: string) => void>()
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith('/access_token')) return Response.json({ code: 200, data: { access_token: token, username: 'admin' } })
    return profile()
  })
  const web = new WebKaifang({
    storage: localStorage, fetch, open, callbackUrl: 'http://127.0.0.1:3000/kaifang/callback.html',
    timeoutMs: 5_000, now: () => 1_800_000_000_000, randomState: () => 'state-1', ...overrides,
  })
  return { web, open, fetch }
}

beforeEach(() => { localStorage.clear() })

it('validates and stores the connection, falling back to the defaults', () => {
  const { web } = create()
  expect(web.connection()).toEqual(DEFAULT_KAIFANG_CONNECTION)
  expect(web.saveConnection({ ...connection, systemUrl: ' ' })).toEqual({ ok: false, reason: 'url-required' })
  expect(web.saveConnection({ ...connection, systemUrl: 'ftp://x' })).toEqual({ ok: false, reason: 'url-invalid' })
  expect(web.saveConnection({ ...connection, webUrl: '' })).toEqual({ ok: false, reason: 'web-url-required' })
  expect(web.saveConnection({ ...connection, webUrl: 'nope' })).toEqual({ ok: false, reason: 'web-url-invalid' })
  expect(web.saveConnection({ ...connection, authCode: ' ' })).toEqual({ ok: false, reason: 'auth-code-required' })
  expect(web.saveConnection({ ...connection, systemUrl: ` ${connection.systemUrl} ` })).toEqual({ ok: true })
  expect(create().web.connection()).toEqual(connection)
  expect(create({ storage: undefined }).web.saveConnection(connection)).toEqual({ ok: false, reason: 'write-failed' })
})

it('signs in with a password, publishes the nickname, and restores the session on reload until sign-out', async () => {
  const { web, fetch } = create()
  web.saveConnection(connection)
  const accounts = vi.fn()
  web.subscribe(accounts)
  expect(await web.passwordSignIn({ username: ' ', password: 'x' })).toEqual({ ok: false, reason: 'username-required' })
  expect(await web.passwordSignIn({ username: 'admin', password: '' })).toEqual({ ok: false, reason: 'password-required' })
  expect(fetch).not.toHaveBeenCalled()
  expect(await web.passwordSignIn({ username: ' admin ', password: '123456' })).toEqual({ ok: true })
  const [tokenUrl, tokenInit] = fetch.mock.calls[0]!
  expect(tokenUrl).toBe('http://kaifang.test:9999/lab/api/v1/base/access_token')
  expect(JSON.parse(String(tokenInit?.body))).toEqual({ username: 'admin', password: '123456' })
  const [profileUrl, profileInit] = fetch.mock.calls[1]!
  expect(profileUrl).toBe('http://kaifang.test:9999/lab/api/v1/base/userinfo')
  expect(profileInit?.headers).toMatchObject({ token })
  const account = { username: 'admin', displayName: '超级管理员', email: 'admin@example.test', avatarUrl: 'http://kaifang.test:5173/favicon.png' }
  expect(accounts).toHaveBeenCalledExactlyOnceWith(account)
  expect(web.snapshot()).toEqual({ account, browser: { phase: 'idle' } })
  expect(await create().web.current()).toEqual(account)
  await web.signOut()
  expect(accounts).toHaveBeenLastCalledWith(null)
  expect(await create().web.current()).toBeNull()
})

it('ignores a stored session that expired or belongs to another system URL', async () => {
  const { web } = create()
  web.saveConnection(connection)
  await web.passwordSignIn({ username: 'admin', password: '123456' })
  expect(await create({ now: () => 1_900_000_000_000 }).web.current()).toBeNull()
  web.saveConnection({ ...connection, systemUrl: 'http://other.test' })
  expect(await create().web.current()).toBeNull()
})

it.each([
  ['rejected credentials', async () => Response.json({ code: 400, msg: '无效的账号' }, { status: 400 }), 'invalid-credentials'],
  ['a transport failure', async () => { throw new TypeError('Failed to fetch') }, 'unreachable'],
  ['a non-KaifangLab reply', async () => new Response('<html>'), 'failed'],
  ['a reply without a token', async () => Response.json({ code: 200, data: {} }), 'failed'],
] as const)('reports %s as %s', async (_name, reply, reason) => {
  const { web } = create({ fetch: vi.fn<typeof globalThis.fetch>(reply) })
  expect(await web.passwordSignIn({ username: 'admin', password: 'x' })).toEqual({ ok: false, reason })
  expect(web.snapshot().account).toBeNull()
})

it('falls back to the account when the nickname is blank', async () => {
  const { web } = create({
    fetch: vi.fn<typeof globalThis.fetch>(async input => String(input).endsWith('/access_token')
      ? Response.json({ code: 200, data: { access_token: 'opaque' } }) : profile('  ')),
  })
  expect(await web.passwordSignIn({ username: 'admin', password: 'x' })).toEqual({ ok: true })
  expect(web.snapshot().account?.displayName).toBe('admin')
})

it('opens the authorization page and accepts only the callback for the pending attempt', async () => {
  const { web, open } = create()
  web.saveConnection(connection)
  await web.receiveCallback(JSON.stringify({ token, state: 'state-1' }))
  expect(web.snapshot().account).toBeNull()
  web.startBrowserSignIn()
  const url = new URL(open.mock.calls[0]![0])
  expect(`${url.origin}${url.pathname}`).toBe('http://kaifang.test:5173/authorize')
  expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3000/kaifang/callback.html')
  expect(url.searchParams.get('state')).toBe('state-1')
  expect(web.snapshot().browser).toEqual({ phase: 'waiting', url: url.href })
  await web.receiveCallback(JSON.stringify({ token, state: 'forged' }))
  await web.receiveCallback('not json')
  await web.receiveCallback(null)
  expect(web.snapshot().browser.phase).toBe('waiting')
  localStorage.setItem(KAIFANG_CALLBACK_KEY, JSON.stringify({ token, state: 'state-1' }))
  await web.receiveCallback(localStorage.getItem(KAIFANG_CALLBACK_KEY))
  expect(localStorage.getItem(KAIFANG_CALLBACK_KEY)).toBeNull()
  expect(web.snapshot()).toMatchObject({ account: { username: 'admin', displayName: '超级管理员' }, browser: { phase: 'idle' } })
})

it('returns to the choices after a denial or cancellation and reports a failed token exchange', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ code: 401 }, { status: 401 }))
  const { web } = create({ fetch })
  web.startBrowserSignIn()
  await web.receiveCallback(JSON.stringify({ error: 'access_denied', state: 'state-1' }))
  expect(web.snapshot().browser).toEqual({ phase: 'idle' })
  web.startBrowserSignIn()
  web.cancelBrowserSignIn()
  await web.receiveCallback(JSON.stringify({ token, state: 'state-1' }))
  expect(fetch).not.toHaveBeenCalled()
  web.startBrowserSignIn()
  await web.receiveCallback(JSON.stringify({ token, state: 'state-1' }))
  expect(web.snapshot()).toEqual({ account: null, browser: { phase: 'failed' } })
})

it('reads the token expiry only from a JWT expiry claim', async () => {
  const session = async (accessToken: string) => {
    localStorage.clear()
    const { web } = create({
      fetch: vi.fn<typeof globalThis.fetch>(async input => String(input).endsWith('/access_token')
        ? Response.json({ code: 200, data: { access_token: accessToken } }) : profile()),
    })
    await web.passwordSignIn({ username: 'admin', password: 'x' })
    return (JSON.parse(localStorage.getItem('dsh.kaifang.session')!) as { expiresAt: unknown }).expiresAt
  }
  expect(await session(token)).toBe(1_900_000_000_000)
  expect(await session('opaque')).toBeNull()
  expect(await session(`h.${btoa('{}')}.s`)).toBeNull()
  expect(await session('h.%%%.s')).toBeNull()
})

it.each([
  ['a malformed document', 'not json'],
  ['a missing user', JSON.stringify({ systemUrl: DEFAULT_KAIFANG_CONNECTION.systemUrl, accessToken: 't', expiresAt: null })],
  ['a user without strings', JSON.stringify({ systemUrl: DEFAULT_KAIFANG_CONNECTION.systemUrl, accessToken: 't', expiresAt: null, user: { username: 'a' } })],
  ['an invalid email', JSON.stringify({ systemUrl: DEFAULT_KAIFANG_CONNECTION.systemUrl, accessToken: 't', expiresAt: null,
    user: { username: 'a', displayName: 'a', email: 1, avatarUrl: null } })],
  ['an invalid picture', JSON.stringify({ systemUrl: DEFAULT_KAIFANG_CONNECTION.systemUrl, accessToken: 't', expiresAt: null,
    user: { username: 'a', displayName: 'a', email: null, avatarUrl: 1 } })],
  ['an invalid expiry', JSON.stringify({ systemUrl: DEFAULT_KAIFANG_CONNECTION.systemUrl, accessToken: 't', expiresAt: 'soon',
    user: { username: 'a', displayName: 'a', email: null, avatarUrl: null } })],
])('treats a stored session with %s as signed out', async (_name, stored) => {
  localStorage.setItem('dsh.kaifang.session', stored)
  expect(await create().web.current()).toBeNull()
})

it('restores a stored session without a known expiry', async () => {
  localStorage.setItem('dsh.kaifang.session', JSON.stringify({ systemUrl: DEFAULT_KAIFANG_CONNECTION.systemUrl, accessToken: 't', expiresAt: null,
    user: { username: 'a', displayName: 'A', email: 'a@example.test', avatarUrl: null } }))
  expect(await create().web.current()).toEqual({ username: 'a', displayName: 'A', email: 'a@example.test', avatarUrl: null })
})

it('treats a browser that denies storage as having nothing saved and reports failed writes', async () => {
  const denied = {
    getItem: () => { throw new DOMException('denied', 'SecurityError') },
    setItem: () => { throw new DOMException('quota', 'QuotaExceededError') },
    removeItem: () => { throw new DOMException('denied', 'SecurityError') },
  } as Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  const { web } = create({ storage: Object.assign(Object.create(Storage.prototype) as Storage, denied) })
  expect(web.connection()).toEqual(DEFAULT_KAIFANG_CONNECTION)
  expect(web.saveConnection(connection)).toEqual({ ok: false, reason: 'write-failed' })
  expect(await web.passwordSignIn({ username: 'admin', password: 'x' })).toEqual({ ok: false, reason: 'failed' })
  await web.signOut()
  expect(web.snapshot().account).toBeNull()
})

it.each([
  ['a server error', async () => Response.json({ code: 200, data: {} }, { status: 500 })],
  ['an unexpected business code', async () => Response.json({ code: 500, data: {} })],
  ['a missing data object', async () => Response.json({ code: 200, data: null })],
] as const)('reports %s as failed', async (_name, reply) => {
  expect(await create({ fetch: vi.fn<typeof globalThis.fetch>(reply) }).web.passwordSignIn({ username: 'a', password: 'x' }))
    .toEqual({ ok: false, reason: 'failed' })
})

it('rejects a profile without an account and keeps only http pictures and present email addresses', async () => {
  const reply = (data: object) => create({
    fetch: vi.fn<typeof globalThis.fetch>(async input => String(input).endsWith('/access_token')
      ? Response.json({ code: 200, data: { access_token: 'opaque' } }) : Response.json({ code: 200, data })),
  }).web
  expect(await reply({ nickname: 'x' }).passwordSignIn({ username: 'a', password: 'x' })).toEqual({ ok: false, reason: 'failed' })
  const web = reply({ username: 'a', email: '', avatar: 'javascript:alert(1)' })
  await web.passwordSignIn({ username: 'a', password: 'x' })
  expect(web.snapshot().account).toEqual({ username: 'a', displayName: 'a', email: null, avatarUrl: null })
  localStorage.clear()
  const blank = reply({ username: 'a', avatar: '' })
  await blank.passwordSignIn({ username: 'a', password: 'x' })
  expect(blank.snapshot().account?.avatarUrl).toBeNull()
})

it('notifies state observers until they unsubscribe and accepts URLs with a trailing slash', async () => {
  const { web, open, fetch } = create()
  web.saveConnection({ systemUrl: 'http://kaifang.test:9999/', webUrl: 'http://kaifang.test:5173/', authCode: 'code' })
  const listener = vi.fn()
  const stop = web.watch(listener)
  web.startBrowserSignIn()
  expect(listener).toHaveBeenCalledOnce()
  expect(new URL(open.mock.calls[0]![0]).pathname).toBe('/authorize')
  stop()
  web.cancelBrowserSignIn()
  expect(listener).toHaveBeenCalledOnce()
  await web.passwordSignIn({ username: 'admin', password: 'x' })
  expect(fetch.mock.calls[0]![0]).toBe('http://kaifang.test:9999/api/v1/base/access_token')
})

it('reports a callback error other than a denial as a failed sign-in', async () => {
  const { web } = create()
  web.startBrowserSignIn()
  await web.receiveCallback(JSON.stringify({ error: 'server_error', state: 'state-1' }))
  expect(web.snapshot().browser).toEqual({ phase: 'failed' })
})

it('builds the browser session over the window storage, network, tabs, and callback page', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ code: 400 }, { status: 400 }))
  const open = vi.fn<Window['open']>(() => null)
  const scope = { localStorage, fetch, open, crypto, document } as Pick<Window, 'localStorage' | 'fetch' | 'open' | 'crypto' | 'document'>
  const web = browserKaifang(scope as Window, 1_000)
  expect(await web.passwordSignIn({ username: 'a', password: 'x' })).toEqual({ ok: false, reason: 'invalid-credentials' })
  expect(fetch).toHaveBeenCalledOnce()
  web.startBrowserSignIn()
  const authorize = new URL(String(open.mock.calls[0]![0]))
  expect(open.mock.calls[0]!.slice(1)).toEqual(['_blank', 'noopener'])
  expect(authorize.searchParams.get('redirect_uri')).toBe(new URL('kaifang/callback.html', document.baseURI).href)
  expect(authorize.searchParams.get('state')).toMatch(/^[0-9a-f]{48}$/)
  localStorage.setItem('dsh.kaifang.session', JSON.stringify({ systemUrl: DEFAULT_KAIFANG_CONNECTION.systemUrl, accessToken: 't', expiresAt: 1,
    user: { username: 'a', displayName: 'a', email: null, avatarUrl: null } }))
  expect(await browserKaifang(scope as Window, 1_000).current()).toBeNull()
  const denied = { ...scope, get localStorage(): Storage { throw new DOMException('denied', 'SecurityError') } }
  expect(browserKaifang(denied as Window, 1_000).saveConnection({ ...DEFAULT_KAIFANG_CONNECTION, authCode: 'c' }))
    .toEqual({ ok: false, reason: 'write-failed' })
})
