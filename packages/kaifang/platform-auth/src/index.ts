/** KaifangMeta IAM authorization for one shared multi-user Web Host. */
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
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
export { isKaifangUserPrincipal, platformModelProviderId, platformUserKey } from './identity.ts'
export type { KaifangUserPrincipal } from './identity.ts'

const AUTH_PATH = '/kaifang/auth'
const CALLBACK_SUFFIX = `${AUTH_PATH}/callback`
const SESSION_INDEX_KEY = credentialKey('kaifang-platform-auth', 'sessions')
const SESSION_COOKIE = 'dsh_kaifang_auth'
const RECORD_VERSION = 1
const ATTEMPT_TTL_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 8

const SESSION_ROLE = {
  name: 'platform-user-session',
  resource: 'session',
  actions: [
    'session/create', 'session/selectModel', 'session/openWorkspacePath', 'session/workspacePathApplications',
    'session/rename', 'session/fork', 'session/prompt', 'session/attachment', 'session/updateQueue',
    'session/cancel', 'session/page', 'session/follow', 'session/projections', 'session/list', 'session/search', 'session/control',
    'workspace/insertSessionBefore', 'workspace/archiveSession', 'workspace/unarchiveSession',
    'workspace/pinSession', 'workspace/unpinSession', 'workspace/follow',
  ],
} satisfies RemoteAccessRole<'session'>

const WORKSPACE_ROLE = {
  name: 'platform-user-workspace',
  resource: 'workspace',
  actions: [
    'workspace/create', 'workspace/initializeDefault', 'workspace/rename', 'workspace/delete', 'session/create',
    'workspace/insertBefore', 'workspace/insertSessionBefore', 'workspace/archiveSession',
    'workspace/unarchiveSession', 'workspace/pinSession', 'workspace/unpinSession', 'workspace/follow',
  ],
} satisfies RemoteAccessRole<'workspace'>

