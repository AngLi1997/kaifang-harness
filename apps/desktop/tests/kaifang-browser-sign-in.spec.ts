import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import { KaifangBrowserSignIn, type KaifangCompletion } from '../src/kaifang-browser-sign-in.ts'

const controllers: KaifangBrowserSignIn[] = []
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose() })

function setup(complete: (token: string) => Promise<KaifangCompletion> = async () => 'succeeded', ttlMs = 60_000) {
  const views: AccountView[] = []
  const opened: string[] = []
  const options = {
    ttlMs,
    publish: (view: AccountView) => { views.push(view) },
    openBrowser: (url: string) => { opened.push(url) },
    complete: vi.fn(complete),
    callbackPage: (outcome: string) => `<p>${outcome}</p>`,
  }
  const controller = new KaifangBrowserSignIn(options)
  controllers.push(controller)
  return { controller, views, opened, options }
}

async function waiting(controller: KaifangBrowserSignIn) {
  const view = await controller.start('http://localhost:5173')
  const authorize = new URL(view.attempt!.authorizeUrl!)
  const callback = new URL(authorize.searchParams.get('redirect_uri')!)
  return { view, authorize, callback, state: authorize.searchParams.get('state')! }
}

function callbackUrl(callback: URL, params: Record<string, string>): string {
  const url = new URL(callback)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.href
}

describe('KaifangLab browser sign-in', () => {
  it('opens the authorization page with a loopback callback and completes on a matching redirect', async () => {
    const { controller, views, opened, options } = setup()
    const { view, authorize, callback, state } = await waiting(controller)
    expect(view.attempt).toMatchObject({ phase: 'waiting-browser' })
    expect(`${authorize.origin}${authorize.pathname}`).toBe('http://localhost:5173/authorize')
    expect(callback.hostname).toBe('127.0.0.1')
    expect(callback.pathname).toBe('/kaifang/callback')
    expect(opened).toEqual([authorize.href])
    expect(controller.authorizeUrl(view.attempt!.id)).toBe(authorize.href)

    const response = await fetch(callbackUrl(callback, { token: 'tok', state }))
    expect(await response.text()).toBe('<p>succeeded</p>')
    expect(options.complete).toHaveBeenCalledExactlyOnceWith('tok')
    expect(views.map(item => item.attempt?.phase)).toEqual(['initializing', 'waiting-browser', 'exchanging', 'succeeded'])
    expect(controller.authorizeUrl(view.attempt!.id)).toBeUndefined()
    await expect(fetch(callbackUrl(callback, { token: 'tok', state }))).rejects.toThrow()
  })

  it('ignores a redirect with another state and treats a denial as cancellation', async () => {
    const { controller, options } = setup()
    const { callback, state } = await waiting(controller)
    expect(await (await fetch(callbackUrl(callback, { token: 'tok', state: 'forged' }))).text()).toBe('<p>failed</p>')
    expect(controller.view().attempt?.phase).toBe('waiting-browser')
    expect(await (await fetch(callbackUrl(callback, { error: 'access_denied', state }))).text()).toBe('<p>cancelled</p>')
    expect(controller.view().attempt?.phase).toBe('cancelled')
    expect(options.complete).not.toHaveBeenCalled()
  })

  it.each([
    ['rejected', 'protocol'],
    ['failed', 'network'],
  ] as const)('reports a %s token as a failed attempt', async (outcome, errorCode) => {
    const { controller } = setup(async () => outcome)
    const { callback, state } = await waiting(controller)
    expect(await (await fetch(callbackUrl(callback, { token: 'tok', state }))).text()).toBe('<p>failed</p>')
    expect(controller.view().attempt).toMatchObject({ phase: 'failed', errorCode })
  })

  it('reuses a running attempt, cancels it, and expires an unanswered one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { controller } = setup(undefined, 1_000)
      const first = await waiting(controller)
      expect((await controller.start('http://localhost:5173')).attempt?.id).toBe(first.view.attempt!.id)
      expect(controller.cancel(first.view.attempt!.id).attempt?.phase).toBe('cancelled')
      const second = await waiting(controller)
      expect(second.view.attempt!.id).not.toBe(first.view.attempt!.id)
      vi.advanceTimersByTime(1_000)
      expect(controller.view().attempt).toMatchObject({ phase: 'expired', errorCode: 'expired' })
    } finally { vi.useRealTimers() }
  })
})
