/** KaifangMeta IAM authorization for one shared multi-user Web Host. */
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { TLSSocket } from 'node:tls'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ConnectionAdmissionProvider, ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type { RemoteAccessBinding, RemoteAccessRole } from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type { KaifangUserPrincipal } from './identity.ts'
import { platformModelProviderId, platformUserKey } from './identity.ts'
import { registerPlatformModelProvider } from './model-provider.ts'
import {
  PLATFORM_USER_GLOBAL_ACTIONS,
  PLATFORM_USER_SESSION_ACTIONS,
  PLATFORM_USER_WORKSPACE_ACTIONS,
} from './peer-roles.ts'
export {
  PLATFORM_USER_GLOBAL_ACTIONS,
  PLATFORM_USER_SESSION_ACTIONS,
  PLATFORM_USER_WORKSPACE_ACTIONS,
} from './peer-roles.ts'
export { isKaifangUserPrincipal, platformModelProviderId, platformUserKey } from './identity.ts'
export type { KaifangUserPrincipal } from './identity.ts'

const AUTH_PATH = '/kaifang/auth'
const CALLBACK_SUFFIX = `${AUTH_PATH}/callback`
const SESSION_INDEX_KEY = credentialKey('kaifang-platform-auth', 'sessions')
const SESSION_COOKIE = 'dsh_kaifang_auth'
const LOCAL_SESSION_COOKIE = `${SESSION_COOKIE}_local`
const ATTEMPT_COOKIE_PREFIX = `${SESSION_COOKIE}_attempt_`
const RECORD_VERSION = 1
const ATTEMPT_TTL_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 8

const SESSION_ROLE = {
  name: 'platform-user-session',
  resource: 'session',
  actions: [...PLATFORM_USER_SESSION_ACTIONS],
} satisfies RemoteAccessRole<'session'>

const WORKSPACE_ROLE = {
  name: 'platform-user-workspace',
  resource: 'workspace',
  actions: [...PLATFORM_USER_WORKSPACE_ACTIONS],
} satisfies RemoteAccessRole<'workspace'>

// No-resource RPCs resolve to the global resource. Keep this allowlist limited
// to safe startup/read operations; workspace and session mutations are bound
// to the user's persisted resources above.
const GLOBAL_ROLE = {
  name: 'platform-user-global',
  resource: 'global',
  actions: [...PLATFORM_USER_GLOBAL_ACTIONS],
} satisfies RemoteAccessRole<'global'>

/** Identity claims displayed by the Web account menu. */
export interface PlatformUser {
  readonly sub: string
  readonly username: string
  readonly displayName: string
  readonly email: string | null
}

/** Host-only access to the current platform session. Tokens never cross the browser wire. */
export interface PlatformAuthHandle {
  /** @param identity - authenticated user and tenant. @returns that user's current access token. */
  accessToken(identity: Pick<KaifangUserPrincipal, 'sub' | 'tid'>): string | undefined
  /** @param identity - authenticated user and tenant. @returns that user's profile, or null. */
  current(identity: Pick<KaifangUserPrincipal, 'sub' | 'tid'>): PlatformUser | null
  /** 按当前用户和租户注册模型路由，并返回不透明 provider id。 */
  ensureModelProvider(identity: Pick<KaifangUserPrincipal, 'sub' | 'tid'>): string
}

declare module '@deepseek-ai/cordis' {
  interface Context { kaifangPlatformAuth: PlatformAuthHandle }
}

/** Shared Web Host platform IAM settings. */
export interface PlatformAuthConfig {
  /** IAM issuer URL, for example `https://meta.example/kaifang-meta/iam`. */
  issuer?: string
  /** Registered public OAuth client. */
  clientId?: string
  /** Shared Host callback URI; local development reuses its scheme, port, path, and query for local host aliases. */
  redirectUri?: string
  /** User-token audience expected from the platform. */
  audience?: string
  /** Scopes that must be granted before this Host admits RPC traffic. */
  requiredScopes?: string[]
  /** Refresh an access token this many seconds before expiry. */
  refreshSkewSeconds?: number
  /** Deadline for one IAM HTTP request. */
  requestTimeoutMs?: number
}

interface ResolvedPlatformAuthConfig {
  issuer: string
  clientId: string
  redirectUri: string
  audience: string
  requiredScopes: string[]
  refreshSkewSeconds: number
  requestTimeoutMs: number
}

export const name = 'kaifang-platform-auth'
export const inject = ['credentials', 'llm']
export const Config: z<PlatformAuthConfig> = z.object({
  issuer: z.string().default(''),
  clientId: z.string().default('kaifang-harness'),
  redirectUri: z.string().default(''),
  audience: z.string().default('kaifang-meta-platform'),
  requiredScopes: z.array(String).default(['model:invoke']),
  refreshSkewSeconds: z.natural().min(15).default(60),
  requestTimeoutMs: z.natural().min(1000).default(10000),
})

interface StoredSession {
  readonly version: typeof RECORD_VERSION
  readonly sub: string
  readonly tid: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly scopes: readonly string[]
  readonly user: PlatformUser
}

interface Attempt {
  readonly verifier: string
  readonly sessionId: string
  readonly redirectUri: string
  readonly authorizationOrigin: string
  readonly local: boolean
  readonly expiresAt: number
}

interface SignInEndpoints {
  readonly issuer: string
  readonly redirectUri: string
  readonly authorizationOrigin: string
  readonly local: boolean
}

interface TokenReply {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly scopes: readonly string[]
  readonly sub: string
  readonly tid: string
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]
  if (payload === undefined) throw new Error('IAM returned a malformed access token')
  try { return record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))) }
  catch { throw new Error('IAM returned a malformed access token') }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`IAM response is missing ${label}`)
  return value
}

