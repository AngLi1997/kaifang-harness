// Real-composition acceptance for KaifangLab sign-in from a plain browser. The scaffold boots
// the shipped Web Loader tree with the Web bundle's sign-in page enabled; a real Chromium enters
// the system settings, signs in with a password and then with the one-click authorization tab,
// against a loopback KaifangLab double whose authorize page approves at once.
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./fixtures/kaifang-sign-in/cordis.patch.yml', import.meta.url))
const MODE = webSnapshotMode()
const TOKEN = 'kaifang-web-token'

/** Loopback KaifangLab double: CORS-enabled token and profile API plus an authorize page that approves at once. */
async function mockKaifangLab() {
  const authorizations: URL[] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, token, accept', 'access-control-allow-methods': 'GET, POST' }
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body))
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return }
    if (url.pathname === '/authorize') {
      authorizations.push(url)
      const callback = new URL(url.searchParams.get('redirect_uri') ?? '/')
      callback.searchParams.set('token', TOKEN)
      callback.searchParams.set('state', url.searchParams.get('state') ?? '')
      res.writeHead(302, { location: callback.href }).end()
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/base/access_token') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        const credentials = JSON.parse(body) as { username?: unknown; password?: unknown }
        if (credentials.username === 'admin' && credentials.password === '123456') reply(200, { code: 200, data: { access_token: TOKEN, username: 'admin', nickname: '超级管理员' } })
        else reply(400, { code: 400, msg: '密码错误!' })
      })
      return
    }
    if (url.pathname === '/api/v1/base/userinfo') {
      if (req.headers.token !== TOKEN) { reply(401, { code: 401, msg: 'unauthorized' }); return }
      reply(200, { code: 200, data: { id: 1, username: 'admin', nickname: '超级管理员', email: 'admin@admin.com', avatar: null } })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('kaifang sign-in: missing mock listener')
  const origin = `http://127.0.0.1:${String(address.port)}`
  return {
    origin, authorizations,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}

describe.skipIf(MODE === 'record')('web e2e: KaifangLab sign-in in a plain browser', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let lab: Awaited<ReturnType<typeof mockKaifangLab>>

  beforeAll(async () => {
    lab = await mockKaifangLab()
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await lab?.close()
  })

  it('covers the workspace until a password or one-click sign-in, then shows the nickname', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    onTestFinished(() => context.close())
    const page = await context.newPage()
    onTestFailed(() => saveFailureShot(page, 'web-e2e-kaifang-sign-in'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const title = page.getByRole('heading', { name: 'Sign in to Kaifang Harness', exact: true })
    await title.waitFor()

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('textbox', { name: 'System URL' }).fill(lab.origin)
    await page.getByRole('textbox', { name: 'Sign-in page URL' }).fill(lab.origin)
    await page.getByRole('textbox', { name: 'Authorization code' }).fill('code')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await title.waitFor()

    await page.getByRole('button', { name: 'Sign in with password', exact: true }).click()
    await page.getByRole('textbox', { name: 'Account' }).fill('admin')
    await page.locator('#kaifang-password').fill('wrong')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Incorrect account or password, or the account is disabled.' }).waitFor()
    await page.locator('#kaifang-password').fill('123456')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    const menu = page.getByRole('button', { name: 'Account menu', exact: true })
    await expect.poll(() => menu.textContent(), { timeout: 30_000 }).toBe('超级管理员')
    expect(await title.count()).toBe(0)

    await menu.click()
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
    await title.waitFor()
    const tab = context.waitForEvent('page')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    const authorization = await tab
    await expect.poll(() => menu.textContent(), { timeout: 30_000 }).toBe('超级管理员')
    expect(await title.count()).toBe(0)
    expect(lab.authorizations).toHaveLength(1)
    const redirect = new URL(lab.authorizations[0]!.searchParams.get('redirect_uri')!)
    expect(redirect.origin).toBe(new URL(scaffold.authenticatedUrl).origin)
    expect(redirect.pathname).toBe('/kaifang/callback.html')
    await expect.poll(() => authorization.isClosed()).toBe(true)
  }, 120_000)
})
