/**
 * KaifangLab sign-in for a plain browser, the Web counterpart of the Desktop welcome window.
 * The connection settings and the signed-in session live in this origin's `localStorage`; the session holds the access token.
 * Browser sign-in opens `{webUrl}/authorize` in a new tab with a loopback `kaifang/callback.html` redirect; that page hands
 * `{ token, state, error }` back through {@link KAIFANG_CALLBACK_KEY}, and only a reply carrying the pending `state` is accepted.
 */
import type { KaifangAccount, KaifangBridge } from './kaifang-account.ts'

/** KaifangLab API endpoint, its browser authorization page, and authorization code. */
export interface KaifangConnection {
  readonly systemUrl: string
  /** KaifangLab Web origin whose `/authorize` page completes browser sign-in. */
  readonly webUrl: string
  readonly authCode: string
}

/** Field rule that rejected a connection. */
export type KaifangConnectionInvalid = 'url-required' | 'url-invalid' | 'web-url-required' | 'web-url-invalid' | 'auth-code-required'

/** Password sign-in outcome; `unreachable` covers transport failures to the system URL. */
export type KaifangPasswordResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'username-required' | 'password-required' | 'invalid-credentials' | 'unreachable' | 'failed' }

/** Browser sign-in progress shown by the sign-in page. */
export type KaifangBrowserState =
  | { readonly phase: 'idle' }
  /** The authorization page is open in another tab; `url` reopens it when the browser blocked the tab. */
  | { readonly phase: 'waiting'; readonly url: string }
  | { readonly phase: 'completing' }
  | { readonly phase: 'failed' }

/** Snapshot published to the sign-in page and the account launcher. */
export interface KaifangWebState {
  /** Signed-in account; null shows the sign-in page. */
  readonly account: KaifangAccount | null
  readonly browser: KaifangBrowserState
}

/** Values shown before the user saves a connection; the authorization code has no default. */
export const DEFAULT_KAIFANG_CONNECTION: KaifangConnection = { systemUrl: 'http://127.0.0.1:9999', webUrl: 'http://localhost:5173', authCode: '' }
/** `localStorage` key the callback page writes; the value is the JSON `{ token, state, error }` from the redirect. */
export const KAIFANG_CALLBACK_KEY = 'dsh.kaifang.callback'
/** Callback page, relative to the Web document; KaifangLab accepts only loopback `…/kaifang/callback.html` redirects. */
export const KAIFANG_CALLBACK_PATH = 'kaifang/callback.html'
const CONNECTION_KEY = 'dsh.kaifang.connection'
const SESSION_KEY = 'dsh.kaifang.session'
const TOKEN_PATH = 'api/v1/base/access_token'
const USERINFO_PATH = 'api/v1/base/userinfo'

/** Browser effects; the client passes `window` facilities and tests pass doubles. */
export interface WebKaifangOptions {
  /** `localStorage`, or undefined when the browser denies it; the page then keeps nothing across reloads. */
  readonly storage: Storage | undefined
  readonly fetch: typeof fetch
  /** @param url - authorization page to open in a new tab; a blocked tab leaves the page's link to open it. */
  readonly open: (url: string) => void
  /** Absolute URL of {@link KAIFANG_CALLBACK_PATH} for this document. */
  readonly callbackUrl: string
  /** Deadline for one KaifangLab request. */
  readonly timeoutMs: number
  readonly now: () => number
  /** @returns an unguessable attempt state. */
  readonly randomState: () => string
}

interface Session {
  readonly systemUrl: string
  readonly accessToken: string
  readonly expiresAt: number | null
  readonly user: KaifangAccount
}

type Failure = { ok: false; reason: 'invalid-credentials' | 'unreachable' | 'failed' }

