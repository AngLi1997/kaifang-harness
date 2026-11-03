/** Platform origin and the public Harness entry page. */

import { BrowserWindow, shell } from 'electron'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SharedHarnessUrlSaveResult } from './welcome-api.ts'

const HARNESS_ENTRY_PATH = '/harness'
export const SHARED_HARNESS_SESSION_PARTITION = 'persist:dsh-shared-harness'

/** Accept a Platform origin; the public Harness page loads the shared Host and starts IAM OAuth. */
export function validateSharedHarnessUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  let url: URL
  try { url = new URL(value.trim()) } catch (_invalidUrl) { return undefined }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username !== '' || url.password !== '' || url.pathname !== '/'
    || url.search !== '' || url.hash !== '') return undefined
  return url.origin
}

/** Resolve a Platform origin to its public Harness entry page.
 * @param value - validated Platform origin.
 * @returns the page loaded in the isolated desktop window.
 */
export function sharedHarnessEntryUrl(value: string): string {
  return new URL(HARNESS_ENTRY_PATH, value).href
}

function savedUrlPath(userData: string): string {
  return join(userData, 'desktop', 'shared-harness.json')
}

/** Read the Platform origin saved by the user. */
export async function readSharedHarnessUrl(userData: string): Promise<string> {
  try {
    const saved: unknown = JSON.parse(await readFile(savedUrlPath(userData), 'utf8'))
    if (typeof saved === 'object' && saved !== null && 'url' in saved) {
      const url = validateSharedHarnessUrl(saved.url)
      if (url !== undefined) return url
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('desktop shared Harness: could not read saved Host URL', error)
    }
  }
  return ''
}

/** Validate and atomically save a user-provided Host URL. */
export async function saveSharedHarnessUrl(userData: string, value: unknown): Promise<SharedHarnessUrlSaveResult> {
  const url = validateSharedHarnessUrl(value)
  if (url === undefined) return { ok: false, reason: 'invalid-url' }
  const target = savedUrlPath(userData)
  const temporary = `${target}.${String(process.pid)}.tmp`
  try {
    await mkdir(join(userData, 'desktop'), { recursive: true, mode: 0o700 })
    await writeFile(temporary, `${JSON.stringify({ url }, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, target)
    return { ok: true, url }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    console.warn('desktop shared Harness: could not save Host URL', error)
    return { ok: false, reason: 'write-failed' }
  }
}

/** Create a remote Platform entry window without the local app preload or Node access. */
export function createSharedHarnessWindow(url: string): BrowserWindow {
  const target = validateSharedHarnessUrl(url)
  if (target === undefined) throw new Error('desktop shared Harness: invalid URL')
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 520,
    minHeight: 600,
    show: false,
    webPreferences: {
      partition: SHARED_HARNESS_SESSION_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  })
  window.webContents.setWindowOpenHandler(({ url: opened }) => {
    try {
      const destination = new URL(opened)
      if (destination.protocol === 'https:' && destination.username === '' && destination.password === '') {
        void shell.openExternal(destination.href)
      }
    } catch (_invalidUrl) { return { action: 'deny' } }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, destination) => {
    let next: URL
    try { next = new URL(destination) } catch (_invalidUrl) { event.preventDefault(); return }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(next.hostname)
    if (next.username !== '' || next.password !== ''
      || (next.protocol !== 'https:' && !(next.protocol === 'http:' && loopback))) event.preventDefault()
  })
  const entry = sharedHarnessEntryUrl(target)
  void window.loadURL(entry).then(() => { if (!window.isDestroyed()) window.show() })
    .catch((error: unknown) => { console.error('desktop shared Harness: could not load Web Host', error) })
  return window
}