function parseUser(value: unknown, sub: string): PlatformUser {
  const input = record(value)
  if (input.sub !== sub) throw new Error('IAM userinfo subject does not match the access token')
  const username = typeof input.preferred_username === 'string' && input.preferred_username !== '' ? input.preferred_username : sub
  const displayName = typeof input.name === 'string' && input.name !== '' ? input.name : username
  const email = typeof input.email === 'string' ? input.email : null
  return { sub, username, displayName, email }
}

function parseStored(value: unknown): StoredSession | undefined {
  const input = record(value)
  const user = record(input.user)
  if (input.version !== RECORD_VERSION || typeof input.sub !== 'string' || typeof input.tid !== 'string'
    || typeof input.accessToken !== 'string' || typeof input.refreshToken !== 'string'
    || typeof input.expiresAt !== 'number' || !Number.isSafeInteger(input.expiresAt)
    || !Array.isArray(input.scopes) || !input.scopes.every(scope => typeof scope === 'string')
    || user.sub !== input.sub || typeof user.username !== 'string' || typeof user.displayName !== 'string'
    || !(user.email === null || typeof user.email === 'string')) return undefined
  return {
    version: RECORD_VERSION,
    sub: input.sub,
    tid: input.tid,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    scopes: input.scopes,
    user: { sub: input.sub, username: user.username, displayName: user.displayName, email: user.email },
  }
}

function sessionKey(sessionId: string) {
  const digest = createHash('sha256').update(sessionId).digest('hex')
  return credentialKey('kaifang-platform-auth', `session-${digest}`)
}

function parseSessionIds(value: unknown): string[] {
  const input = record(value)
  if (input.version !== RECORD_VERSION || !Array.isArray(input.sessionIds)
    || !input.sessionIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(id))) return []
  return [...new Set(input.sessionIds)] as string[]
}

function headerValue(headers: ConnectionTrustRequest['headers'], name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function sessionIdFromHeaders(headers: ConnectionTrustRequest['headers']): string | undefined {
  const host = headerValue(headers, 'host')
  if (host !== undefined) {
    try {
      if (isLocalDevelopmentHost(new URL(`http://${host}`).hostname)) {
        return cookieValue(headers, LOCAL_SESSION_COOKIE)
      }
    }
    catch {}
  }
  return cookieValue(headers, SESSION_COOKIE)
}

/** Read a Bearer access token from Authorization when Desktop presents a device ticket. */
function bearerAccessToken(headers: ConnectionTrustRequest['headers']): string | undefined {
  const value = headerValue(headers, 'authorization')
  if (value === undefined) return undefined
  const match = /^Bearer\s+(\S+)$/iu.exec(value.trim())
  return match?.[1]
}

async function readJsonBody(req: IncomingMessage, limit = 65_536): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += part.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(part)
  }
  if (chunks.length === 0) return undefined
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new Error('request body must be JSON') }
}

function attemptSessionIdFromHeaders(headers: ConnectionTrustRequest['headers'], state: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(state)) return undefined
  return cookieValue(headers, `${ATTEMPT_COOKIE_PREFIX}${state}`)
}

function cookieValue(headers: ConnectionTrustRequest['headers'], name: string): string | undefined {
  const cookie = headerValue(headers, 'cookie')
  if (cookie === undefined) return undefined
  let result: string | undefined
  for (const part of cookie.split(';')) {
    const [cookieName, ...rest] = part.trim().split('=')
    const value = rest.join('=')
    if (cookieName === name && /^[A-Za-z0-9_-]{43}$/u.test(value)) result = value
  }
  return result
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function writeText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://dsh.invalid')
}

function isLocalDevelopmentHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/gu, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized.startsWith('::ffff:')) return isLocalDevelopmentHost(normalized.slice(7))
  const version = isIP(normalized)
  if (version === 4) {
    const [a, b] = normalized.split('.').map(Number)
    return a === 10 || a === 127 || (a === 172 && b !== undefined && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  return version === 6 && (normalized === '::1' || /^(?:fc|fd|fe[89ab])/u.test(normalized))
}

function requestProtocol(req: IncomingMessage): 'http:' | 'https:' {
  const forwarded = req.headers['x-forwarded-proto']
  const externalProtocol = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined
  if (externalProtocol === 'https') return 'https:'
  if (externalProtocol === 'http') return 'http:'
  return req.socket instanceof TLSSocket ? 'https:' : 'http:'
}

function signInEndpoints(config: ResolvedPlatformAuthConfig, req: IncomingMessage, listenerPort?: number): SignInEndpoints {
  const issuer = new URL(config.issuer)
  const redirect = new URL(config.redirectUri)
  const protocol = requestProtocol(req)
  try {
    const host = req.headers.host
    if (typeof host !== 'string') throw new Error('missing Host')
    const authority = new URL(`${protocol}//${host}`)
    const defaultPort = protocol === 'https:' ? 443 : 80
    const callbackPort = listenerPort ?? Number(redirect.port || defaultPort)
    if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash
      || !isLocalDevelopmentHost(authority.hostname)
      || !isLocalDevelopmentHost(issuer.hostname)
      || !isLocalDevelopmentHost(redirect.hostname)
      || Number(authority.port || defaultPort) !== callbackPort || protocol !== redirect.protocol) {
      throw new Error('not a local alias')
    }
    const hostname = authority.hostname
    issuer.hostname = hostname
    redirect.hostname = hostname
    redirect.port = callbackPort === defaultPort ? '' : String(callbackPort)
    return {
      issuer: issuer.href.replace(/\/$/u, ''),
      redirectUri: redirect.href,
      authorizationOrigin: issuer.origin,
      local: true,
    }
  }
  catch {
    return {
      issuer: config.issuer,
      redirectUri: config.redirectUri,
      authorizationOrigin: new URL(config.issuer).origin,
      local: false,
    }
  }
}

