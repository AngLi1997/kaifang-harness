import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import { needsWelcome, WELCOME_IPC } from '../src/welcome-api.ts'

const electron = vi.hoisted(() => ({
  create: vi.fn<(options: unknown) => ReturnType<typeof createWindow>>(),
  root: '/desktop-app',
  handlers: new Map<string, (event: unknown, value?: unknown) => Promise<unknown>>(),
}))
vi.mock('electron', () => ({
  app: { getAppPath: () => electron.root },
  BrowserWindow: vi.fn(function (options: unknown) { return electron.create(options) }),
  ipcMain: {
    handle: (name: string, handler: (event: unknown, value?: unknown) => Promise<unknown>) => {
      if (electron.handlers.has(name)) throw new Error(`duplicate IPC handler: ${name}`)
      electron.handlers.set(name, handler)
    },
    removeHandler: (name: string) => electron.handlers.delete(name),
  },
  shell: { openExternal: vi.fn(async () => {}) },
}))

const { openWelcomeWindow, welcomeWindowOptions } = await import('../src/welcome-window.ts')

function createWindow() {
  return {
    webContents: {
      mainFrame: {},
      setWindowOpenHandler: vi.fn<(handler: () => { action: string }) => void>(),
      on: vi.fn<(name: string, handler: (event: { preventDefault(): void }) => void) => void>(),
    },
    loadFile: vi.fn<(path: string) => Promise<undefined>>().mockResolvedValue(undefined),
    isDestroyed: vi.fn().mockReturnValue(false),
    destroy: vi.fn(),
    show: vi.fn(),
    once: vi.fn<(name: string, callback: () => void) => void>(),
  }
}

const operations = {
  readSharedHarnessUrl: vi.fn(async () => ''),
  saveSharedHarnessUrl: vi.fn(async (value: string) => ({ ok: true as const, url: value })),
  startBrowserSignIn: vi.fn(async () => ({ ok: true as const })),
  cancelBrowserSignIn: vi.fn(async () => {}),
  passwordSignIn: vi.fn(async () => ({ ok: true as const })),
  skip: vi.fn(async () => {}),
}

beforeEach(() => { electron.create.mockReset(); electron.handlers.clear(); vi.clearAllMocks() })

describe('desktop welcome window', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('keeps the %s preview fixed-size and sandboxed', (platform) => {
    const options = welcomeWindowOptions(platform, resolveDesktopLocale('zh-CN'))
    expect(options).toMatchObject({
      width: 600, height: 700, useContentSize: true, center: true, show: false,
      resizable: false, maximizable: false, fullscreenable: false,
      webPreferences: {
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        additionalArguments: ['--dsh-welcome-locale=zh-CN', '--dsh-welcome-page=entry'],
      },
    })
    expect(options.webPreferences?.preload).toMatch(/preload-welcome\.cjs$/u)
    expect(welcomeWindowOptions(platform, resolveDesktopLocale('zh-CN'), 'settings').webPreferences?.additionalArguments)
      .toContain('--dsh-welcome-page=settings')
  })

  it('waits for its local document and blocks renderer navigation', async () => {
    const window = createWindow()
    const loaded = Promise.withResolvers<undefined>()
    window.loadFile.mockReturnValue(loaded.promise)
    electron.create.mockReturnValue(window)
    const opening = openWelcomeWindow(resolveDesktopLocale('en'), operations)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.loadFile).toHaveBeenCalledWith(join(electron.root, 'renderer', 'welcome.html'))
    expect(window.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' })
    const event = { preventDefault: vi.fn() }
    window.webContents.on.mock.calls[0]![1](event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    loaded.resolve(undefined)
    expect(await opening).toBe(window)
    expect(window.show).toHaveBeenCalledOnce()
  })

  it('destroys a window whose document fails to load', async () => {
    const window = createWindow()
    window.loadFile.mockRejectedValue(new Error('missing welcome document'))
    electron.create.mockReturnValue(window)
    await expect(openWelcomeWindow(resolveDesktopLocale('en'), operations)).rejects.toThrow('missing welcome document')
    expect(window.destroy).toHaveBeenCalledOnce()
    expect(electron.handlers.size).toBe(0)
  })

  it('reads deployment configuration only from the owned welcome window and removes handlers on close', async () => {
    const window = createWindow()
    electron.create.mockReturnValue(window)
    await openWelcomeWindow(resolveDesktopLocale('en'), operations)
    const own = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const read = electron.handlers.get(WELCOME_IPC.readSharedHarnessUrl)!
    await expect(read({ ...own, senderFrame: {} })).rejects.toThrow('unowned frame')
    expect(await read(own)).toBe('')
    expect(operations.readSharedHarnessUrl).toHaveBeenCalledOnce()
    const save = electron.handlers.get(WELCOME_IPC.saveSharedHarnessUrl)!
    await expect(save({ ...own, senderFrame: {} }, 'https://harness.example')).rejects.toThrow('unowned frame')
    expect(await save(own, 'https://harness.example')).toEqual({ ok: true, url: 'https://harness.example' })
    expect(await electron.handlers.get(WELCOME_IPC.startBrowserSignIn)!(own)).toEqual({ ok: true })
    expect(await electron.handlers.get(WELCOME_IPC.passwordSignIn)!(own, { username: 'admin', password: 'secret' })).toEqual({ ok: true })
    await electron.handlers.get(WELCOME_IPC.cancelBrowserSignIn)!(own)
    await electron.handlers.get(WELCOME_IPC.skip)!(own)
    expect(operations.startBrowserSignIn).toHaveBeenCalledOnce()
    expect(operations.cancelBrowserSignIn).toHaveBeenCalledOnce()
    expect(operations.passwordSignIn).toHaveBeenCalledExactlyOnceWith({ username: 'admin', password: 'secret' })
    expect(operations.skip).toHaveBeenCalledOnce()
    window.once.mock.calls[0]![1]()
    expect(electron.handlers.size).toBe(0)
  })

  it('shows the local welcome only when no local account, API key, or Platform session is configured', () => {
    expect(needsWelcome({ loggedIn: true, hasApiKey: false, platformSignedIn: false })).toBe(false)
    expect(needsWelcome({ loggedIn: false, hasApiKey: false, platformSignedIn: false })).toBe(true)
    expect(needsWelcome({ loggedIn: false, hasApiKey: true, platformSignedIn: false })).toBe(false)
    expect(needsWelcome({ loggedIn: false, hasApiKey: false, platformSignedIn: true })).toBe(false)
  })
})