function httpUrl(value: string): boolean {
  let url: URL
  try { url = new URL(value) } catch (_invalidUrl) {
    // An unparsable URL is a form error, not an operation failure.
    return false
  }
  return url.protocol === 'http:' || url.protocol === 'https:'
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/**
 * Normalize form input or a stored document into a saveable connection.
 * @param value - untrusted form input or stored JSON.
 * @returns the trimmed connection, or the first failed field rule.
 */
export function validateKaifangConnection(
  value: unknown,
): { ok: true; value: KaifangConnection } | { ok: false; reason: KaifangConnectionInvalid } {
  const input = record(value)
  const systemUrl = typeof input.systemUrl === 'string' ? input.systemUrl.trim() : ''
  const webUrl = typeof input.webUrl === 'string' ? input.webUrl.trim() : ''
  const authCode = typeof input.authCode === 'string' ? input.authCode.trim() : ''
  if (systemUrl === '') return { ok: false, reason: 'url-required' }
  if (!httpUrl(systemUrl)) return { ok: false, reason: 'url-invalid' }
  if (webUrl === '') return { ok: false, reason: 'web-url-required' }
  if (!httpUrl(webUrl)) return { ok: false, reason: 'web-url-invalid' }
  if (authCode === '') return { ok: false, reason: 'auth-code-required' }
  return { ok: true, value: { systemUrl, webUrl, authCode } }
}

function endpoint(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).href
}

function jwtExpiry(token: string): number | null {
  const payload = token.split('.')[1]
  if (payload === undefined) return null
  try {
    const claims = record(JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))))
    if (typeof claims.exp === 'number') return claims.exp * 1000
  } catch (_opaqueToken) {
    // KaifangLab issues JWTs; an opaque token simply has no locally known expiry.
  }
  return null
}

function account(value: unknown): KaifangAccount | undefined {
  const input = record(value)
  if (typeof input.username !== 'string' || typeof input.displayName !== 'string') return undefined
  const email = input.email === null || typeof input.email === 'string' ? input.email : undefined
  const avatarUrl = input.avatarUrl === null || typeof input.avatarUrl === 'string' ? input.avatarUrl : undefined
  if (email === undefined || avatarUrl === undefined) return undefined
  return { username: input.username, displayName: input.displayName, email, avatarUrl }
}

/** Owns the plain-browser KaifangLab session, settings, and at most one browser sign-in attempt. */
export class WebKaifang implements KaifangBridge {
  private state: KaifangWebState
  private pendingState: string | undefined
  private readonly accountListeners = new Set<(account: KaifangAccount | null) => void>()
  private readonly stateListeners = new Set<() => void>()

  /** @param options - browser effects and timing. */
  constructor(private readonly options: WebKaifangOptions) {
    this.state = { account: this.readSession()?.user ?? null, browser: { phase: 'idle' } }
  }

  /**
   * Read the state the sign-in page renders.
   * @returns the latest snapshot.
   */
  snapshot(): KaifangWebState { return this.state }

  /**
   * Observe the state the sign-in page renders.
   * @param listener - called after each snapshot change.
   * @returns subscription disposer.
   */
  watch(listener: () => void): () => void {
    this.stateListeners.add(listener)
    return () => { this.stateListeners.delete(listener) }
  }

  /** @returns the signed-in account, or null when no usable session is stored. */
  current(): Promise<KaifangAccount | null> { return Promise.resolve(this.state.account) }

  /** @returns immediately; the sign-in page is visible whenever no account is signed in. */
  signIn(): Promise<void> { return Promise.resolve() }

  /** @returns after the session is removed and the sign-in page shows. */
  signOut(): Promise<void> {
    this.remove(SESSION_KEY)
    this.publish({ account: null, browser: { phase: 'idle' } })
    return Promise.resolve()
  }

  /** @returns after the stored session's profile is re-read; a failed read keeps the stored account. */
  async refresh(): Promise<void> {
    const session = this.readSession()
    if (session === undefined) return
    const profile = await this.profile(session.accessToken)
    if (!profile.ok || this.readSession()?.accessToken !== session.accessToken) return
    const current = this.state.account
    const user = profile.user
    if (current !== null && current.username === user.username && current.displayName === user.displayName
      && current.email === user.email && current.avatarUrl === user.avatarUrl) return
    if (!this.write(SESSION_KEY, { ...session, user } satisfies Session)) return
    this.publish({ ...this.state, account: user })
  }

  /** @param listener - receives each sign-in and sign-out. @returns subscription disposer. */
  subscribe(listener: (account: KaifangAccount | null) => void): () => void {
    this.accountListeners.add(listener)
    return () => { this.accountListeners.delete(listener) }
  }

  /**
   * Read the system settings used by password and browser sign-in.
   * @returns the saved connection, or its defaults when none is saved or the stored value is invalid.
   */
  connection(): KaifangConnection {
    const parsed = validateKaifangConnection(this.readJson(CONNECTION_KEY))
    return parsed.ok ? parsed.value : DEFAULT_KAIFANG_CONNECTION
  }

