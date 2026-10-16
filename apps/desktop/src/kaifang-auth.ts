/**
 * KaifangLab sign-in against the system configured in the welcome settings.
 * Both the password form and the browser authorization page yield an access token; the account profile is read with it
 * and the result is stored as `desktop/kaifang-session.json` under Electron's userData directory with owner-only permissions.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PasswordCredentials, PasswordSignInResult, SystemConnection } from './welcome-api.ts'

/** KaifangLab token endpoint, relative to the configured system URL. */
export const KAIFANG_TOKEN_PATH = 'api/v1/base/access_token'
/** KaifangLab profile endpoint, relative to the configured system URL; authenticates with the `token` header. */
export const KAIFANG_USERINFO_PATH = 'api/v1/base/userinfo'

/** HTTP client; Electron's `net.fetch` in the app. */
export type KaifangSend = (input: string, init?: RequestInit) => Promise<Response>

/** Account identity shown in the workspace. */
export interface KaifangUser {
  readonly username: string
  /** The KaifangLab nickname when set, otherwise the username (account). */
  readonly displayName: string
  readonly email: string | null
  /** Absolute picture URL resolved against the KaifangLab Web URL, or null when the profile has none. */
  readonly avatarUrl: string | null
}

/** Signed-in KaifangLab account retained between launches. */
export interface KaifangSession {
  readonly systemUrl: string
  readonly accessToken: string
  /** Token expiry in epoch milliseconds, or null when the token carries no readable `exp` claim. */
  readonly expiresAt: number | null
  readonly user: KaifangUser
}

/** Sign-in failure without server diagnostics. */
export type KaifangFailure = Exclude<PasswordSignInResult, { ok: true }>

/**
 * Normalize renderer input into credentials.
 * @param value - untrusted renderer input.
 * @returns credentials with a trimmed username and the password unchanged, or the first missing field.
 */
export function validatePasswordCredentials(
  value: unknown,
): { ok: true; value: PasswordCredentials } | { ok: false; reason: 'username-required' | 'password-required' } {
  const input = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const username = typeof input.username === 'string' ? input.username.trim() : ''
  const password = typeof input.password === 'string' ? input.password : ''
  if (username === '') return { ok: false, reason: 'username-required' }
  if (password === '') return { ok: false, reason: 'password-required' }
  return { ok: true, value: { username, password } }
}

function endpoint(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).href
}

function jwtExpiry(token: string): number | null {
  const payload = token.split('.')[1]
  if (payload === undefined) return null
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof claims === 'object' && claims !== null && 'exp' in claims && typeof claims.exp === 'number') return claims.exp * 1000
  } catch (_opaqueToken) {
    // KaifangLab issues JWTs; an opaque token simply has no locally known expiry.
  }
  return null
}

/** Send one KaifangLab request and decode its `{ code, msg, data }` envelope. */
async function call(send: KaifangSend, url: string, init: RequestInit, timeoutMs: number)
  : Promise<{ ok: true; data: Record<string, unknown> } | KaifangFailure> {
  let response: Response
  try {
    response = await send(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  } catch (_transport) {
    // DNS, connection, TLS, and timeout failures all mean the configured system is unreachable.
    return { ok: false, reason: 'unreachable' }
  }
  let body: unknown
  try { body = await response.json() } catch (_notJson) {
    // A non-JSON reply means the URL does not point at a KaifangLab API.
    return { ok: false, reason: 'failed' }
  }
  // KaifangLab rejects unknown users, wrong passwords, disabled accounts, and invalid tokens with 400 or 401.
  if (response.status === 400 || response.status === 401 || response.status === 403) return { ok: false, reason: 'invalid-credentials' }
  const envelope = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  if (!response.ok || envelope.code !== 200 || typeof envelope.data !== 'object' || envelope.data === null) return { ok: false, reason: 'failed' }
  return { ok: true, data: envelope.data as Record<string, unknown> }
}

/**
 * Exchange credentials for a KaifangLab access token.
 * @param systemUrl - validated http(s) system URL from the welcome settings.
 * @param credentials - validated username and password.
 * @param send - HTTP client.
 * @param timeoutMs - request deadline.
 * @returns the token, or a failure reason without server diagnostics.
 */
export async function requestKaifangToken(
  systemUrl: string, credentials: PasswordCredentials, send: KaifangSend, timeoutMs: number,
): Promise<{ ok: true; token: string } | KaifangFailure> {
  const result = await call(send, endpoint(systemUrl, KAIFANG_TOKEN_PATH), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ username: credentials.username, password: credentials.password }),
  }, timeoutMs)
  if (!result.ok) return result
  const token = result.data.access_token
  return typeof token === 'string' && token !== '' ? { ok: true, token } : { ok: false, reason: 'failed' }
}

