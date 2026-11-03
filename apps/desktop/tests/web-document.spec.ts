import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authenticateWebHost, desktopFollowTransportAligned, desktopHasModelCredentials, exchangeSharedHostDeviceTicket, forwardWebRequest, isDesktopOwnedHostPath, resolveDesktopHostForward, serveWebDocument } from '../src/web-document.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('serves the Web entry and assets without starting or contacting a Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-web-'))
  roots.push(root)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<html><head></head><body><script src="assets/entry.js"></script></body></html>')
  await writeFile(join(root, 'assets/entry.js'), 'globalThis.entryLoaded = true')
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const response = await serveWebDocument(new Request('dsh-app://app/'), root)
  const html = await response.text()
  expect(html.indexOf('Promise.withResolvers()')).toBeLessThan(html.indexOf('assets/entry.js'))
  expect(await (await serveWebDocument(new Request('dsh-app://app/assets/entry.js'), root)).text()).toContain('entryLoaded')
  expect(fetch).not.toHaveBeenCalled()
  expect((await serveWebDocument(new Request('dsh-app://app/%2e%2e%2fprivate'), root)).status).toBe(403)
  expect((await serveWebDocument(new Request('dsh-app://app/missing.js'), root)).status).toBe(404)
})

it('requires the Host authentication exchange and retains only its cookie value', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 303, headers: { 'set-cookie': 'session=owned; HttpOnly; SameSite=Strict' } }))
    .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
  vi.stubGlobal('fetch', fetch)
  expect(await authenticateWebHost('http://127.0.0.1:1234/?token=owned')).toBe('session=owned')
  await expect(authenticateWebHost('http://127.0.0.1:1234/')).rejects.toThrow('authentication failed')
})

it('forwards upload bytes and cancellation with Host credentials while keeping the response streaming', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('stream')); controller.close() } })
  const fetch = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-encoding': 'gzip', 'set-cookie': 'private' } }))
  vi.stubGlobal('fetch', fetch)
  const request = new Request('dsh-app://app/api/upload?name=file', {
    method: 'POST', body: 'upload bytes', headers: { origin: 'dsh-app://app', cookie: 'untrusted' },
  })
  const response = await forwardWebRequest(request, 'http://127.0.0.1:1234/?token=secret', 'session=owned')
  const [target, init] = fetch.mock.calls[0] as [URL, RequestInit]
  expect(target.href).toBe('http://127.0.0.1:1234/api/upload?name=file')
  expect(new Headers(init.headers).get('cookie')).toBe('session=owned')
  expect(new Headers(init.headers).get('origin')).toBeNull()
  expect(init.signal).toBe(request.signal)
  expect(init.body).toBe(request.body)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('content-encoding')).toBeNull()
  expect(await response.text()).toBe('stream')
})

it('drops connection-level headers the Host wrote for its own transport', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('body', { headers: {
    'transfer-encoding': 'chunked', connection: 'keep-alive', 'keep-alive': 'timeout=5', trailer: 'x', te: 'trailers',
    'content-type': 'text/plain', 'cache-control': 'no-cache', etag: '"1"',
  } }))
  vi.stubGlobal('fetch', fetch)
  const response = await forwardWebRequest(new Request('dsh-app://app/api/read'), 'http://127.0.0.1:1234/', 'session=owned')
  for (const name of ['transfer-encoding', 'connection', 'keep-alive', 'trailer', 'te']) expect(response.headers.get(name)).toBeNull()
  expect(response.headers.get('content-type')).toBe('text/plain')
  expect(response.headers.get('cache-control')).toBe('no-cache')
  expect(response.headers.get('etag')).toBe('"1"')
})

it('replaces the immutable cache header of plugin bundles with no-store and leaves other routes alone', async () => {
  const immutable = 'public, max-age=31536000, immutable'
  const fetch = vi.fn().mockImplementation(async () => new Response('js', { headers: { 'cache-control': immutable } }))
  vi.stubGlobal('fetch', fetch)
  const bundle = await forwardWebRequest(new Request('dsh-app://app/plugins/??a/client.js&rev=1'), 'http://127.0.0.1:1234/', 'c')
  expect(bundle.headers.get('cache-control')).toBe('no-store')
  const chunk = await forwardWebRequest(new Request('dsh-app://app/plugins/a/client.x.js?rev=1'), 'http://127.0.0.1:1234/', 'c')
  expect(chunk.headers.get('cache-control')).toBe('no-store')
  const asset = await forwardWebRequest(new Request('dsh-app://app/api/plugins/list'), 'http://127.0.0.1:1234/', 'c')
  expect(asset.headers.get('cache-control')).toBe(immutable)
})

it('refuses another page origin without forwarding its request', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const response = await forwardWebRequest(new Request('dsh-app://app/api/read', { headers: { origin: 'https://other.example' } }), 'http://127.0.0.1:1234/', 'session=owned')
  expect(response.status).toBe(403)
  expect(fetch).not.toHaveBeenCalled()
})