function isLoopbackBind(host: string): boolean {
  return host === '::1' || host.startsWith('127.')
}

function resolveConfig(config?: PlatformAuthConfig): ResolvedPlatformAuthConfig {
  const value = Config(config ?? {})
  return {
    issuer: value.issuer ?? '',
    clientId: value.clientId ?? 'kaifang-harness',
    redirectUri: value.redirectUri ?? '',
    audience: value.audience ?? 'kaifang-meta-platform',
    requiredScopes: value.requiredScopes ?? ['model:invoke'],
    refreshSkewSeconds: value.refreshSkewSeconds ?? 60,
    requestTimeoutMs: value.requestTimeoutMs ?? 10000,
  }
}

function configured(config: ResolvedPlatformAuthConfig): boolean {
  return Boolean(config.issuer.trim() && config.redirectUri.trim())
}

function validateUrls(config: ResolvedPlatformAuthConfig): void {
  const issuer = new URL(config.issuer)
  const callback = new URL(config.redirectUri)
  if (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && isLocalDevelopmentHost(issuer.hostname))) {
    throw new Error('kaifang-platform-auth: IAM issuer must use HTTPS except on local development hosts')
  }
  if (callback.protocol !== 'https:' && !(callback.protocol === 'http:' && isLocalDevelopmentHost(callback.hostname))) {
    throw new Error('kaifang-platform-auth: redirectUri must use HTTPS except on local development hosts')
  }
  if (callback.pathname !== CALLBACK_SUFFIX || callback.search !== '' || callback.hash !== '') {
    throw new Error(`kaifang-platform-auth: redirectUri path must equal ${CALLBACK_SUFFIX}`)
  }
  if (!config.clientId.trim() || !config.audience.trim()) {
    throw new Error('kaifang-platform-auth: clientId and audience are required when enabled')
  }
  if (!config.requiredScopes.includes('model:invoke')) {
    throw new Error('kaifang-platform-auth: requiredScopes must include model:invoke')
  }
}

/** Owns every browser user's server-side OAuth session on one shared Web Host. */
class PlatformSession {
  private readonly sessions = new Map<string, StoredSession>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly refreshInFlight = new Map<string, Promise<StoredSession | undefined>>()
  private readonly attempts = new Map<string, Attempt>()
  private sessionEnded: ((sessionId: string, identity?: Pick<KaifangUserPrincipal, 'sub' | 'tid'>) => void) | undefined
  readonly handle: Pick<PlatformAuthHandle, 'accessToken' | 'current'> = {
    accessToken: identity => this.findByIdentity(identity)?.accessToken,
    current: identity => this.findByIdentity(identity)?.user ?? null,
  }

  constructor(private readonly credentials: CredentialProvider, private readonly config: ResolvedPlatformAuthConfig) {}

  /** Dispose live Peer connections as soon as a refresh proves the IAM session is no longer valid. */
  onSessionEnded(handler: (sessionId: string, identity?: Pick<KaifangUserPrincipal, 'sub' | 'tid'>) => void): void {
    this.sessionEnded = handler
  }

  async initialize(): Promise<void> {
    const index = await this.credentials.readRecord(SESSION_INDEX_KEY)
    if (index === undefined) return
    if (index.kind !== 'grant') {
      await this.credentials.deleteRecord(SESSION_INDEX_KEY)
      return
    }
    const sessionIds = parseSessionIds(index.payload)
    for (const sessionId of sessionIds) {
      const stored = await this.credentials.readRecord(sessionKey(sessionId))
      const session = stored?.kind === 'grant' ? parseStored(stored.payload) : undefined
      if (session === undefined) {
        await this.credentials.deleteRecord(sessionKey(sessionId))
        continue
      }
      this.sessions.set(sessionId, session)
    }
    const validIds = [...this.sessions.keys()]
    if (validIds.length !== sessionIds.length) {
      const valid = new Set(validIds)
      await this.writeSessionIndex(ids => ids.filter(id => valid.has(id)))
    }
    await Promise.all(validIds.map(async (id) => {
      const session = this.sessions.get(id)
      if (session === undefined) return
      if (session.expiresAt <= Date.now() + this.config.refreshSkewSeconds * 1000) await this.refreshSession(id)
      else this.scheduleRefresh(id)
    }))
  }

  async status(sessionId: string | undefined): Promise<PlatformUser | null> {
    if (sessionId === undefined) return null
    const session = this.sessions.get(sessionId)
    if (session === undefined) return null
    if (session.expiresAt <= Date.now() + this.config.refreshSkewSeconds * 1000) {
      const refreshed = await this.refreshSession(sessionId)
      return refreshed?.user ?? null
    }
    return session.user
  }

  hasLiveSession(sessionId: string | undefined): boolean {
    const session = sessionId === undefined ? undefined : this.sessions.get(sessionId)
    return session !== undefined && session.expiresAt > Date.now()
  }

  identity(sessionId: string | undefined): Pick<KaifangUserPrincipal, 'sub' | 'tid'> | undefined {
    const session = sessionId === undefined ? undefined : this.sessions.get(sessionId)
    if (session === undefined || session.expiresAt <= Date.now()) return undefined
    return { sub: session.sub, tid: session.tid }
  }

