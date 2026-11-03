/** Localized welcome copy and validated Platform sign-in operations. */

import { contextBridge, ipcRenderer } from 'electron'
import { resolveDesktopLocale } from './locale.ts'
import { WELCOME_IPC, type PlatformBrowserSignInResult, type PlatformPasswordSignInResult, type SharedHarnessUrlSaveResult, type WelcomeApi } from './welcome-api.ts'

const prefix = '--dsh-welcome-locale='
const locale = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
if (locale === undefined) throw new Error('desktop welcome: missing window locale')
const initialPage = process.argv.includes('--dsh-welcome-page=settings') ? 'settings' : 'entry'
const api: WelcomeApi = {
  ...resolveDesktopLocale(locale),
  initialPage,
  startBrowserSignIn: () => ipcRenderer.invoke(WELCOME_IPC.startBrowserSignIn) as Promise<PlatformBrowserSignInResult>,
  cancelBrowserSignIn: () => ipcRenderer.invoke(WELCOME_IPC.cancelBrowserSignIn) as Promise<void>,
  passwordSignIn: credentials => ipcRenderer.invoke(WELCOME_IPC.passwordSignIn, credentials) as Promise<PlatformPasswordSignInResult>,
  readSharedHarnessUrl: () => ipcRenderer.invoke(WELCOME_IPC.readSharedHarnessUrl) as Promise<string>,
  saveSharedHarnessUrl: value => ipcRenderer.invoke(WELCOME_IPC.saveSharedHarnessUrl, value) as Promise<SharedHarnessUrlSaveResult>,
  skip: () => ipcRenderer.invoke(WELCOME_IPC.skip) as Promise<void>,
}
contextBridge.exposeInMainWorld('dshWelcome', api)