it('exchanges Platform tokens for a shared Host device-ticket cookie', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    ok: true,
    tokens: {
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      expiresAt: 1_800_000_000_000,
      scopes: ['model:invoke'],
    },
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': 'dsh_kaifang_auth_local=deviceSessionValue; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000',
    },
  }))
  vi.stubGlobal('fetch', fetch)
  const ticket = await exchangeSharedHostDeviceTicket('http://127.0.0.1:3080', {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 60_000,
    scopes: ['model:invoke'],
  })
  expect(ticket.cookie).toBe('dsh_kaifang_auth_local=deviceSessionValue')
  expect(ticket.tokens).toEqual({
    accessToken: 'access-2',
    refreshToken: 'refresh-2',
    expiresAt: 1_800_000_000_000,
    scopes: ['model:invoke'],
  })
  const [target, init] = fetch.mock.calls[0] as [URL, RequestInit]
  expect(target.href).toBe('http://127.0.0.1:3080/kaifang/auth/device')
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer access')
  expect(JSON.parse(String(init.body))).toMatchObject({ accessToken: 'access', refreshToken: 'refresh' })
})

it('keeps plugin bundles on the owned Host while API traffic can target the shared Host', () => {
  expect(isDesktopOwnedHostPath('/plugins/??a/client.js&rev=1')).toBe(true)
  expect(isDesktopOwnedHostPath('/api/pluginInventory/list')).toBe(true)
  expect(isDesktopOwnedHostPath('/api/pluginManager/listPlugins')).toBe(true)
  expect(isDesktopOwnedHostPath('/api/workspace/follow')).toBe(false)
  expect(isDesktopOwnedHostPath('/api/agentPresets/list')).toBe(false)
  // Shared-Host Peer allowlist serves Settings → 权限 / Agent 预设 for Remote Client.
  expect(isDesktopOwnedHostPath('/api/permissionPresets/catalog')).toBe(false)
  expect(isDesktopOwnedHostPath('/kaifang/auth/status')).toBe(false)
  const shared = resolveDesktopHostForward('/api/session/list', {
    ownsHost: false,
    activeHostUrl: 'http://127.0.0.1:3080/',
    activeHostCookie: 'shared=1',
    localHostUrl: 'http://127.0.0.1:9/',
    localHostCookie: 'local=1',
  })
  expect(shared).toEqual({ hostUrl: 'http://127.0.0.1:3080/', hostCookie: 'shared=1' })
  const plugins = resolveDesktopHostForward('/plugins/a/client.js', {
    ownsHost: false,
    activeHostUrl: 'http://127.0.0.1:3080/',
    activeHostCookie: 'shared=1',
    localHostUrl: 'http://127.0.0.1:9/',
    localHostCookie: 'local=1',
  })
  expect(plugins).toEqual({ hostUrl: 'http://127.0.0.1:9/', hostCookie: 'local=1' })
  const inventory = resolveDesktopHostForward('/api/pluginInventory/list', {
    ownsHost: false,
    activeHostUrl: 'http://127.0.0.1:3080/',
    activeHostCookie: 'shared=1',
    localHostUrl: 'http://127.0.0.1:9/',
    localHostCookie: 'local=1',
  })
  expect(inventory).toEqual({ hostUrl: 'http://127.0.0.1:9/', hostCookie: 'local=1' })
  expect(resolveDesktopHostForward('/plugins/a/client.js', {
    ownsHost: false,
    activeHostUrl: 'http://127.0.0.1:3080/',
    activeHostCookie: 'shared=1',
  })).toBeUndefined()
})

it('treats an online shared Host as model credentials without a local API key', () => {
  expect(desktopHasModelCredentials({ sharedHostOnline: true, localHasApiKey: false })).toBe(true)
  expect(desktopHasModelCredentials({ sharedHostOnline: false, localHasApiKey: true })).toBe(true)
  expect(desktopHasModelCredentials({ sharedHostOnline: false, localHasApiKey: false })).toBe(false)
})

it('keeps Gateway follow streamBaseUrl on the same Host as /api forwarding', () => {
  expect(desktopFollowTransportAligned({
    ownsHost: false,
    streamBaseUrl: 'http://127.0.0.1:3080',
    activeHostUrl: 'http://127.0.0.1:3080/',
  })).toBe(true)
  expect(desktopFollowTransportAligned({
    ownsHost: true,
    streamBaseUrl: 'http://127.0.0.1:4123',
    activeHostUrl: 'http://127.0.0.1:4123/?token=x',
  })).toBe(true)
  expect(desktopFollowTransportAligned({
    ownsHost: false,
    streamBaseUrl: 'http://127.0.0.1:3080',
    activeHostUrl: 'http://127.0.0.1:4123/',
  })).toBe(false)
})
