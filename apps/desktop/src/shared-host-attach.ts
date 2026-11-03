/** Shared-Host Remote Client attach: discover Host, device ticket, boot transport. */

import {
  discoverSharedHostUrl,
} from './shared-harness.ts'
import {
  exchangeSharedHostDeviceTicket,
  type SharedHostDeviceTicket,
  type SharedHostDeviceTokens,
} from './web-document.ts'

/** Why Desktop stayed on the owned local Host despite a Platform session. */
export type SharedHostAttachFailureReason =
  | 'no-platform'
  | 'no-session'
  | 'host-unreachable'
  | 'device-ticket-failed'

export type SharedHostAttachResult =
  | {
    readonly ok: true
    readonly hostUrl: string
    readonly cookie: string
    readonly tokens?: SharedHostDeviceTokens
  }
  | {
    readonly ok: false
    readonly reason: SharedHostAttachFailureReason
    /** Stable operator-facing English detail for logs; UI localizes by reason. */
    readonly detail: string
  }

export interface PlatformSessionTokens {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly scopes: readonly string[]
}

/**
 * Attempt device-ticket admission to the shared Web Host.
 * Callers apply success onto Desktop transport (`ownsHost=false`) or keep local.
 */
export async function attachSharedHostRemoteClient(options: {
  readonly userData: string
  readonly platformOrigin: string
  readonly session: PlatformSessionTokens | undefined
  readonly send?: (input: string, init?: RequestInit) => Promise<Response>
  readonly env?: NodeJS.ProcessEnv
  readonly exchange?: typeof exchangeSharedHostDeviceTicket
  readonly discover?: typeof discoverSharedHostUrl
}): Promise<SharedHostAttachResult> {
  const platformOrigin = options.platformOrigin.trim()
  if (platformOrigin === '') {
    return { ok: false, reason: 'no-platform', detail: 'Platform origin is not configured' }
  }
  if (options.session === undefined) {
    return { ok: false, reason: 'no-session', detail: 'no stored Platform session' }
  }
  const discover = options.discover ?? discoverSharedHostUrl
  const sharedOrigin = await discover(
    options.userData,
    platformOrigin,
    options.send ?? fetch,
    options.env ?? process.env,
  )
  if (sharedOrigin === undefined) {
    return {
      ok: false,
      reason: 'host-unreachable',
      detail: 'shared Host could not be discovered or /kaifang/auth/status is not configured',
    }
  }
  const exchange = options.exchange ?? exchangeSharedHostDeviceTicket
  try {
    const ticket: SharedHostDeviceTicket = await exchange(sharedOrigin, options.session)
    return {
      ok: true,
      hostUrl: `${sharedOrigin}/`,
      cookie: ticket.cookie,
      ...ticket.tokens === undefined ? {} : { tokens: ticket.tokens },
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'device-ticket-failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Boot IPC payload fields that must stay aligned with the active Host Peer world. */
export function desktopBootTransport(options: {
  readonly ownsHost: boolean
  readonly activeHostUrl: string
}): { readonly streamBaseUrl: string; readonly ownsHost: boolean } {
  return {
    streamBaseUrl: new URL(options.activeHostUrl).origin,
    ownsHost: options.ownsHost,
  }
}

/**
 * When the operator is Platform-signed-in but attach failed, Desktop must not
 * look "online" on a silent local Host — surface a dialog for these reasons.
 */
export function shouldNotifySharedHostAttachFailure(
  platformSignedIn: boolean,
  result: SharedHostAttachResult,
): boolean {
  if (!platformSignedIn || result.ok) return false
  return result.reason === 'host-unreachable' || result.reason === 'device-ticket-failed'
}
