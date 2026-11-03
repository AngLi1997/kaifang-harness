import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PlatformBrowserSignIn, PLATFORM_CALLBACK_PATH, PLATFORM_CLIENT_ID, type PlatformSend,
} from '../src/platform-browser-sign-in.ts'

const controllers: PlatformBrowserSignIn[] = []
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose() })

function setup(send?: PlatformSend) {
  const opened: string[] = []
  const options = {
    ttlMs: 60_000,
    send: send ?? (async () => new Response('{}', { status: 500 })),
    openBrowser: (url: string) => { opened.push(url) },
    callbackPage: (outcome: 'succeeded' | 'cancelled' | 'failed') => `<p>${outcome}</p>`,
  }
  const controller = new PlatformBrowserSignIn(options)
  controllers.push(controller)
  return { controller, opened }
}

describe('Platform browser sign-in', () => {
  it('opens IAM authorize with PKCE and a loopback callback', async () => {
    const discovery = {
      issuer: 'http://localhost:9080/kaifang-meta/iam',
      authorization_endpoint: 'http://localhost:9080/kaifang-meta/iam/authorize',
      token_endpoint: 'http://localhost:9080/kaifang-meta/iam/token',
      userinfo_endpoint: 'http://localhost:9080/kaifang-meta/iam/userinfo',
    }
    const send: PlatformSend = async (input) => {
      if (String(input).includes('openid-configuration')) {
        return new Response(JSON.stringify(discovery), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 500 })
    }
    const { controller, opened } = setup(send)
    const pending = controller.start('http://127.0.0.1:3001')
    await vi.waitFor(() => { expect(opened.length).toBe(1) })
    const authorize = new URL(opened[0]!)
    expect(`${authorize.origin}${authorize.pathname}`).toBe(discovery.authorization_endpoint)
    expect(authorize.searchParams.get('client_id')).toBe(PLATFORM_CLIENT_ID)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('response_type')).toBe('code')
    const redirect = new URL(authorize.searchParams.get('redirect_uri')!)
    expect(redirect.hostname).toBe('127.0.0.1')
    expect(redirect.pathname).toBe(PLATFORM_CALLBACK_PATH)
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/u)
    controller.cancel()
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('reports unreachable when discovery fails', async () => {
    const { controller } = setup(async () => { throw new Error('offline') })
    await expect(controller.start('http://127.0.0.1:3001')).resolves.toEqual({ ok: false, reason: 'unreachable' })
  })

  it('requires a configured Platform origin', async () => {
    const { controller } = setup()
    await expect(controller.start('')).resolves.toEqual({ ok: false, reason: 'url-required' })
  })

  it('exchanges a loopback code for a Platform session', async () => {
    const discovery = {
      issuer: 'http://localhost:9080/kaifang-meta/iam',
      authorization_endpoint: 'http://localhost:9080/kaifang-meta/iam/authorize',
      token_endpoint: 'http://localhost:9080/kaifang-meta/iam/token',
      userinfo_endpoint: 'http://localhost:9080/kaifang-meta/iam/userinfo',
    }
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({
      iss: discovery.issuer, sub: 'user-1', tid: 't_system', azp: PLATFORM_CLIENT_ID,
      aud: 'kaifang-meta-platform', scope: 'model:invoke', exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url')
    const accessToken = `${header}.${payload}.sig`
    const send: PlatformSend = async (input, init) => {
      const url = String(input)
      if (url.includes('openid-configuration')) {
        return new Response(JSON.stringify(discovery), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/token')) {
        expect(init?.method).toBe('POST')
        return new Response(JSON.stringify({
          access_token: accessToken, refresh_token: 'refresh-1', expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/userinfo')) {
        return new Response(JSON.stringify({
          sub: 'user-1', preferred_username: 'admin', name: 'Admin', email: 'a@example.com',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 500 })
    }
    const { controller, opened } = setup(send)
    const pending = controller.start('http://127.0.0.1:3001')
    await vi.waitFor(() => { expect(opened.length).toBe(1) })
    const authorize = new URL(opened[0]!)
    const redirect = new URL(authorize.searchParams.get('redirect_uri')!)
    const state = authorize.searchParams.get('state')!
    const response = await fetch(`${redirect.origin}${redirect.pathname}?code=auth-code&state=${state}`)
    expect(await response.text()).toBe('<p>succeeded</p>')
    const result = await pending
    expect(result).toMatchObject({
      ok: true,
      session: {
        platformOrigin: 'http://127.0.0.1:3001',
        accessToken,
        refreshToken: 'refresh-1',
        user: { sub: 'user-1', tid: 't_system', username: 'admin', displayName: 'Admin', email: 'a@example.com' },
      },
    })
  })
})
