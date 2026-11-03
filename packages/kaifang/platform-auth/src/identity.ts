/** Identity vocabulary shared by the Host admission and per-user data partitions. */

import { createHash } from 'node:crypto'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'
import { KAIFANG_MODEL_PROVIDER_PREFIX } from './provider-id.ts'

/** How a shared-Host session was admitted for this Peer. */
export type KaifangAdmissionChannel = 'browser' | 'device'

/** Authenticated Meta identity attached to a shared Host Peer. */
export interface KaifangUserPrincipal {
  readonly kind: 'kaifang-user'
  readonly sub: string
  readonly tid: string
  readonly clientId: string
  /**
   * Admission channel that created the Host session.
   * `device` is Desktop (or other non-browser) ticket exchange; `browser` is
   * the Web OAuth cookie. Absent on legacy persisted sessions (treat as browser).
   */
  readonly admission?: KaifangAdmissionChannel
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'kaifang-user': KaifangUserPrincipal
  }
}

/** 为租户内的 Meta 身份生成稳定的不透明分区标识。 */
export function platformUserKey(identity: Pick<KaifangUserPrincipal, 'sub' | 'tid'>): string {
  return createHash('sha256').update(`${identity.tid}\0${identity.sub}`).digest('hex').slice(0, 24)
}

/** 为单个 Meta 身份生成稳定模型路由；provider id 不包含用户和租户标识。 */
export function platformModelProviderId(identity: Pick<KaifangUserPrincipal, 'sub' | 'tid'>): string {
  return `${KAIFANG_MODEL_PROVIDER_PREFIX}${platformUserKey(identity)}`
}

/** Narrow a Remote invocation principal to the platform-user identity. */
export function isKaifangUserPrincipal(principal: Principal | undefined): principal is KaifangUserPrincipal {
  return principal?.kind === 'kaifang-user'
    && typeof principal.sub === 'string' && principal.sub.length > 0
    && typeof principal.tid === 'string' && principal.tid.length > 0
}

/**
 * Desktop device-ticket Peers may adopt Host-local absolute directories outside
 * the Web partition root; browser OAuth Peers stay sandboxed.
 */
export function isDeviceAdmittedKaifangUser(principal: Principal | undefined): boolean {
  return isKaifangUserPrincipal(principal) && principal.admission === 'device'
}