// No-resource RPCs resolve to the global resource. Keep this allowlist limited
// to safe startup/read operations; workspace and session mutations are bound
// to the user's persisted resources above.
const GLOBAL_ROLE = {
  name: 'platform-user-global',
  resource: 'global',
  actions: [
    'workspace/create', 'workspace/initializeDefault', 'workspace/follow',
    'session/create', 'session/list', 'session/search', 'session/control', 'session/modelCatalog',
    'session/initializeDefaultModel', 'settings/describe', 'credentials/describe',
    'llm/listProviders', 'llm/listConfigurableProviders',
    'directoryPicker/list', 'directoryPicker/createDirectory',
  ],
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
  /** One exact callback URI registered in IAM for the shared Web Host. */
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
  readonly expiresAt: number
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
  const cookie = headerValue(headers, 'cookie')
  if (cookie === undefined) return undefined
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    const value = rest.join('=')
    if (name === SESSION_COOKIE && /^[A-Za-z0-9_-]{43}$/u.test(value)) return value
  }
  return undefined
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
  if (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && (issuer.hostname === 'localhost' || issuer.hostname === '127.0.0.1' || issuer.hostname === '::1'))) {
    throw new Error('kaifang-platform-auth: IAM issuer must use HTTPS except on loopback development')
  }
  if (callback.protocol !== 'https:' && !(callback.protocol === 'http:' && (callback.hostname === 'localhost' || callback.hostname === '127.0.0.1' || callback.hostname === '::1'))) {
    throw new Error('kaifang-platform-auth: redirectUri must use HTTPS except on loopback development')
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

  start(): { readonly authorizeUrl: string; readonly sessionId: string } {
    this.pruneAttempts()
    const sessionId = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    if (this.attempts.size >= MAX_ATTEMPTS) {
      const oldest = this.attempts.keys().next().value as string | undefined
      if (oldest !== undefined) this.attempts.delete(oldest)
    }
    this.attempts.set(state, { verifier, sessionId, expiresAt: Date.now() + ATTEMPT_TTL_MS })
    const authorize = new URL('authorize', `${this.config.issuer.replace(/\/+$/u, '')}/`)
    authorize.searchParams.set('client_id', this.config.clientId)
    authorize.searchParams.set('redirect_uri', this.config.redirectUri)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('code_challenge_method', 'S256')
    authorize.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
    authorize.searchParams.set('state', state)
    return { authorizeUrl: authorize.href, sessionId }
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
      redirect_uri: this.config.redirectUri,
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

  private pruneAttempts(): void {
    const now = Date.now()
    for (const [state, attempt] of this.attempts) if (attempt.expiresAt <= now) this.attempts.delete(state)
  }

  private findByIdentity(identity: Pick<KaifangUserPrincipal, 'sub' | 'tid'>): StoredSession | undefined {
    return [...this.sessions.values()].find(session => session.sub === identity.sub
      && session.tid === identity.tid && session.expiresAt > Date.now())
  }

  accessTokenForProvider(provider: string): string | undefined {
    return [...this.sessions.values()].find(session => platformModelProviderId(session) === provider
      && session.expiresAt > Date.now())?.accessToken
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

/** The OAuth redirect is cross-site by design; bind it to this Host's exact registered callback authority. */
function checkCallbackAuthority(
  config: ResolvedPlatformAuthConfig,
  req: IncomingMessage,
  res: ServerResponse,
  allowExternalOrigin = false,
): boolean {
  const host = req.headers.host
  const callback = new URL(config.redirectUri)
  const origin = req.headers.origin
  const fetchMode = req.headers['sec-fetch-mode']
  let hostMatches = false
  try { hostMatches = typeof host === 'string' && new URL(`${callback.protocol}//${host}`).host === callback.host }
  catch { hostMatches = false }
  const originMatches = allowExternalOrigin || origin === undefined || origin === new URL(config.issuer).origin
  const navigation = fetchMode === undefined || fetchMode === 'navigate'
  if (hostMatches && originMatches && navigation) return true
  writeText(res, 403, 'forbidden')
  return false
}

function sessionCookie(config: ResolvedPlatformAuthConfig, sessionId: string | undefined, maxAge: number): string {
  const value = sessionId ?? ''
  // OAuth routes live below `/kaifang/auth`, while the UI and Connection RPC
  // use `/` and `/api`; the dedicated Host origin scopes this cookie.
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(maxAge)}`
    + (new URL(config.redirectUri).protocol === 'https:' ? '; Secure' : '')
}

function sameOriginMutation(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try { return new URL(origin).host === host && req.headers['sec-fetch-site'] !== 'cross-site' }
  catch { return false }
}

function callbackRoot(config: ResolvedPlatformAuthConfig): string {
  const callback = new URL(config.redirectUri)
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
      const sessionId = sessionIdFromHeaders(request.headers)
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
          if (!enabled) { writeJson(res, 200, { configured: false, account: null }); return }
          const user = await auth.status(sessionIdFromHeaders(req.headers as ConnectionTrustRequest['headers']))
          writeJson(res, 200, { configured: true, account: user === null ? null : {
            username: user.username, displayName: user.displayName, email: user.email, avatarUrl: null,
          } })
        })),
        webCtx.webServer.register(route(`${AUTH_PATH}/entry`, (req, res) => {
          if (!checkCallbackAuthority(resolved, req, res, true)) return
          if (req.method !== 'GET') { writeText(res, 405, 'method not allowed'); return }
          if (!enabled) { writeText(res, 503, 'KaifangMeta IAM is not configured for this Web Host'); return }
          const sessionId = sessionIdFromHeaders(req.headers as ConnectionTrustRequest['headers'])
          if (auth.hasLiveSession(sessionId)) {
            res.writeHead(303, {
              location: webCtx.connection.authenticatedUrl(callbackRoot(resolved)),
              'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
            })
            res.end()
            return
          }
          const attempt = auth.start()
          res.writeHead(302, {
            location: attempt.authorizeUrl,
            'set-cookie': sessionCookie(resolved, attempt.sessionId, 60 * 60 * 24 * 30),
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          })
          res.end()
        })),
        webCtx.webServer.register(route(`${AUTH_PATH}/start`, (req, res) => {
          if (!checkTrusted(webCtx.connection, req, res)) return
          if (req.method !== 'GET') { writeText(res, 405, 'method not allowed'); return }
          if (!enabled) { writeText(res, 503, 'KaifangMeta IAM is not configured for this Web Host'); return }
          const attempt = auth.start()
          res.writeHead(302, {
            location: attempt.authorizeUrl,
            'set-cookie': sessionCookie(resolved, attempt.sessionId, 60 * 60 * 24 * 30),
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          })
          res.end()
        })),
        webCtx.webServer.register(route(CALLBACK_SUFFIX, async (req, res) => {
          if (!checkCallbackAuthority(resolved, req, res)) return
          if (req.method !== 'GET') { writeText(res, 405, 'method not allowed'); return }
          if (!enabled) { writeText(res, 503, 'KaifangMeta IAM is not configured for this Web Host'); return }
          const url = requestUrl(req)
          const states = url.searchParams.getAll('state')
          const codes = url.searchParams.getAll('code')
          const sessionId = sessionIdFromHeaders(req.headers as ConnectionTrustRequest['headers'])
          const state = states[0]
          const code = codes[0]
          if (states.length !== 1 || codes.length !== 1 || state === undefined || code === undefined || url.searchParams.has('error')) {
            writeText(res, 400, 'Sign-in was cancelled or the callback was invalid. Return to the Harness Web app and try again.')
            return
          }
          if (sessionId === undefined) {
            writeText(res, 400, 'Sign-in session is missing. Return to the Harness Web app and try again.')
            return
          }
          try {
            await auth.complete(code, state, sessionId)
            res.writeHead(303, {
              location: webCtx.connection.authenticatedUrl(callbackRoot(resolved)),
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
            })
            res.end()
          } catch (error) {
            console.warn('[kaifang-platform-auth] OAuth callback failed', error)
            writeText(res, 400, 'Sign-in could not be completed. Return to the Harness Web app and try again.')
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
              'set-cookie': sessionCookie(resolved, undefined, 0),
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