  start(req: IncomingMessage, listenerPort?: number): {
    readonly authorizeUrl: string
    readonly sessionId: string
    readonly state: string
    readonly endpoints: SignInEndpoints
  } {
    this.pruneAttempts()
    const sessionId = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const endpoints = signInEndpoints(this.config, req, listenerPort)
    if (this.attempts.size >= MAX_ATTEMPTS) {
      const oldest = this.attempts.keys().next().value as string | undefined
      if (oldest !== undefined) this.attempts.delete(oldest)
    }
    this.attempts.set(state, {
      verifier,
      sessionId,
      redirectUri: endpoints.redirectUri,
      authorizationOrigin: endpoints.authorizationOrigin,
      local: endpoints.local,
      expiresAt: Date.now() + ATTEMPT_TTL_MS,
    })
    const authorize = new URL('authorize', `${endpoints.issuer.replace(/\/+$/u, '')}/`)
    authorize.searchParams.set('client_id', this.config.clientId)
    authorize.searchParams.set('redirect_uri', endpoints.redirectUri)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('code_challenge_method', 'S256')
    authorize.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
    authorize.searchParams.set('state', state)
    return { authorizeUrl: authorize.href, sessionId, state, endpoints }
  }

  callbackTarget(state: string): Pick<SignInEndpoints, 'redirectUri' | 'authorizationOrigin' | 'local'> | undefined {
    const attempt = this.attempts.get(state)
    if (attempt === undefined || attempt.expiresAt < Date.now()) return undefined
    return { redirectUri: attempt.redirectUri, authorizationOrigin: attempt.authorizationOrigin, local: attempt.local }
  }

  cancelAttempt(state: string): void {
    this.attempts.delete(state)
  }

  async complete(code: string, state: string, sessionId: string): Promise<StoredSession> {
    this.pruneAttempts()
    const attempt = this.attempts.get(state)
    this.attempts.delete(state)
    if (attempt === undefined || attempt.sessionId !== sessionId || attempt.expiresAt < Date.now()) {
      throw new Error('Sign-in attempt expired; try again')
    }
    const token = await this.requestToken({
      grant_type: 'authorization_code',
      client_id: this.config.clientId,
      code,
      redirect_uri: attempt.redirectUri,
      code_verifier: attempt.verifier,
    })
    const user = await this.userinfo(token.accessToken, token.sub)
    const session: StoredSession = { version: RECORD_VERSION, ...token, user }
    await this.save(sessionId, session)
    return session
  }

  cancelAttempts(sessionId: string | undefined): void {
    for (const [state, attempt] of this.attempts) if (attempt.sessionId === sessionId) this.attempts.delete(state)
  }

  async logout(sessionId: string | undefined): Promise<void> {
    if (sessionId === undefined) return
    const session = this.sessions.get(sessionId)
    this.cancelAttempts(sessionId)
    this.sessions.delete(sessionId)
    const timer = this.timers.get(sessionId)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(sessionId)
    await this.refreshInFlight.get(sessionId)
    await this.credentials.deleteRecord(sessionKey(sessionId))
    await this.writeSessionIndex(ids => ids.filter(id => id !== sessionId))
    if (session !== undefined) this.sessionEnded?.(sessionId, { sub: session.sub, tid: session.tid })
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.attempts.clear()
    this.sessionEnded = undefined
  }

  /**
   * Admit a Desktop (or other non-browser) client that already holds Platform tokens.
   * Creates a Host session cookie Peer so RPC/WS share the same kaifang-user partition as Web.
   */
  async admitDevice(tokens: {
    accessToken: string
    refreshToken: string
    expiresAt?: number
    scopes?: readonly string[]
  }): Promise<{
    sessionId: string
    user: PlatformUser
    accessToken: string
    refreshToken: string
    expiresAt: number
    scopes: readonly string[]
  }> {
    if (tokens.refreshToken === '') {
      throw new Error('device ticket requires a refresh token')
    }
    let accessToken = tokens.accessToken
    let refreshToken = tokens.refreshToken
    let expiresAt = tokens.expiresAt
    let scopes = tokens.scopes
    let claims: Record<string, unknown> | undefined
    if (accessToken !== '') {
      try { claims = decodeClaims(accessToken) } catch { claims = undefined }
    }
    const accessExpired = claims === undefined
      || typeof claims.exp !== 'number'
      || claims.exp * 1000 <= Date.now() + 5_000
    if (accessExpired) {
      const refreshed = await this.requestToken({
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        refresh_token: refreshToken,
      })
      accessToken = refreshed.accessToken
      refreshToken = refreshed.refreshToken
      expiresAt = refreshed.expiresAt
      scopes = refreshed.scopes
      claims = decodeClaims(accessToken)
    }
    if (accessToken === '' || claims === undefined) {
      throw new Error('device ticket requires a usable access token')
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    const claimScopes = typeof claims.scope === 'string' ? claims.scope.split(/\s+/u).filter(Boolean) : []
    const sub = requiredString(claims.sub, 'sub')
    const tid = requiredString(claims.tid, 'tid')
    if (claims.iss !== this.config.issuer || claims.azp !== this.config.clientId
      || !audiences.includes(this.config.audience)) {
      throw new Error('IAM access token has unexpected issuer, audience, or authorized party')
    }
    if (!this.config.requiredScopes.every(scope => claimScopes.includes(scope))) {
      throw new Error('IAM access token is missing a required platform scope')
    }
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
      throw new Error('IAM access token is expired')
    }
    const user = await this.userinfo(accessToken, sub)
    const finalScopes = scopes !== undefined && scopes.length > 0 ? scopes : claimScopes
    const finalExpiresAt = typeof expiresAt === 'number' && Number.isFinite(expiresAt)
      ? Math.min(expiresAt, claims.exp * 1000)
      : claims.exp * 1000
    const sessionId = randomBytes(32).toString('base64url')
    const session: StoredSession = {
      version: RECORD_VERSION,
      sub,
      tid,
      accessToken,
      refreshToken,
      expiresAt: finalExpiresAt,
      scopes: finalScopes,
      user,
    }
    await this.save(sessionId, session)
    return {
      sessionId,
      user,
      accessToken,
      refreshToken,
      expiresAt: finalExpiresAt,
      scopes: finalScopes,
    }
  }

