/** Browser account view backed by the shared Host's per-user KaifangMeta IAM session. */
import type { KaifangAccount, KaifangBridge } from './kaifang-account.ts'

/** Retained as a source-compatible type for account integrations; Web auth no longer stores these values. */
export interface KaifangConnection {
  readonly systemUrl: string
  readonly webUrl: string
  readonly authCode: string
}

export type KaifangConnectionInvalid = 'url-required' | 'url-invalid' | 'web-url-required' | 'web-url-invalid' | 'auth-code-required'
export type KaifangPasswordResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'username-required' | 'password-required' | 'invalid-credentials' | 'unreachable' | 'failed' }
export type KaifangBrowserState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'waiting'; readonly url: string }
  | { readonly phase: 'completing' }
  | { readonly phase: 'failed' }
export interface KaifangWebState {
  readonly account: KaifangAccount | null
  readonly browser: KaifangBrowserState
}

/** Kept only for the account page's existing typed operations; values are not read or written in Web mode. */
export const DEFAULT_KAIFANG_CONNECTION: KaifangConnection = { systemUrl: 'http://127.0.0.1:9999', webUrl: 'http://localhost:5173', authCode: '' }
/** Retired browser callback storage key. The IAM callback is now processed by the Web Host. */
export const KAIFANG_CALLBACK_KEY = 'dsh.kaifang.callback'
export const KAIFANG_CALLBACK_PATH = '/kaifang/auth/callback'

/** Browser effects passed by the owning client plugin. */
export interface WebKaifangOptions {
  readonly storage?: Storage | undefined
  readonly fetch: typeof fetch
  readonly open: (url: string) => void
  readonly callbackUrl?: string
  readonly statusUrl?: string
  readonly startUrl?: string
  readonly cancelUrl?: string
  readonly logoutUrl?: string
  readonly timeoutMs: number
  readonly now?: () => number
  readonly randomState?: () => string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAccount(value: unknown): KaifangAccount | null {
  if (!isRecord(value) || typeof value.username !== 'string' || typeof value.displayName !== 'string') return null
  const email = value.email === null || typeof value.email === 'string' ? value.email : null
  const avatarUrl = value.avatarUrl === null || typeof value.avatarUrl === 'string' ? value.avatarUrl : null
  return { username: value.username, displayName: value.displayName, email, avatarUrl }
}

/** Reads the HttpOnly-backed platform session and starts its same-origin OAuth flow. */
export class WebKaifang implements KaifangBridge {
  private state: KaifangWebState = { account: null, browser: { phase: 'idle' } }
  private readonly accountListeners = new Set<(account: KaifangAccount | null) => void>()
  private readonly stateListeners = new Set<() => void>()

  constructor(private readonly options: WebKaifangOptions) {}

  snapshot(): KaifangWebState { return this.state }

  watch(listener: () => void): () => void {
    this.stateListeners.add(listener)
    return () => { this.stateListeners.delete(listener) }
  }

  current(): Promise<KaifangAccount | null> { return Promise.resolve(this.state.account) }

  signIn(): Promise<void> {
    this.startBrowserSignIn()
    return Promise.resolve()
  }

  async signOut(): Promise<void> {
    if (this.options.logoutUrl === undefined) throw new Error('Platform sign-out endpoint is unavailable')
    const response = await this.request(this.options.logoutUrl, { method: 'POST' })
    if (!response.ok) throw new Error('Could not sign out of the platform account')
    this.publish({ account: null, browser: { phase: 'idle' } })
  }

  async refresh(): Promise<void> {
    let response: Response
    if (this.options.statusUrl === undefined) return
    try { response = await this.request(this.options.statusUrl) }
    catch { return }
    if (!response.ok) return
    let body: unknown
    try { body = await response.json() } catch { return }
    const account = isRecord(body) ? parseAccount(body.account) : null
    if (account === null && this.state.account === null) return
    if (account !== null && this.sameAccount(account, this.state.account)) {
      if (this.state.browser.phase !== 'idle') this.publish({ account, browser: { phase: 'idle' } })
      return
    }
    this.publish({ account, browser: { phase: 'idle' } })
  }

  subscribe(listener: (account: KaifangAccount | null) => void): () => void {
    this.accountListeners.add(listener)
    return () => { this.accountListeners.delete(listener) }
  }

  /** Legacy settings operations are unavailable because the platform issuer is configured by the Host. */
  connection(): KaifangConnection { return DEFAULT_KAIFANG_CONNECTION }
  saveConnection(_value: KaifangConnection): { ok: false; reason: KaifangConnectionInvalid | 'write-failed' } {
    return { ok: false, reason: 'write-failed' }
  }
  passwordSignIn(_credentials: { username: string; password: string }): Promise<KaifangPasswordResult> {
    return Promise.resolve({ ok: false, reason: 'failed' })
  }
  receiveCallback(_raw: string | null): Promise<void> { return Promise.resolve() }

  startBrowserSignIn(): void {
    const url = this.options.startUrl ?? ''
    this.publish({ ...this.state, browser: { phase: 'waiting', url } })
    this.options.open(url)
  }

  cancelBrowserSignIn(): void {
    if (this.options.cancelUrl !== undefined) void this.request(this.options.cancelUrl, { method: 'POST' }).catch(() => {})
    this.publish({ ...this.state, browser: { phase: 'idle' } })
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    return this.options.fetch(url, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(this.options.timeoutMs),
    })
  }

  private sameAccount(left: KaifangAccount, right: KaifangAccount | null): boolean {
    return right !== null && left.username === right.username && left.displayName === right.displayName
      && left.email === right.email && left.avatarUrl === right.avatarUrl
  }

  private publish(next: KaifangWebState): void {
    const changed = next.account === null ? this.state.account !== null : !this.sameAccount(next.account, this.state.account)
    this.state = next
    for (const listener of this.stateListeners) listener()
    if (changed) for (const listener of this.accountListeners) listener(next.account)
  }
}

/** Build the platform session view over same-origin Host routes. */
export function browserKaifang(scope: Window, timeoutMs: number): WebKaifang {
  const route = (name: string): string => new URL(`kaifang/auth/${name}`, scope.document.baseURI).href
  return new WebKaifang({
    fetch: (input, init) => scope.fetch(input, init),
    open: (url) => { scope.open(url, '_blank', 'noopener') },
    statusUrl: route('status'),
    startUrl: route('start'),
    cancelUrl: route('cancel'),
    logoutUrl: route('logout'),
    timeoutMs,
  })
}
