/**
 * System-browser Platform IAM sign-in (authorization code + PKCE).
 * Opens `{issuer}/authorize` with a loopback callback; IAM redirects to
 * `http://127.0.0.1:{port}/kaifang/auth/callback?code=…&state=…` after the user approves.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PlatformSession, PlatformSessionUser } from './platform-session.ts'

/** Callback path registered for the `kaifang-harness` desktop client. */
export const PLATFORM_CALLBACK_PATH = '/kaifang/auth/callback'

/** Public OAuth client id shared with the Web Host. */
export const PLATFORM_CLIENT_ID = 'kaifang-harness'

/** Audience expected on user access tokens. */
export const PLATFORM_AUDIENCE = 'kaifang-meta-platform'

const REQUIRED_SCOPE = 'model:invoke'

/** HTTP client used for discovery, token, and userinfo. */
export type PlatformSend = (input: string, init?: RequestInit) => Promise<Response>

/** OIDC endpoints discovered from the Platform origin. */
export interface PlatformOidcEndpoints {
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly userinfoEndpoint: string
}

/** Outcome of one browser attempt. */
export type PlatformBrowserSignInResult =
  | { readonly ok: true; readonly session: PlatformSession }
  | { readonly ok: false; readonly reason: 'url-required' | 'unreachable' | 'cancelled' | 'expired' | 'denied' | 'failed' }

/** Desktop-owned effects of one browser attempt. */
export interface PlatformBrowserSignInOptions {
  readonly ttlMs: number
  readonly send: PlatformSend
  readonly openBrowser: (url: string) => void
  /** @param outcome - callback result. @returns HTML shown in the browser tab after the redirect. */
  readonly callbackPage: (outcome: 'succeeded' | 'cancelled' | 'failed') => string
}

interface Attempt {
  readonly platformOrigin: string
  readonly endpoints: PlatformOidcEndpoints
  readonly state: string
  readonly verifier: string
  redirectUri: string
  server: Server | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  settle: (result: PlatformBrowserSignInResult) => void
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`IAM response is missing ${label}`)
  return value
}

function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]
  if (payload === undefined) throw new Error('IAM returned a malformed access token')
  try { return record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))) }
  catch { throw new Error('IAM returned a malformed access token') }
}

/** Discover OIDC endpoints from a Platform origin (gateway or local portal proxy). */
export async function discoverPlatformOidc(platformOrigin: string, send: PlatformSend, timeoutMs = 10_000): Promise<PlatformOidcEndpoints> {
  const discovery = new URL('/kaifang-meta/iam/.well-known/openid-configuration', platformOrigin.endsWith('/') ? platformOrigin : `${platformOrigin}/`)
  let response: Response
  try {
    response = await send(discovery.href, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    })
  } catch (error) {
    console.warn('desktop platform: OIDC discovery transport failed', discovery.href, error)
    throw new Error('unreachable')
  }
  if (!response.ok) {
    console.warn('desktop platform: OIDC discovery HTTP', response.status, discovery.href)
    throw new Error('unreachable')
  }
  let body: Record<string, unknown>
  try {
    body = record(await response.json())
  } catch (error) {
    console.warn('desktop platform: OIDC discovery JSON failed', discovery.href, error)
    throw new Error('unreachable')
  }
  try {
    return {
      issuer: requiredString(body.issuer, 'issuer').replace(/\/$/u, ''),
      authorizationEndpoint: requiredString(body.authorization_endpoint, 'authorization_endpoint'),
      tokenEndpoint: requiredString(body.token_endpoint, 'token_endpoint'),
      userinfoEndpoint: requiredString(body.userinfo_endpoint, 'userinfo_endpoint'),
    }
  } catch (error) {
    console.warn('desktop platform: OIDC discovery payload invalid', discovery.href, body, error)
    throw new Error('unreachable')
  }
}

