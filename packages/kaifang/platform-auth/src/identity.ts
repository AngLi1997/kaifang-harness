/** Identity vocabulary shared by the Host admission and per-user data partitions. */

import { createHash } from 'node:crypto'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'

/** Authenticated Meta identity attached to a shared Host Peer. */
export interface KaifangUserPrincipal {
  readonly kind: 'kaifang-user'
  readonly sub: string
  readonly tid: string
  readonly clientId: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    kaifangUser: KaifangUserPrincipal
  }
}

/** Stable opaque namespace for one Meta identity within a tenant. */
export function platformUserKey(identity: Pick<KaifangUserPrincipal, 'sub' | 'tid'>): string {
  return createHash('sha256').update(`${identity.tid}\0${identity.sub}`).digest('hex').slice(0, 24)
}

/** Narrow a Remote invocation principal to the platform-user identity. */
export function isKaifangUserPrincipal(principal: Principal | undefined): principal is KaifangUserPrincipal {
  return principal?.kind === 'kaifang-user'
    && typeof principal.sub === 'string' && principal.sub.length > 0
    && typeof principal.tid === 'string' && principal.tid.length > 0
}
