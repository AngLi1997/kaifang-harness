/** Local Web document and authenticated HTTP forwarding for the application window. */
import { readFile } from 'node:fs/promises'
import { isSidecarApiPath, stripSidecarApiPrefix } from './host-plane.ts'
import { extname, resolve, sep } from 'node:path'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
}
const BOOT = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>'

/**
 * Read an application-owned static asset; the index waits for asynchronous Host injections.
 * @param request - Local application request.
 * @param root - Packaged Web dist directory.
 * @returns Static response, or a missing/invalid path response.
 */
export async function serveWebDocument(request: Request, root: string): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const url = new URL(request.url)
  let pathname: string
  try { pathname = decodeURIComponent(url.pathname) } catch { return new Response(null, { status: 400 }) }
  const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
  const directory = resolve(root)
  if (!target.startsWith(directory + sep)) return new Response(null, { status: 403 })
  let body: Buffer
  try { body = await readFile(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 })
    throw error
  }
  const content = pathname === '/' || pathname === '/index.html'
    ? body.toString().replace('<head>', '<head>' + BOOT) : new Uint8Array(body)
  return new Response(request.method === 'HEAD' ? null : content, {
    headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' },
  })
}

/**
 * Exchange the Host launch URL for an authority-bound browser cookie.
 * @param url - Authenticated URL reported by the owned Host process.
 * @returns Cookie header for requests forwarded to that Host.
 */
export async function authenticateWebHost(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) throw new Error('Desktop Host authentication failed')
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}

/** Tokens the shared Host may refresh while admitting a Desktop device ticket. */
export interface SharedHostDeviceTokens {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly scopes: readonly string[]
}

/** Cookie Peer plus any Host-refreshed Platform tokens. */
export interface SharedHostDeviceTicket {
  readonly cookie: string
  readonly tokens?: SharedHostDeviceTokens
}

/**
 * Exchange Desktop Platform tokens for a shared Host session cookie (device ticket).
 * Host may refresh an expired access token via `refreshToken` and return the new pair.
 * @param hostOrigin - shared Web Host origin, for example `http://127.0.0.1:3080`.
 * @param session - Desktop-held Platform IAM session.
 */
export async function exchangeSharedHostDeviceTicket(
  hostOrigin: string,
  session: {
    readonly accessToken: string
    readonly refreshToken: string
    readonly expiresAt: number
    readonly scopes: readonly string[]
  },
): Promise<SharedHostDeviceTicket> {
  const target = new URL('/kaifang/auth/device', hostOrigin.endsWith('/') ? hostOrigin : `${hostOrigin}/`)
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  }
  if (session.accessToken !== '') headers.authorization = `Bearer ${session.accessToken}`
  const response = await fetch(target, {
    method: 'POST',
    redirect: 'manual',
    headers,
    body: JSON.stringify({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      scopes: session.scopes,
    }),
  })
  const cookieHeader = response.headers.get('set-cookie')
  const bodyText = await response.text()
  if (!response.ok || cookieHeader === null) {
    throw new Error(`shared Host device ticket failed: HTTP ${String(response.status)} ${bodyText.slice(0, 200)}`)
  }
  const end = cookieHeader.indexOf(';')
  const cookie = end < 0 ? cookieHeader : cookieHeader.slice(0, end)
  let tokens: SharedHostDeviceTokens | undefined
  try {
    const body: unknown = JSON.parse(bodyText)
    if (typeof body === 'object' && body !== null && 'tokens' in body) {
      const raw = (body as { tokens?: unknown }).tokens
      if (typeof raw === 'object' && raw !== null) {
        const candidate = raw as Record<string, unknown>
        if (typeof candidate.accessToken === 'string' && typeof candidate.refreshToken === 'string'
          && typeof candidate.expiresAt === 'number' && Number.isFinite(candidate.expiresAt)
          && Array.isArray(candidate.scopes) && candidate.scopes.every(scope => typeof scope === 'string')) {
          tokens = {
            accessToken: candidate.accessToken,
            refreshToken: candidate.refreshToken,
            expiresAt: candidate.expiresAt,
            scopes: candidate.scopes as string[],
          }
        }
      }
    }
  } catch {
    // Cookie Peer is enough for sync; token echo is optional.
  }
  return tokens === undefined ? { cookie } : { cookie, tokens }
}

/**
 * Response headers not relayed to the renderer. `set-cookie` would hand the
 * Host's authentication cookie to the page's cookie jar, which the shell owns
 * instead; the rest describe the Node `fetch` connection (its encoding, length,
 * and hop-by-hop transport), which Chromium never sees.
 */
const WITHHELD_RESPONSE_HEADERS = [
  'set-cookie',
  'content-encoding', 'content-length',
  'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization',
]

