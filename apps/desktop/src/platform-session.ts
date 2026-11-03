/** Persisted Platform IAM session for Desktop native shell sign-in. */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Profile returned by IAM userinfo / token claims. */
export interface PlatformSessionUser {
  readonly sub: string
  readonly tid: string
  readonly username: string
  readonly displayName: string
  readonly email: string | null
}

/** Signed-in Platform account retained between Desktop launches. */
export interface PlatformSession {
  readonly platformOrigin: string
  readonly issuer: string
  readonly clientId: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly scopes: readonly string[]
  readonly user: PlatformSessionUser
}

function path(userData: string): string {
  return join(userData, 'desktop', 'platform-session.json')
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function parseSession(value: unknown): PlatformSession | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const input = value as Record<string, unknown>
  const user = typeof input.user === 'object' && input.user !== null ? input.user as Record<string, unknown> : undefined
  if (typeof input.platformOrigin !== 'string' || typeof input.issuer !== 'string' || typeof input.clientId !== 'string'
    || typeof input.accessToken !== 'string' || typeof input.refreshToken !== 'string'
    || typeof input.expiresAt !== 'number' || !Number.isFinite(input.expiresAt)
    || !Array.isArray(input.scopes) || !input.scopes.every(scope => typeof scope === 'string')
    || user === undefined || typeof user.sub !== 'string' || typeof user.tid !== 'string'
    || typeof user.username !== 'string' || typeof user.displayName !== 'string'
    || !nullableString(user.email)) return undefined
  return {
    platformOrigin: input.platformOrigin,
    issuer: input.issuer,
    clientId: input.clientId,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    scopes: input.scopes,
    user: {
      sub: user.sub,
      tid: user.tid,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
    },
  }
}

/**
 * Read a stored session that still matches the configured Platform origin.
 * @param userData - Electron userData directory.
 * @param platformOrigin - currently configured Platform origin; sessions for another origin do not count.
 * @param now - current epoch milliseconds.
 */
export async function readPlatformSession(
  userData: string, platformOrigin: string, now: number,
): Promise<PlatformSession | undefined> {
  let raw: string
  try { raw = await readFile(path(userData), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    return undefined
  }
  const session = parseSession(parsed)
  if (session === undefined || session.platformOrigin !== platformOrigin) return undefined
  // Allow a short skew so a refresh can run before the access token is treated as gone.
  if (session.expiresAt + 30_000 <= now && session.refreshToken === '') return undefined
  return session
}

/** @returns whether a usable Platform session is stored for the configured origin. */
export async function hasPlatformSession(userData: string, platformOrigin: string, now: number): Promise<boolean> {
  if (platformOrigin === '') return false
  const session = await readPlatformSession(userData, platformOrigin, now)
  if (session === undefined) return false
  return session.expiresAt > now || session.refreshToken !== ''
}

/** Atomically replace the stored Platform session. */
export async function writePlatformSession(userData: string, session: PlatformSession): Promise<void> {
  const target = path(userData)
  await mkdir(join(userData, 'desktop'), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${String(process.pid)}.tmp`
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

/** Remove the stored session; an absent file already counts as signed out. */
export async function clearPlatformSession(userData: string): Promise<void> {
  await rm(path(userData), { force: true })
}