  /**
   * Validate and store the connection.
   * @param value - form input.
   * @returns the field rule failure, `write-failed` when storage is unavailable, or success.
   */
  saveConnection(value: KaifangConnection): { ok: true } | { ok: false; reason: KaifangConnectionInvalid | 'write-failed' } {
    const parsed = validateKaifangConnection(value)
    if (!parsed.ok) return parsed
    return this.write(CONNECTION_KEY, parsed.value) ? { ok: true } : { ok: false, reason: 'write-failed' }
  }

  /**
   * Exchange an account and password for a session against the saved system URL.
   * @param credentials - form input.
   * @returns the outcome; success publishes the account.
   */
  async passwordSignIn(credentials: { username: string; password: string }): Promise<KaifangPasswordResult> {
    const username = credentials.username.trim()
    if (username === '') return { ok: false, reason: 'username-required' }
    if (credentials.password === '') return { ok: false, reason: 'password-required' }
    const { systemUrl } = this.connection()
    const token = await this.call(endpoint(systemUrl, TOKEN_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username, password: credentials.password }),
    })
    if (!token.ok) return token
    const accessToken = token.data.access_token
    if (typeof accessToken !== 'string' || accessToken === '') return { ok: false, reason: 'failed' }
    return this.establish(accessToken)
  }

  /** Open the KaifangLab authorization page in a new tab and wait for its callback. */
  startBrowserSignIn(): void {
    const { webUrl } = this.connection()
    const state = this.options.randomState()
    this.pendingState = state
    const url = new URL('authorize', webUrl.endsWith('/') ? webUrl : `${webUrl}/`)
    url.searchParams.set('redirect_uri', this.options.callbackUrl)
    url.searchParams.set('state', state)
    this.publish({ ...this.state, browser: { phase: 'waiting', url: url.href } })
    this.options.open(url.href)
  }

  /** Forget the pending attempt; a later callback for it is ignored. */
  cancelBrowserSignIn(): void {
    this.pendingState = undefined
    this.publish({ ...this.state, browser: { phase: 'idle' } })
  }

  /**
   * Accept the callback page's reply for the pending attempt.
   * @param raw - {@link KAIFANG_CALLBACK_KEY} value; replies for other attempts are ignored.
   */
  async receiveCallback(raw: string | null): Promise<void> {
    if (raw === null || this.pendingState === undefined) return
    let reply: Record<string, unknown>
    try { reply = record(JSON.parse(raw)) } catch (_malformed) {
      // Only the callback page writes this key; a malformed value is not a reply to this attempt.
      return
    }
    if (reply.state !== this.pendingState) return
    this.pendingState = undefined
    this.remove(KAIFANG_CALLBACK_KEY)
    const token = typeof reply.token === 'string' ? reply.token : ''
    if (token === '') {
      this.publish({ ...this.state, browser: reply.error === 'access_denied' ? { phase: 'idle' } : { phase: 'failed' } })
      return
    }
    this.publish({ ...this.state, browser: { phase: 'completing' } })
    const result = await this.establish(token)
    if (!result.ok) this.publish({ ...this.state, browser: { phase: 'failed' } })
  }

  private async establish(accessToken: string): Promise<{ ok: true } | Failure> {
    const { systemUrl } = this.connection()
    const profile = await this.profile(accessToken)
    if (!profile.ok) return profile
    const { user } = profile
    const session: Session = { systemUrl, accessToken, expiresAt: jwtExpiry(accessToken), user }
    if (!this.write(SESSION_KEY, session)) return { ok: false, reason: 'failed' }
    this.publish({ account: user, browser: { phase: 'idle' } })
    return { ok: true }
  }

  /** Read the account profile for a token from the saved system URL. */
  private async profile(accessToken: string): Promise<{ ok: true; user: KaifangAccount } | Failure> {
    const { systemUrl, webUrl } = this.connection()
    const profile = await this.call(endpoint(systemUrl, USERINFO_PATH), { method: 'GET', headers: { token: accessToken, accept: 'application/json' } })
    if (!profile.ok) return profile
    const { username, nickname, email, avatar } = profile.data
    if (typeof username !== 'string' || username === '') return { ok: false, reason: 'failed' }
    let avatarUrl: string | null = null
    if (typeof avatar === 'string' && avatar !== '') {
      const url = new URL(avatar, webUrl)
      if (url.protocol === 'http:' || url.protocol === 'https:') avatarUrl = url.href
    }
    return {
      ok: true,
      user: {
        username,
        displayName: typeof nickname === 'string' && nickname.trim() !== '' ? nickname.trim() : username,
        email: typeof email === 'string' && email !== '' ? email : null,
        avatarUrl,
      },
    }
  }

  /** Send one KaifangLab request and decode its `{ code, msg, data }` envelope. */
  private async call(url: string, init: RequestInit): Promise<{ ok: true; data: Record<string, unknown> } | Failure> {
    let response: Response
    try {
      response = await this.options.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs) })
    } catch (_transport) {
      // DNS, connection, CORS, and timeout failures all mean the configured system is unreachable.
      return { ok: false, reason: 'unreachable' }
    }
    let body: unknown
    try { body = await response.json() } catch (_notJson) {
      // A non-JSON reply means the URL does not point at a KaifangLab API.
      return { ok: false, reason: 'failed' }
    }
    // KaifangLab rejects unknown users, wrong passwords, disabled accounts, and invalid tokens with 400 or 401.
    if (response.status === 400 || response.status === 401 || response.status === 403) return { ok: false, reason: 'invalid-credentials' }
    const envelope = record(body)
    if (!response.ok || envelope.code !== 200 || typeof envelope.data !== 'object' || envelope.data === null) return { ok: false, reason: 'failed' }
    return { ok: true, data: record(envelope.data) }
  }

  private readSession(): Session | undefined {
    const input = record(this.readJson(SESSION_KEY))
    const user = account(input.user)
    if (typeof input.systemUrl !== 'string' || typeof input.accessToken !== 'string' || user === undefined) return undefined
    const expiresAt = input.expiresAt === null || typeof input.expiresAt === 'number' ? input.expiresAt : undefined
    if (expiresAt === undefined || input.systemUrl !== this.connection().systemUrl) return undefined
    if (expiresAt !== null && expiresAt <= this.options.now()) return undefined
    return { systemUrl: input.systemUrl, accessToken: input.accessToken, expiresAt, user }
  }

  private readJson(key: string): unknown {
    let raw: string | null | undefined
    try { raw = this.options.storage?.getItem(key) } catch (_denied) {
      // A browser that denies storage behaves as if nothing was saved.
      return undefined
    }
    if (raw === null || raw === undefined) return undefined
    try { return JSON.parse(raw) } catch (_malformed) {
      // A hand-edited or truncated value is treated as absent.
      return undefined
    }
  }

  private write(key: string, value: object): boolean {
    if (this.options.storage === undefined) return false
    try { this.options.storage.setItem(key, JSON.stringify(value)) } catch (_denied) {
      // Quota or privacy settings refused the write; callers report a failed save.
      return false
    }
    return true
  }

  private remove(key: string): void {
    try { this.options.storage?.removeItem(key) } catch (_denied) {
      // A browser that denies storage has nothing stored to remove.
    }
  }

  private publish(next: KaifangWebState): void {
    const accountChanged = next.account !== this.state.account
    this.state = next
    for (const listener of this.stateListeners) listener()
    if (accountChanged) for (const listener of this.accountListeners) listener(next.account)
  }
}

/**
 * Build the session owner over a browser window's storage, network, tabs, and callback page.
 * @param scope - the document's window.
 * @param timeoutMs - deadline for one KaifangLab request.
 * @returns the session owner; a window that denies storage keeps the session only until the page reloads.
 */
export function browserKaifang(scope: Window, timeoutMs: number): WebKaifang {
  let storage: Storage | undefined
  try { storage = scope.localStorage } catch (_denied) {
    // Privacy settings can deny storage; sign-in then lasts until the page reloads.
    storage = undefined
  }
  return new WebKaifang({
    storage,
    fetch: (input, init) => scope.fetch(input, init),
    open: (url) => { scope.open(url, '_blank', 'noopener') },
    callbackUrl: new URL(KAIFANG_CALLBACK_PATH, scope.document.baseURI).href,
    timeoutMs,
    now: () => Date.now(),
    randomState: () => Array.from(scope.crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join(''),
  })
}