/** Host routes whose responses carry immutable cache headers keyed by a per-process revision. */
const PLUGIN_BUNDLE_PATH = /^\/plugins\//u

/**
 * Unary `/api/<namespace>/…` RPCs that describe or mutate the owned Desktop Host
 * plugin surface. Online Remote Client keeps these on the local Host while
 * session/workspace sync uses the shared Host Peer.
 */
const DESKTOP_OWNED_API = new RegExp(
  '^/api/(pluginInventory|pluginManager|pluginMarket|pluginRecommendations|'
  + 'pluginRegistryProbe|dynamicCordisRunner)(?:/|$)',
  'u',
)

/**
 * Paths that must stay on the owned Desktop Host while the shell is a shared-Host
 * Remote Client: boot injections name local plugin revisions, so `/plugins` and
 * plugin-inventory RPCs cannot follow `streamBaseUrl` to the Web Host.
 */
export function isDesktopOwnedHostPath(pathname: string): boolean {
  return PLUGIN_BUNDLE_PATH.test(pathname) || DESKTOP_OWNED_API.test(pathname)
}

/** Choose which Host cookie Peer should answer one Desktop renderer request. */
export function resolveDesktopHostForward(
  pathname: string,
  options: {
    readonly ownsHost: boolean
    readonly activeHostUrl: string
    readonly activeHostCookie: string
    readonly localHostUrl?: string
    readonly localHostCookie?: string
    /** When dual-plane is online, sidecar RPCs target the inactive Host. */
    readonly sidecarHostUrl?: string
    readonly sidecarHostCookie?: string
  },
): { readonly hostUrl: string; readonly hostCookie: string; readonly pathname?: string } | undefined {
  if (isSidecarApiPath(pathname)) {
    if (options.sidecarHostUrl === undefined || options.sidecarHostCookie === undefined) return undefined
    return {
      hostUrl: options.sidecarHostUrl,
      hostCookie: options.sidecarHostCookie,
      pathname: stripSidecarApiPrefix(pathname),
    }
  }
  if (!options.ownsHost && isDesktopOwnedHostPath(pathname)) {
    if (options.localHostUrl === undefined || options.localHostCookie === undefined) return undefined
    return { hostUrl: options.localHostUrl, hostCookie: options.localHostCookie }
  }
  return { hostUrl: options.activeHostUrl, hostCookie: options.activeHostCookie }
}


/**
 * Forward local application requests to its authenticated Host, preserving streaming and cancellation.
 * Plugin bundle responses lose their `cache-control` for `no-store`: the Host marks them immutable
 * under a revision that changes every launch, so Chromium's disk cache would only accumulate bundles
 * no later launch can reuse.
 * @param request - Request from the application origin.
 * @param host - Owned Host URL.
 * @param cookie - Host-issued authentication cookie.
 * @returns Host response without connection-level headers.
 */
export async function forwardWebRequest(
  request: Request,
  host: string,
  cookie: string,
  rewritePathname?: string,
): Promise<Response> {
  const source = new URL(request.url)
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== 'dsh-app://app') return new Response(null, { status: 403 })
  const target = new URL(host)
  target.pathname = rewritePathname ?? source.pathname
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site']) headers.delete(name)
  headers.set('cookie', cookie)
  const init = { method: request.method, headers, body: request.body, signal: request.signal, duplex: 'half', redirect: 'manual' as const }
  const response = await fetch(target, init)
  const outgoing = new Headers(response.headers)
  for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name)
  if (PLUGIN_BUNDLE_PATH.test(source.pathname)) outgoing.set('cache-control', 'no-store')
  return new Response(response.body, { status: response.status, headers: outgoing })
}

/**
 * Whether Desktop already has a model path that does not need a local API key.
 * Online Remote Client uses shared-Host platform models (device ticket); offline
 * still depends on locally configured provider keys.
 */
export function desktopHasModelCredentials(options: {
  readonly sharedHostOnline: boolean
  readonly localHasApiKey: boolean
}): boolean {
  return options.sharedHostOnline || options.localHasApiKey
}

/**
 * Dual-client conversation follow requires the Gateway WebSocket and /api RPC
 * to target the same Host Peer world. Online Remote Client: shared Host origin.
 * Offline: owned local Desktop Host origin.
 */
export function desktopFollowTransportAligned(options: {
  readonly ownsHost: boolean
  readonly streamBaseUrl: string
  readonly activeHostUrl: string
}): boolean {
  try {
    const stream = new URL(options.streamBaseUrl).origin
    const active = new URL(options.activeHostUrl).origin
    if (stream !== active) return false
    return options.ownsHost || stream.length > 0
  } catch {
    return false
  }
}