  /** Map a live Host session from a Bearer access token presented by Desktop. */
  sessionIdForAccessToken(accessToken: string): string | undefined {
    if (accessToken === '') return undefined
    for (const [sessionId, session] of this.sessions) {
      if (session.accessToken === accessToken && session.expiresAt > Date.now()) return sessionId
    }
    return undefined
  }

  private pruneAttempts(): void {
    const now = Date.now()
    for (const [state, attempt] of this.attempts) if (attempt.expiresAt <= now) this.attempts.delete(state)
  }

  private findByIdentity(identity: Pick<KaifangUserPrincipal, 'sub' | 'tid'>): StoredSession | undefined {
    const now = Date.now()
    let best: StoredSession | undefined
    for (const session of this.sessions.values()) {
      if (session.sub !== identity.sub || session.tid !== identity.tid || session.expiresAt <= now) continue
      if (best === undefined || session.expiresAt > best.expiresAt) best = session
    }
    return best
  }

  /** Prefer the freshest live Host session for this opaque platform-model provider id. */
  accessTokenForProvider(provider: string): string | undefined {
    const now = Date.now()
    let best: StoredSession | undefined
    for (const session of this.sessions.values()) {
      if (platformModelProviderId(session) !== provider || session.expiresAt <= now) continue
      if (best === undefined || session.expiresAt > best.expiresAt) best = session
    }
    return best?.accessToken
  }

  private async refreshSession(sessionId: string): Promise<StoredSession | undefined> {
    const active = this.refreshInFlight.get(sessionId)
    if (active !== undefined) return active
    const current = this.sessions.get(sessionId)
    if (current === undefined) return undefined
    const operation = (async () => {
      try {
        const token = await this.requestToken({
          grant_type: 'refresh_token', client_id: this.config.clientId, refresh_token: current.refreshToken,
        })
        const user = await this.userinfo(token.accessToken, token.sub)
        // Logout removes the exact in-memory record before awaiting this
        // refresh; never let the late response recreate that session.
        if (this.sessions.get(sessionId) !== current) return undefined
        const refreshed: StoredSession = { version: RECORD_VERSION, ...token, user }
        await this.save(sessionId, refreshed)
        return refreshed
      } catch (error) {
        this.sessions.delete(sessionId)
        const timer = this.timers.get(sessionId)
        if (timer !== undefined) clearTimeout(timer)
        this.timers.delete(sessionId)
        this.sessionEnded?.(sessionId, { sub: current.sub, tid: current.tid })
        await this.credentials.deleteRecord(sessionKey(sessionId))
        await this.writeSessionIndex(ids => ids.filter(id => id !== sessionId))
        console.warn('[kaifang-platform-auth] platform session refresh failed; sign-in is required', error)
        return undefined
      }
    })()
    this.refreshInFlight.set(sessionId, operation)
    try { return await operation }
    finally { if (this.refreshInFlight.get(sessionId) === operation) this.refreshInFlight.delete(sessionId) }
  }

  private async requestToken(fields: Record<string, string>): Promise<TokenReply> {
    const tokenEndpoint = new URL('token', `${this.config.issuer.replace(/\/+$/u, '')}/`)
    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields),
    })
    if (!response.ok) throw new Error(`IAM token endpoint returned HTTP ${response.status}`)
    const body = record(await response.json())
    const accessToken = requiredString(body.access_token, 'access_token')
    const refreshToken = requiredString(body.refresh_token, 'refresh_token')
    if (typeof body.expires_in !== 'number' || !Number.isSafeInteger(body.expires_in) || body.expires_in <= 0) {
      throw new Error('IAM response has an invalid expires_in')
    }
    const claims = decodeClaims(accessToken)
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    const scopes = typeof claims.scope === 'string' ? claims.scope.split(/\s+/u).filter(Boolean) : []
    const sub = requiredString(claims.sub, 'sub')
    const tid = requiredString(claims.tid, 'tid')
    if (claims.iss !== this.config.issuer || claims.azp !== this.config.clientId || !audiences.includes(this.config.audience)) {
      throw new Error('IAM access token has unexpected issuer, audience, or authorized party')
    }
    if (!this.config.requiredScopes.every(scope => scopes.includes(scope))) {
      throw new Error('IAM access token is missing a required platform scope')
    }
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) throw new Error('IAM access token is expired')
    return {
      accessToken,
      refreshToken,
      expiresAt: Math.min(Date.now() + body.expires_in * 1000, claims.exp * 1000),
      scopes,
      sub,
      tid,
    }
  }

  private async userinfo(accessToken: string, sub: string): Promise<PlatformUser> {
    const endpoint = new URL('userinfo', `${this.config.issuer.replace(/\/+$/u, '')}/`)
    const response = await fetch(endpoint, {
      redirect: 'error',
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`IAM userinfo endpoint returned HTTP ${response.status}`)
    return parseUser(await response.json(), sub)
  }

  private async save(sessionId: string, session: StoredSession): Promise<void> {
    await this.credentials.modifyRecord(sessionKey(sessionId), async () => ({ kind: 'grant', payload: session } satisfies CredentialRecord))
    await this.writeSessionIndex(ids => [...new Set([...ids, sessionId])])
    this.sessions.set(sessionId, session)
    this.scheduleRefresh(sessionId)
  }

  private async writeSessionIndex(update: (sessionIds: string[]) => string[]): Promise<void> {
    await this.credentials.modifyRecord(SESSION_INDEX_KEY, async (current) => {
      const sessionIds = update(current?.kind === 'grant' ? parseSessionIds(current.payload) : [])
      return sessionIds.length === 0
        ? undefined
        : { kind: 'grant', payload: { version: RECORD_VERSION, sessionIds } } satisfies CredentialRecord
    })
  }

  private scheduleRefresh(sessionId: string): void {
    const previous = this.timers.get(sessionId)
    if (previous !== undefined) clearTimeout(previous)
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    const delay = Math.max(1000, session.expiresAt - Date.now() - this.config.refreshSkewSeconds * 1000)
    const timer = setTimeout(() => { void this.refreshSession(sessionId) }, delay)
    this.timers.set(sessionId, timer)
    timer.unref?.()
  }
}

