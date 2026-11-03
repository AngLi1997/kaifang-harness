/** Native welcome window and its presentation-only renderer. */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent } from 'electron'
import type { DesktopLocale } from './locale.ts'
import { WELCOME_IPC, type WelcomeOperations } from './welcome-api.ts'

/** Resolve the fixed-size welcome window's native material and controls. */
export function welcomeWindowOptions(platform: NodeJS.Platform, locale: DesktopLocale,
  initialPage: 'entry' | 'settings' = 'entry'): BrowserWindowConstructorOptions {
  return {
    width: 600,
    height: 700,
    useContentSize: true,
    center: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: locale.messages.welcomeTitle,
    backgroundColor: platform === 'darwin' || platform === 'win32' ? '#00000000' : '#FFFFFF',
    ...(platform === 'darwin' ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 21, y: 21 },
      vibrancy: 'menu',
      visualEffectState: 'active',
    } as const : {}),
    ...(platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#0F1115', height: 42 },
      backgroundMaterial: 'acrylic',
    } as const : {}),
    webPreferences: {
      preload: fileURLToPath(new URL('./preload-welcome.cjs', import.meta.url)),
      additionalArguments: [`--dsh-welcome-locale=${locale.id}`, `--dsh-welcome-page=${initialPage}`],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  }
}

let disposeActiveHandlers: (() => void) | undefined

/** Open the process's sole welcome window with desktop-owned operations. */
export async function openWelcomeWindow(locale: DesktopLocale, operations: WelcomeOperations,
  initialPage: 'entry' | 'settings' = 'entry'): Promise<BrowserWindow> {
  const window = new BrowserWindow(welcomeWindowOptions(process.platform, locale, initialPage))
  disposeActiveHandlers?.()
  let active = true
  const disposeHandlers = (): void => {
    if (!active) return
    active = false
    for (const channel of [WELCOME_IPC.skip, WELCOME_IPC.openSharedHarness, WELCOME_IPC.passwordSignIn, WELCOME_IPC.readSharedHarnessUrl,
      WELCOME_IPC.saveSharedHarnessUrl]) ipcMain.removeHandler(channel)
    disposeActiveHandlers = undefined
  }
  disposeActiveHandlers = disposeHandlers
  const assertSender = (event: IpcMainInvokeEvent): void => {
    if (!active || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('desktop welcome: rejected action from an unowned frame')
    }
  }
  ipcMain.handle(WELCOME_IPC.readSharedHarnessUrl, async (event) => {
    assertSender(event)
    return operations.readSharedHarnessUrl()
  })
  ipcMain.handle(WELCOME_IPC.saveSharedHarnessUrl, async (event, value: unknown) => {
    assertSender(event)
    return operations.saveSharedHarnessUrl(typeof value === 'string' ? value : '')
  })
  ipcMain.handle(WELCOME_IPC.openSharedHarness, async (event) => {
    assertSender(event)
    return operations.openSharedHarness()
  })
  ipcMain.handle(WELCOME_IPC.passwordSignIn, async (event, value: unknown) => {
    assertSender(event)
    const credentials = typeof value === 'object' && value !== null
      ? value as Partial<{ username: unknown; password: unknown }> : {}
    return operations.passwordSignIn({
      username: typeof credentials.username === 'string' ? credentials.username : '',
      password: typeof credentials.password === 'string' ? credentials.password : '',
    })
  })
  ipcMain.handle(WELCOME_IPC.skip, async (event) => {
    assertSender(event)
    await operations.skip()
  })
  window.once('closed', disposeHandlers)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => { event.preventDefault() })
  try {
    await window.loadFile(join(app.getAppPath(), 'renderer', 'welcome.html'))
  } catch (error) {
    disposeHandlers()
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Another window can replace ownership during loadFile.
  if (active && !window.isDestroyed()) window.show()
  return window
}