async function exchangeCode(
  endpoints: PlatformOidcEndpoints,
  redirectUri: string,
  code: string,
  verifier: string,
  platformOrigin: string,
  send: PlatformSend,
  timeoutMs = 10_000,
): Promise<PlatformSession> {
  let response: Response
  try {
    response = await send(endpoints.tokenEndpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: PLATFORM_CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    })
  } catch {
    throw new Error('unreachable')
  }
  if (!response.ok) throw new Error(response.status === 400 || response.status === 401 ? 'denied' : 'failed')
  const body = record(await response.json())
  const accessToken = requiredString(body.access_token, 'access_token')
  const refreshToken = requiredString(body.refresh_token, 'refresh_token')
  if (typeof body.expires_in !== 'number' || !Number.isSafeInteger(body.expires_in) || body.expires_in <= 0) {
    throw new Error('failed')
  }
  const claims = decodeClaims(accessToken)
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  const scopes = typeof claims.scope === 'string' ? claims.scope.split(/\s+/u).filter(Boolean) : []
  const sub = requiredString(claims.sub, 'sub')
  const tid = requiredString(claims.tid, 'tid')
  if (claims.iss !== endpoints.issuer || claims.azp !== PLATFORM_CLIENT_ID || !audiences.includes(PLATFORM_AUDIENCE)) {
    throw new Error('failed')
  }
  if (!scopes.includes(REQUIRED_SCOPE)) throw new Error('failed')
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) throw new Error('failed')

  let userinfo: Response
  try {
    userinfo = await send(endpoints.userinfoEndpoint, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    })
  } catch {
    throw new Error('unreachable')
  }
  if (!userinfo.ok) throw new Error('failed')
  const profile = record(await userinfo.json())
  if (profile.sub !== sub) throw new Error('failed')
  const username = typeof profile.preferred_username === 'string' && profile.preferred_username !== ''
    ? profile.preferred_username : sub
  const displayName = typeof profile.name === 'string' && profile.name !== '' ? profile.name : username
  const email = typeof profile.email === 'string' ? profile.email : null
  const user: PlatformSessionUser = { sub, tid, username, displayName, email }
  return {
    platformOrigin,
    issuer: endpoints.issuer,
    clientId: PLATFORM_CLIENT_ID,
    accessToken,
    refreshToken,
    expiresAt: Math.min(Date.now() + body.expires_in * 1000, claims.exp * 1000),
    scopes,
    user,
  }
}

/** Refresh an access token with the stored refresh token. */
export async function refreshPlatformSession(
  session: PlatformSession, send: PlatformSend, timeoutMs = 10_000,
): Promise<PlatformSession> {
  let response: Response
  try {
    response = await send(new URL('token', `${session.issuer}/`).href, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: PLATFORM_CLIENT_ID,
        refresh_token: session.refreshToken,
      }),
    })
  } catch {
    throw new Error('unreachable')
  }
  if (!response.ok) throw new Error('denied')
  const body = record(await response.json())
  const accessToken = requiredString(body.access_token, 'access_token')
  const refreshToken = requiredString(body.refresh_token, 'refresh_token')
  if (typeof body.expires_in !== 'number' || !Number.isSafeInteger(body.expires_in) || body.expires_in <= 0) {
    throw new Error('failed')
  }
  const claims = decodeClaims(accessToken)
  const scopes = typeof claims.scope === 'string' ? claims.scope.split(/\s+/u).filter(Boolean) : session.scopes
  if (typeof claims.exp !== 'number') throw new Error('failed')
  return {
    ...session,
    accessToken,
    refreshToken,
    expiresAt: Math.min(Date.now() + body.expires_in * 1000, claims.exp * 1000),
    scopes,
  }
}

/** Owns at most one browser sign-in attempt and its loopback listener. */
export class PlatformBrowserSignIn {
  private attempt: Attempt | undefined

  constructor(private readonly options: PlatformBrowserSignInOptions) {}