function checkTrusted(connection: Context['connection'], req: IncomingMessage, res: ServerResponse): boolean {
  // Desktop profile does not require platform trust checks for its internal Host/API requests.
  if (process.env.ELECTRON_RUN_AS_NODE === '1') return true
  if (connection.trustRejection === undefined) {
    writeText(res, 403, 'forbidden')
    return false
  }
  const rejection = connection.trustRejection(req as ConnectionTrustRequest)
  if (rejection === undefined) return true
  writeText(res, rejection, rejection === 403 ? 'forbidden' : 'unauthorized')
  return false
}

function registerAdmissionProvider(
  connection: Context['connection'],
  provider: ConnectionAdmissionProvider,
): () => void {
  if (connection.registerAdmissionProvider === undefined) {
    throw new Error('kaifang-platform-auth: Web Host Connection does not support identity-aware Peer admission')
  }
  return connection.registerAdmissionProvider(provider)
}

/** Bind the OAuth callback to the authority selected for its saved PKCE state. */
function checkCallbackAuthority(
  req: IncomingMessage,
  res: ServerResponse,
  target: Pick<SignInEndpoints, 'redirectUri' | 'authorizationOrigin'>,
  allowExternalOrigin = false,
): boolean {
  const host = req.headers.host
  const callback = new URL(target.redirectUri)
  const origin = req.headers.origin
  const fetchMode = req.headers['sec-fetch-mode']
  let hostMatches = false
  try { hostMatches = typeof host === 'string' && new URL(`${callback.protocol}//${host}`).host === callback.host }
  catch { hostMatches = false }
  const originMatches = allowExternalOrigin || origin === undefined || origin === target.authorizationOrigin
  const navigation = fetchMode === undefined || fetchMode === 'navigate'
  if (hostMatches && originMatches && navigation) return true
  writeText(res, 403, 'forbidden')
  return false
}

function sessionCookie(
  sessionId: string | undefined,
  maxAge: number,
  endpoints: Pick<SignInEndpoints, 'redirectUri' | 'local'>,
): string {
  const cookieName = endpoints.local ? LOCAL_SESSION_COOKIE : SESSION_COOKIE
  const value = sessionId ?? ''
  if (endpoints.local) {
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(maxAge)}`
      + (new URL(endpoints.redirectUri).protocol === 'https:' ? '; Secure' : '')
  }
  // Cross-site OAuth may run in an iframe; partition this cookie by top-level site.
  return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=${String(maxAge)}`
}

function attemptCookie(
  state: string,
  sessionId: string | undefined,
  maxAge: number,
  endpoints: Pick<SignInEndpoints, 'redirectUri' | 'local'>,
): string {
  const name = `${ATTEMPT_COOKIE_PREFIX}${state}`
  const value = sessionId ?? ''
  if (endpoints.local) {
    return `${name}=${value}; Path=${CALLBACK_SUFFIX}; HttpOnly; SameSite=Lax; Max-Age=${String(maxAge)}`
      + (new URL(endpoints.redirectUri).protocol === 'https:' ? '; Secure' : '')
  }
  return `${name}=${value}; Path=${CALLBACK_SUFFIX}; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=${String(maxAge)}`
}

function sameOriginMutation(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try { return new URL(origin).host === host && req.headers['sec-fetch-site'] !== 'cross-site' }
  catch { return false }
}

function callbackRoot(redirectUri: string): string {
  const callback = new URL(redirectUri)
  callback.pathname = '/'
  callback.search = ''
  callback.hash = ''
  return callback.href
}

function route(path: string, handler: WebRoute['handler']): WebRoute {
  return { kind: 'exact', path, handler }
}