/**
 * Read the account profile for a token and build the session to store.
 * @param connection - saved system and Web URLs; the Web URL resolves relative pictures.
 * @param token - access token from the password form or the browser authorization page.
 * @param send - HTTP client.
 * @param timeoutMs - request deadline.
 * @returns the session, or `invalid-credentials` when KaifangLab rejects the token.
 */
export async function establishKaifangSession(
  connection: Pick<SystemConnection, 'systemUrl' | 'webUrl'>, token: string, send: KaifangSend, timeoutMs: number,
): Promise<{ ok: true; session: KaifangSession } | KaifangFailure> {
  const result = await call(send, endpoint(connection.systemUrl, KAIFANG_USERINFO_PATH),
    { method: 'GET', headers: { token, accept: 'application/json' } }, timeoutMs)
  if (!result.ok) return result
  const { username, nickname, email, avatar } = result.data
  if (typeof username !== 'string' || username === '') return { ok: false, reason: 'failed' }
  let avatarUrl: string | null = null
  if (typeof avatar === 'string' && avatar !== '') {
    const url = new URL(avatar, connection.webUrl)
    if (url.protocol === 'http:' || url.protocol === 'https:') avatarUrl = url.href
  }
  return {
    ok: true,
    session: {
      systemUrl: connection.systemUrl,
      accessToken: token,
      expiresAt: jwtExpiry(token),
      user: {
        username,
        displayName: typeof nickname === 'string' && nickname.trim() !== '' ? nickname.trim() : username,
        email: typeof email === 'string' && email !== '' ? email : null,
        avatarUrl,
      },
    },
  }
}

function path(userData: string): string {
  return join(userData, 'desktop', 'kaifang-session.json')
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function parseSession(value: unknown): KaifangSession | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const input = value as Record<string, unknown>
  const user = typeof input.user === 'object' && input.user !== null ? input.user as Record<string, unknown> : undefined
  if (typeof input.systemUrl !== 'string' || typeof input.accessToken !== 'string'
    || (input.expiresAt !== null && (typeof input.expiresAt !== 'number' || !Number.isFinite(input.expiresAt)))
    || user === undefined || typeof user.username !== 'string' || typeof user.displayName !== 'string'
    || !nullableString(user.email) || !nullableString(user.avatarUrl)) return undefined
  return {
    systemUrl: input.systemUrl, accessToken: input.accessToken, expiresAt: input.expiresAt,
    user: { username: user.username, displayName: user.displayName, email: user.email, avatarUrl: user.avatarUrl },
  }
}

/**
 * Read the stored session that is still usable for the configured system.
 * @param userData - Electron's userData directory.
 * @param systemUrl - currently configured system URL; a session for another system does not count.
 * @param now - current epoch milliseconds.
 * @returns the session, or undefined when absent, invalid, expired, or issued by another system.
 */
export async function readKaifangSession(userData: string, systemUrl: string, now: number): Promise<KaifangSession | undefined> {
  let raw: string
  try { raw = await readFile(path(userData), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (_corrupt) {
    // A corrupt session file is treated as signed out; the next sign-in replaces it.
    return undefined
  }
  const session = parseSession(parsed)
  if (session === undefined || session.systemUrl !== systemUrl) return undefined
  if (session.expiresAt !== null && session.expiresAt <= now) return undefined
  return session
}

/**
 * Atomically replace the stored session.
 * @param userData - Electron's userData directory.
 * @param session - session returned by {@link establishKaifangSession}.
 * @returns after the file is renamed into place.
 */
export async function writeKaifangSession(userData: string, session: KaifangSession): Promise<void> {
  const target = path(userData)
  await mkdir(join(userData, 'desktop'), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${String(process.pid)}.tmp`
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

/**
 * Remove the stored session; an absent file already counts as signed out.
 * @param userData - Electron's userData directory.
 * @returns after the file is gone.
 */
export async function clearKaifangSession(userData: string): Promise<void> {
  await rm(path(userData), { force: true })
}
