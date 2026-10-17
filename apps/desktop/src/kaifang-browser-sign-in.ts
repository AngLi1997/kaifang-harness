/**
 * Browser sign-in through the KaifangLab Web authorization page.
 * One attempt opens `{webUrl}/authorize` with a loopback callback; KaifangLab redirects the browser back to
 * `http://127.0.0.1:{port}/kaifang/callback?token=…&state=…` after the user approves, and the listener closes on settlement.
 * Attempts are published as the welcome window's account state, so its sign-in page renders them unchanged.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AccountView, SignInAttemptId, SignInAttemptView } from '@deepseek-ai/dsh-deepseek-account/types'

/** Callback path the KaifangLab authorization page accepts. */
export const KAIFANG_CALLBACK_PATH = '/kaifang/callback'

/** Outcome of exchanging a callback token. */
export type KaifangCompletion = 'succeeded' | 'rejected' | 'failed'

/** Desktop-owned effects of one browser attempt. */
export interface KaifangBrowserSignInOptions {
  /** Time from opening the page until an unanswered attempt expires. */
  readonly ttlMs: number
  /** @param view - latest attempt projection for the welcome window. */
  readonly publish: (view: AccountView) => void
  /** @param url - authorization page to open in the system browser. */
  readonly openBrowser: (url: string) => void
  /**
   * Verify and store a callback token.
   * @param token - KaifangLab access token from the redirect.
   * @returns `rejected` when KaifangLab refuses the token, `failed` for other failures.
   */
  readonly complete: (token: string) => Promise<KaifangCompletion>
  /** @param outcome - callback result. @returns HTML shown in the browser tab after the redirect. */
  readonly callbackPage: (outcome: 'succeeded' | 'cancelled' | 'failed') => string
}

interface Attempt {
  view: SignInAttemptView
  readonly webUrl: string
  readonly state: string
  server: Server | undefined
  timer: ReturnType<typeof setTimeout> | undefined
}

const ACTIVE = new Set<SignInAttemptView['phase']>(['initializing', 'waiting-browser', 'exchanging', 'committing'])

/** Owns at most one browser sign-in attempt and its loopback listener. */
export class KaifangBrowserSignIn {
  private attempt: Attempt | undefined

  /** @param options - timing and desktop effects. */
  constructor(private readonly options: KaifangBrowserSignInOptions) {}

  /** @returns the current projection; links point at the Web URL because no Platform pages exist for KaifangLab. */
  view(): AccountView {
    const webUrl = this.attempt?.webUrl ?? 'http://localhost/'
    return { status: 'signed-out', links: { usageUrl: webUrl, topUpUrl: webUrl }, attempt: this.attempt?.view ?? null }
  }

  /**
   * Start an attempt, or return the one still running.
   * @param webUrl - KaifangLab Web URL from the saved settings.
   * @returns the waiting attempt; a listener failure yields a failed attempt.
   */
  async start(webUrl: string): Promise<AccountView> {
    const current = this.attempt
    if (current !== undefined && ACTIVE.has(current.view.phase)) return this.view()
    this.release(current)
    const attempt: Attempt = {
      view: { id: randomUUID() as SignInAttemptId, phase: 'initializing' },
      webUrl, state: randomBytes(24).toString('base64url'), server: undefined, timer: undefined,
    }
    this.attempt = attempt
    this.options.publish(this.view())
    let port: number
    try {
      port = await this.listen(attempt)
    } catch (error) {
      console.warn('desktop kaifang: could not open the sign-in callback listener', error)
      this.settle(attempt, { phase: 'failed', errorCode: 'network' })
      return this.view()
    }
    if (this.attempt !== attempt || attempt.view.phase !== 'initializing') return this.view()
    const authorize = new URL('authorize', webUrl.endsWith('/') ? webUrl : `${webUrl}/`)
    authorize.searchParams.set('redirect_uri', `http://127.0.0.1:${String(port)}${KAIFANG_CALLBACK_PATH}`)
    authorize.searchParams.set('state', attempt.state)
    const expiresAt = Date.now() + this.options.ttlMs
    attempt.timer = setTimeout(() => { this.settle(attempt, { phase: 'expired', errorCode: 'expired' }) }, this.options.ttlMs)
    this.update(attempt, { id: attempt.view.id, phase: 'waiting-browser', authorizeUrl: authorize.href, expiresAt })
    this.options.openBrowser(authorize.href)
    return this.view()
  }

  /**
   * Cancel the attempt unless its token is already being stored.
   * @param id - attempt shown by the welcome window.
   * @returns the settled projection.
   */
  cancel(id: SignInAttemptId): AccountView {
    const attempt = this.attempt
    if (attempt?.view.id === id && (attempt.view.phase === 'initializing' || attempt.view.phase === 'waiting-browser')) {
      this.settle(attempt, { phase: 'cancelled' })
    }
    return this.view()
  }

  /**
   * @param id - attempt whose link is requested.
   * @returns the authorization URL while that attempt waits for the browser, otherwise undefined.
   */
  authorizeUrl(id: SignInAttemptId): string | undefined {
    const view = this.attempt?.view
    return view?.id === id && view.phase === 'waiting-browser' ? view.authorizeUrl : undefined
  }

  /** Close the listener and forget the attempt without publishing. */
  dispose(): void {
    this.release(this.attempt)
    this.attempt = undefined
  }

  private listen(attempt: Attempt): Promise<number> {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method !== 'GET' || url.pathname !== KAIFANG_CALLBACK_PATH) {
        response.writeHead(404).end()
        return
      }
      const reply = (outcome: 'succeeded' | 'cancelled' | 'failed'): void => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          .end(this.options.callbackPage(outcome))
      }
      if (this.attempt !== attempt || attempt.view.phase !== 'waiting-browser' || url.searchParams.get('state') !== attempt.state) {
        reply('failed')
        return
      }
      const token = url.searchParams.get('token')
      if (url.searchParams.get('error') !== null || token === null || token === '') {
        reply('cancelled')
        this.settle(attempt, { phase: 'cancelled' })
        return
      }
      this.update(attempt, { id: attempt.view.id, phase: 'exchanging' })
      void this.options.complete(token).then((outcome) => {
        reply(outcome === 'succeeded' ? 'succeeded' : 'failed')
        this.settle(attempt, outcome === 'succeeded' ? { phase: 'succeeded' }
          : { phase: 'failed', errorCode: outcome === 'rejected' ? 'protocol' : 'network' })
      }, (error: unknown) => {
        console.error('desktop kaifang: could not complete browser sign-in', error)
        reply('failed')
        this.settle(attempt, { phase: 'failed', errorCode: 'storage' })
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

  private update(attempt: Attempt, view: SignInAttemptView): void {
    if (this.attempt !== attempt) return
    attempt.view = view
    this.options.publish(this.view())
  }

  private settle(attempt: Attempt, outcome: Omit<SignInAttemptView, 'id'>): void {
    if (this.attempt !== attempt || !ACTIVE.has(attempt.view.phase)) return
    this.release(attempt)
    this.update(attempt, { id: attempt.view.id, ...outcome })
  }

  private release(attempt: Attempt | undefined): void {
    if (attempt === undefined) return
    clearTimeout(attempt.timer)
    attempt.timer = undefined
    // A closing server ends the in-flight reply's connection after it is written; idle keep-alive sockets close now.
    attempt.server?.close()
    attempt.server?.closeIdleConnections()
    attempt.server = undefined
  }
}