/** Register shared-host OAuth routes and select a user Peer for every RPC and WebSocket request. */
export async function apply(ctx: Context, config?: PlatformAuthConfig): Promise<void> {
  const resolved = resolveConfig(config)
  const enabled = configured(resolved)
  if (Boolean(resolved.issuer?.trim()) !== Boolean(resolved.redirectUri?.trim())) {
    throw new Error('kaifang-platform-auth: configure both issuer and redirectUri, or neither')
  }
  if (enabled) validateUrls(resolved)
  const auth = new PlatformSession(ctx.credentials, resolved)
  if (enabled) await auth.initialize()
  const modelProviders = registerPlatformModelProvider(ctx, resolved.issuer, provider => auth.accessTokenForProvider(provider))
  ctx.provide('kaifangPlatformAuth', { ...auth.handle, ensureModelProvider: modelProviders.ensure })
  ctx.inject(['remoteAccess', 'workspaceRegistry'], (accessCtx) => {
    const unregister = accessCtx.remoteAccess.registerPolicy('kaifang-user', {
      bindings: (principal) => {
        const ownerId = platformUserKey(principal)
        const prefix = `user-${ownerId}-session-`
        const workspaces = accessCtx.workspaceRegistry.list().filter(workspace => workspace.ownerId === ownerId)
        const bindings: RemoteAccessBinding[] = [
          { role: GLOBAL_ROLE, resource: { kind: 'global' } },
          ...workspaces.map(workspace => ({ role: WORKSPACE_ROLE, resource: { kind: 'workspace' as const, id: workspace.id } })),
          ...workspaces.flatMap(workspace => workspace.sessionIds
            .filter(sessionId => String(sessionId).startsWith(prefix))
            .map(sessionId => ({ role: SESSION_ROLE, resource: { kind: 'session' as const, id: sessionId } }))),
        ]
        return bindings
      },
    })
    accessCtx.effect(() => unregister, 'kaifang-platform-auth: per-user Remote access policy')
  })
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    if (!enabled && !isLoopbackBind(webCtx.webServer.host)) {
      throw new Error('kaifang-platform-auth: configure IAM issuer and the shared callback before exposing the Web Host')
    }
    if (enabled && (webCtx.connection.registerAdmissionProvider === undefined
      || webCtx.connection.trustRejection === undefined || webCtx.connection.createPeer === undefined)) {
      throw new Error('kaifang-platform-auth: Web Host Connection does not support identity-aware Peer admission')
    }
    const peers = new Map<string, PeerScope>()
    auth.onSessionEnded((sessionId, identity) => {
      if (identity !== undefined && auth.handle.accessToken(identity) === undefined) modelProviders.release(identity)
      const peer = peers.get(sessionId)
      if (peer === undefined) return
      peers.delete(sessionId)
      void peer.dispose()
    })
    const provider: ConnectionAdmissionProvider = (request) => {
      if (!enabled) return undefined
      // Desktop profile runs the same Web Host but does not require platform authentication:
      // local settings and credential reads must succeed before the user completes platform login.
      // ELECTRON_RUN_AS_NODE distinguishes Desktop's Node-mode Host from the Web profile.
      if (process.env.ELECTRON_RUN_AS_NODE === '1') return undefined
      for (const [sessionId, peer] of peers) {
        if (!auth.hasLiveSession(sessionId)) {
          peers.delete(sessionId)
          void peer.dispose()
        }
      }
      let sessionId = sessionIdFromHeaders(request.headers)
      if (sessionId === undefined) {
        const bearer = bearerAccessToken(request.headers)
        if (bearer !== undefined) sessionId = auth.sessionIdForAccessToken(bearer)
      }
      const identity = auth.identity(sessionId)
      if (sessionId === undefined || identity === undefined) return { rejection: 401 }
      let peer = peers.get(sessionId)
      if (peer === undefined) {
        peer = webCtx.connection.createPeer({
          principal: { kind: 'kaifang-user', ...identity, clientId: resolved.clientId },
        })
        peers.set(sessionId, peer)
      }
      return { peer }
    }
    webCtx.effect(() => {
      const unregisterProvider = enabled
        ? registerAdmissionProvider(webCtx.connection, provider)
        : () => {}
      const disposers = [
        webCtx.webServer.register(route(`${AUTH_PATH}/status`, async (req, res) => {
          if (!checkTrusted(webCtx.connection, req, res)) return
          if (req.method !== 'GET') { writeText(res, 405, 'method not allowed'); return }
          // Desktop owns the Host with browser/owner auth; do not advertise platform IAM login.
          if (!enabled || process.env.ELECTRON_RUN_AS_NODE === '1') {
            writeJson(res, 200, { configured: false, account: null }); return
          }
          const user = await auth.status(sessionIdFromHeaders(req.headers as ConnectionTrustRequest['headers']))
          writeJson(res, 200, { configured: true, account: user === null ? null : {
            username: user.username, displayName: user.displayName, email: user.email, avatarUrl: null,
          } })
        })),
        webCtx.webServer.register(route(`${AUTH_PATH}/entry`, (req, res) => {
          if (!enabled) { writeText(res, 503, 'KaifangMeta IAM is not configured for this Web Host'); return }
          // Desktop never starts platform OAuth from the local Web surface.
          if (process.env.ELECTRON_RUN_AS_NODE === '1') {
            writeText(res, 503, 'Platform IAM sign-in is not used by Desktop Host')
            return
          }
          const endpoints = signInEndpoints(resolved, req, webCtx.webServer.port)
          if (!checkCallbackAuthority(req, res, endpoints, true)) return
          if (req.method !== 'GET') { writeText(res, 405, 'method not allowed'); return }
          const sessionId = sessionIdFromHeaders(req.headers as ConnectionTrustRequest['headers'])
          if (auth.hasLiveSession(sessionId)) {
            res.writeHead(303, {
              location: webCtx.connection.authenticatedUrl(callbackRoot(endpoints.redirectUri)),
              'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
            })
            res.end()
            return
          }
          const attempt = auth.start(req, webCtx.webServer.port)
          res.writeHead(302, {
            location: attempt.authorizeUrl,
            'set-cookie': attemptCookie(attempt.state, attempt.sessionId, Math.ceil(ATTEMPT_TTL_MS / 1000), attempt.endpoints),
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          })
          res.end()
        })),
        webCtx.webServer.register(route(`${AUTH_PATH}/start`, (req, res) => {
          if (!checkTrusted(webCtx.connection, req, res)) return
          if (req.method !== 'GET') { writeText(res, 405, 'method not allowed'); return }
          if (!enabled) { writeText(res, 503, 'KaifangMeta IAM is not configured for this Web Host'); return }
          const attempt = auth.start(req, webCtx.webServer.port)
          res.writeHead(302, {
            location: attempt.authorizeUrl,
            'set-cookie': attemptCookie(attempt.state, attempt.sessionId, Math.ceil(ATTEMPT_TTL_MS / 1000), attempt.endpoints),
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          })
          res.end()
        })),
        webCtx.webServer.register(route(CALLBACK_SUFFIX, async (req, res) => {
          if (req.method !== 'GET') { writeText(res, 405, 'method not allowed'); return }
          if (!enabled) { writeText(res, 503, 'KaifangMeta IAM is not configured for this Web Host'); return }
          const url = requestUrl(req)
          const states = url.searchParams.getAll('state')
          const codes = url.searchParams.getAll('code')
          const state = states[0]
          const code = codes[0]
          if (states.length !== 1 || codes.length !== 1 || state === undefined || code === undefined || url.searchParams.has('error')) {
            if (states.length === 1 && state !== undefined && /^[A-Za-z0-9_-]{43}$/u.test(state)) {
              const target = auth.callbackTarget(state)
              if (target !== undefined) {
                auth.cancelAttempt(state)
                res.setHeader('set-cookie', attemptCookie(state, undefined, 0, target))
              }
            }
            writeText(res, 400, 'Sign-in was cancelled or the callback was invalid. Return to the Harness Web app and try again.')
            return
          }
          const target = auth.callbackTarget(state)
          if (target === undefined) {
            writeText(res, 400, 'Sign-in attempt expired. Return to the Harness Web app and try again.')
            return
          }
          if (!checkCallbackAuthority(req, res, target)) return
          const sessionId = attemptSessionIdFromHeaders(req.headers as ConnectionTrustRequest['headers'], state)
          if (sessionId === undefined) {
            res.setHeader('set-cookie', attemptCookie(state, undefined, 0, target))
            writeText(res, 400, 'Sign-in session is missing. Return to the Harness Web app and try again.')
            return
          }
          try {
            await auth.complete(code, state, sessionId)
            res.writeHead(303, {
              location: webCtx.connection.authenticatedUrl(callbackRoot(target.redirectUri)),
              'set-cookie': [
                sessionCookie(sessionId, 60 * 60 * 24 * 30, target),
                attemptCookie(state, undefined, 0, target),
              ],
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
            })
            res.end()
          } catch (error) {
            console.warn('[kaifang-platform-auth] OAuth callback failed', error)
            res.setHeader('set-cookie', attemptCookie(state, undefined, 0, target))
            writeText(res, 400, 'Sign-in could not be completed. Return to the Harness Web app and try again.')
          }
        })),
        webCtx.webServer.register(route(`${AUTH_PATH}/device`, async (req, res) => {
          if (!checkTrusted(webCtx.connection, req, res)) return
          if (req.method !== 'POST') { writeText(res, 405, 'method not allowed'); return }
          if (!enabled) { writeText(res, 503, 'KaifangMeta IAM is not configured for this Web Host'); return }
          try {
            const body = record(await readJsonBody(req))
            const bearer = bearerAccessToken(req.headers as ConnectionTrustRequest['headers'])
            const accessToken = typeof body.accessToken === 'string'
              ? body.accessToken
              : (bearer ?? '')
            const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken : ''
            if (refreshToken === '') {
              writeText(res, 400, 'device ticket requires refreshToken')
              return
            }
            const scopes = Array.isArray(body.scopes) && body.scopes.every(scope => typeof scope === 'string')
              ? body.scopes as string[]
              : undefined
            const expiresAt = typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt)
              ? body.expiresAt
              : undefined
            const admitted = await auth.admitDevice({
              accessToken,
              refreshToken,
              ...expiresAt === undefined ? {} : { expiresAt },
              ...scopes === undefined ? {} : { scopes },
            })
            const endpoints = signInEndpoints(resolved, req, webCtx.webServer.port)
            const payload = JSON.stringify({
              ok: true,
              account: {
                username: admitted.user.username,
                displayName: admitted.user.displayName,
                email: admitted.user.email,
                avatarUrl: null,
              },
              tokens: {
                accessToken: admitted.accessToken,
                refreshToken: admitted.refreshToken,
                expiresAt: admitted.expiresAt,
                scopes: admitted.scopes,
              },
            })
            res.writeHead(200, {
              'cache-control': 'no-store',
              'content-type': 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(payload),
              'x-content-type-options': 'nosniff',
              'set-cookie': sessionCookie(admitted.sessionId, 60 * 60 * 24 * 30, endpoints),
            })
            res.end(payload)
          } catch (error) {
            console.warn('[kaifang-platform-auth] device ticket admission failed', error)
            writeText(res, 401, 'device ticket was rejected')
          }
        })),
        webCtx.webServer.register(route(`${AUTH_PATH}/cancel`, (req, res) => {
          if (!checkTrusted(webCtx.connection, req, res)) return
          if (req.method !== 'POST' || !sameOriginMutation(req)) { writeText(res, 403, 'forbidden'); return }
          auth.cancelAttempts(sessionIdFromHeaders(req.headers as ConnectionTrustRequest['headers']))
          writeJson(res, 200, { ok: true })
        })),
        webCtx.webServer.register(route(`${AUTH_PATH}/logout`, async (req, res) => {
          if (!checkTrusted(webCtx.connection, req, res)) return
          if (req.method !== 'POST' || !sameOriginMutation(req)) { writeText(res, 403, 'forbidden'); return }
          try {
            const sessionId = sessionIdFromHeaders(req.headers as ConnectionTrustRequest['headers'])
            await auth.logout(sessionId)
            const peer = sessionId === undefined ? undefined : peers.get(sessionId)
            if (sessionId !== undefined) peers.delete(sessionId)
            await peer?.dispose()
            const body = JSON.stringify({ ok: true })
            res.writeHead(200, {
              'cache-control': 'no-store',
              'content-type': 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(body),
              'x-content-type-options': 'nosniff',
              'set-cookie': sessionCookie(undefined, 0, signInEndpoints(resolved, req, webCtx.webServer.port)),
            })
            res.end(body)
          } catch (error) {
            console.error('[kaifang-platform-auth] could not clear the stored platform session', error)
            writeJson(res, 500, { ok: false })
          }
        })),
      ]
      return () => {
        unregisterProvider()
        for (const peer of peers.values()) void peer.dispose()
        peers.clear()
        for (const dispose of disposers) dispose()
        auth.dispose()
      }
    }, 'kaifang-platform-auth: IAM routes and RPC admission')
  })
}