  /** Start an attempt, or return the one still running. */
  async start(platformOrigin: string): Promise<PlatformBrowserSignInResult> {
    if (platformOrigin.trim() === '') return { ok: false, reason: 'url-required' }
    if (this.attempt !== undefined) {
      return await new Promise<PlatformBrowserSignInResult>((resolve) => {
        const current = this.attempt
        if (current === undefined) {
          resolve({ ok: false, reason: 'failed' })
          return
        }
        const previous = current.settle
        current.settle = (result) => { previous(result); resolve(result) }
      })
    }

    let endpoints: PlatformOidcEndpoints
    try {
      endpoints = await discoverPlatformOidc(platformOrigin, this.options.send)
    } catch {
      return { ok: false, reason: 'unreachable' }
    }

    return await new Promise<PlatformBrowserSignInResult>((resolve) => {
      const attempt: Attempt = {
        platformOrigin,
        endpoints,
        state: randomBytes(24).toString('base64url'),
        verifier: randomBytes(32).toString('base64url'),
        redirectUri: '',
        server: undefined,
        timer: undefined,
        settle: (result) => {
          if (this.attempt !== attempt) return
          this.release(attempt)
          this.attempt = undefined
          resolve(result)
        },
      }
      this.attempt = attempt
      void this.listen(attempt).then((port) => {
        if (this.attempt !== attempt) return
        attempt.redirectUri = `http://127.0.0.1:${String(port)}${PLATFORM_CALLBACK_PATH}`
        const authorize = new URL(endpoints.authorizationEndpoint)
        authorize.searchParams.set('client_id', PLATFORM_CLIENT_ID)
        authorize.searchParams.set('redirect_uri', attempt.redirectUri)
        authorize.searchParams.set('response_type', 'code')
        authorize.searchParams.set('code_challenge_method', 'S256')
        authorize.searchParams.set('code_challenge', createHash('sha256').update(attempt.verifier).digest('base64url'))
        authorize.searchParams.set('state', attempt.state)
        authorize.searchParams.set('scope', REQUIRED_SCOPE)
        attempt.timer = setTimeout(() => { attempt.settle({ ok: false, reason: 'expired' }) }, this.options.ttlMs)
        this.options.openBrowser(authorize.href)
      }, (error: unknown) => {
        console.warn('desktop platform: could not open the sign-in callback listener', error)
        attempt.settle({ ok: false, reason: 'failed' })
      })
    })
  }

  /** Cancel the in-flight attempt, if any. */
  cancel(): void {
    this.attempt?.settle({ ok: false, reason: 'cancelled' })
  }

  /** Close the listener without publishing a result when the process is quitting. */
  dispose(): void {
    const attempt = this.attempt
    if (attempt === undefined) return
    this.release(attempt)
    this.attempt = undefined
  }

  private listen(attempt: Attempt): Promise<number> {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method !== 'GET' || url.pathname !== PLATFORM_CALLBACK_PATH) {
        response.writeHead(404).end()
        return
      }
      const reply = (outcome: 'succeeded' | 'cancelled' | 'failed'): void => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          .end(this.options.callbackPage(outcome))
      }
      if (this.attempt !== attempt || url.searchParams.get('state') !== attempt.state) {
        reply('failed')
        return
      }
      if (url.searchParams.get('error') !== null) {
        reply('cancelled')
        attempt.settle({ ok: false, reason: url.searchParams.get('error') === 'access_denied' ? 'denied' : 'cancelled' })
        return
      }
      const code = url.searchParams.get('code')
      if (code === null || code === '') {
        reply('cancelled')
        attempt.settle({ ok: false, reason: 'cancelled' })
        return
      }
      void exchangeCode(attempt.endpoints, attempt.redirectUri, code, attempt.verifier, attempt.platformOrigin, this.options.send)
        .then((session) => {
          reply('succeeded')
          attempt.settle({ ok: true, session })
        }, (error: unknown) => {
          console.warn('desktop platform: could not complete browser sign-in', error)
          const message = error instanceof Error ? error.message : 'failed'
          reply('failed')
          attempt.settle({
            ok: false,
            reason: message === 'unreachable' || message === 'denied' ? message : 'failed',
          })
        })
    })
    attempt.server = server
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve((server.address() as AddressInfo).port)
      })
    })
  }

  private release(attempt: Attempt): void {
    clearTimeout(attempt.timer)
    attempt.timer = undefined
    attempt.server?.close()
    attempt.server?.closeIdleConnections()
    attempt.server = undefined
  }
}
