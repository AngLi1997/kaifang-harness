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

/** Accept a shared Web Host origin (RPC/WS authority), loopback HTTP or HTTPS. */
export function validateSharedHostUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  let url: URL
  try { url = new URL(value.trim()) } catch (_invalidUrl) { return undefined }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username !== '' || url.password !== ''
    || (url.pathname !== '/' && url.pathname !== '')
    || url.search !== '' || url.hash !== '') return undefined
  return url.origin
}

interface SharedHarnessSaved {
  readonly url?: string
  readonly hostUrl?: string
}

async function readSharedHarnessSaved(userData: string): Promise<SharedHarnessSaved> {
  try {
    const saved: unknown = JSON.parse(await readFile(savedUrlPath(userData), 'utf8'))
    if (typeof saved === 'object' && saved !== null) return saved as SharedHarnessSaved
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('desktop shared Harness: could not read saved settings', error)
    }
  }
  return {}
}

/** Read the Platform origin saved by the user. */
export async function readSharedHarnessUrl(userData: string): Promise<string> {
  const saved = await readSharedHarnessSaved(userData)
  return validateSharedHarnessUrl(saved.url) ?? ''
}

/** Read a previously discovered or saved shared Web Host origin. */
export async function readSharedHostUrl(userData: string): Promise<string> {
  const saved = await readSharedHarnessSaved(userData)
  return validateSharedHostUrl(saved.hostUrl) ?? ''
}

async function writeSharedHarnessSaved(userData: string, saved: SharedHarnessSaved): Promise<void> {
  const target = savedUrlPath(userData)
  const temporary = `${target}.${String(process.pid)}.tmp`
  await mkdir(join(userData, 'desktop'), { recursive: true, mode: 0o700 })
  await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

/** Validate and atomically save a user-provided Platform origin. */
export async function saveSharedHarnessUrl(userData: string, value: unknown): Promise<SharedHarnessUrlSaveResult> {
  const url = validateSharedHarnessUrl(value)
  if (url === undefined) return { ok: false, reason: 'invalid-url' }
  const temporary = `${savedUrlPath(userData)}.${String(process.pid)}.tmp`
  try {
    const previous = await readSharedHarnessSaved(userData)
    await writeSharedHarnessSaved(userData, { ...previous, url })
    return { ok: true, url }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    console.warn('desktop shared Harness: could not save Platform URL', error)
    return { ok: false, reason: 'write-failed' }
  }
}

/** Persist a discovered shared Web Host origin beside the Platform origin. */
export async function saveSharedHostUrl(userData: string, value: unknown): Promise<string | undefined> {
  const hostUrl = validateSharedHostUrl(value)
  if (hostUrl === undefined) return undefined
  try {
    const previous = await readSharedHarnessSaved(userData)
    await writeSharedHarnessSaved(userData, { ...previous, hostUrl })
    return hostUrl
  } catch (error) {
    console.warn('desktop shared Harness: could not save Host URL', error)
    return undefined
  }
}

async function probeSharedHost(
  origin: string,
  send: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<string | undefined> {
  const hostUrl = validateSharedHostUrl(origin)
  if (hostUrl === undefined) return undefined
  try {
    const response = await send(new URL('/kaifang/auth/status', `${hostUrl}/`).href, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(3_000),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null && 'configured' in body && body.configured === true) return hostUrl
  } catch (error) {
    console.warn('desktop shared Harness: Host probe failed', hostUrl, error)
  }
  return undefined
}

/**
 * Resolve the shared Web Host Desktop should use while online.
 * Prefer env, then saved hostUrl, then a loopback probe for local debug.
 */
export async function discoverSharedHostUrl(
  userData: string,
  platformOrigin: string,
  send: (input: string, init?: RequestInit) => Promise<Response> = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const fromEnv = validateSharedHostUrl(env.DSH_SHARED_HOST_URL)
  if (fromEnv !== undefined) {
    const live = await probeSharedHost(fromEnv, send)
    if (live !== undefined) {
      await saveSharedHostUrl(userData, live)
      return live
    }
  }
  const saved = await readSharedHostUrl(userData)
  if (saved !== '') {
    const live = await probeSharedHost(saved, send)
    if (live !== undefined) return live
  }
  const platform = validateSharedHarnessUrl(platformOrigin)
  if (platform === undefined) return undefined
  let platformHost: string
  try { platformHost = new URL(platform).hostname } catch { return undefined }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(platformHost)
  if (!loopback) return undefined
  const probed = await probeSharedHost('http://127.0.0.1:3080', send)
  if (probed !== undefined) {
    await saveSharedHostUrl(userData, probed)
    return probed
  }
  return undefined
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
