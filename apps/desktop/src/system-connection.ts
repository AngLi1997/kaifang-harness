/**
 * Kaifang system connection settings edited from the welcome window.
 * Stored as `desktop/system-connection.json` under Electron's userData directory with owner-only permissions.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SystemConnection, SystemConnectionInvalid } from './welcome-api.ts'

/** Value shown before the user saves a connection; the authorization code has no default. */
export const DEFAULT_SYSTEM_CONNECTION: SystemConnection = { systemUrl: 'http://127.0.0.1:9999', webUrl: 'http://localhost:5173', authCode: '' }

function httpUrl(value: string): boolean {
  let url: URL
  try { url = new URL(value) } catch (_invalidUrl) {
    // An unparsable URL is a form error, not an operation failure.
    return false
  }
  return url.protocol === 'http:' || url.protocol === 'https:'
}

/**
 * Normalize user input into a saveable connection.
 * A document saved before the Web URL existed omits it and receives the default.
 * @param value - untrusted renderer input or saved document.
 * @returns the trimmed connection, or the first failed field rule.
 */
export function validateSystemConnection(
  value: unknown,
): { ok: true; value: SystemConnection } | { ok: false; reason: SystemConnectionInvalid } {
  const input = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const systemUrl = typeof input.systemUrl === 'string' ? input.systemUrl.trim() : ''
  const webUrl = input.webUrl === undefined ? DEFAULT_SYSTEM_CONNECTION.webUrl
    : typeof input.webUrl === 'string' ? input.webUrl.trim() : ''
  const authCode = typeof input.authCode === 'string' ? input.authCode.trim() : ''
  if (systemUrl === '') return { ok: false, reason: 'url-required' }
  if (!httpUrl(systemUrl)) return { ok: false, reason: 'url-invalid' }
  if (webUrl === '') return { ok: false, reason: 'web-url-required' }
  if (!httpUrl(webUrl)) return { ok: false, reason: 'web-url-invalid' }
  if (authCode === '') return { ok: false, reason: 'auth-code-required' }
  return { ok: true, value: { systemUrl, webUrl, authCode } }
}

function path(userData: string): string {
  return join(userData, 'desktop', 'system-connection.json')
}

/**
 * Read the saved connection.
 * @param userData - Electron's userData directory.
 * @returns the saved connection, or the defaults when none is saved or the file is invalid.
 */
export async function readSystemConnection(userData: string): Promise<SystemConnection> {
  let raw: string
  try { raw = await readFile(path(userData), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_SYSTEM_CONNECTION
    throw error
  }
  const parsed = validateSystemConnection(JSON.parse(raw))
  return parsed.ok ? parsed.value : DEFAULT_SYSTEM_CONNECTION
}

/**
 * Atomically replace the saved connection.
 * @param userData - Electron's userData directory.
 * @param connection - validated connection.
 * @returns after the file is renamed into place.
 */
export async function writeSystemConnection(userData: string, connection: SystemConnection): Promise<void> {
  const target = path(userData)
  await mkdir(join(userData, 'desktop'), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${String(process.pid)}.tmp`
  await writeFile(temporary, `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}
