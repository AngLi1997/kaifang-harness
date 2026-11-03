/**
 * Contract for shared-Host kaifang-user Peer allowlists used by Desktop Remote Client and Web.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import type { RemoteAccessRole } from '@deepseek-ai/dsh-api-remote-access'
import type { KaifangUserPrincipal } from '../src/identity.ts'
import '../src/identity.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  PLATFORM_USER_GLOBAL_ACTIONS,
  PLATFORM_USER_SESSION_ACTIONS,
} from '../src/peer-roles.ts'

const USER: KaifangUserPrincipal = {
  kind: 'kaifang-user',
  sub: 'user-1',
  tid: 'tenant-1',
  clientId: 'client-1',
}

const GLOBAL_ROLE = {
  name: 'platform-user-global',
  resource: 'global',
  actions: [...PLATFORM_USER_GLOBAL_ACTIONS],
} satisfies RemoteAccessRole<'global'>

const SESSION_ROLE = {
  name: 'platform-user-session',
  resource: 'session',
  actions: [...PLATFORM_USER_SESSION_ACTIONS],
} satisfies RemoteAccessRole<'session'>

describe('kaifang-user Peer allowlist', () => {
  it('keeps Desktop 权限 and both-ends Agent 预设 on the shared Host Peer', () => {
    expect(PLATFORM_USER_GLOBAL_ACTIONS).toContain('permissionPresets/catalog')
    expect(PLATFORM_USER_GLOBAL_ACTIONS).toContain('agentPresets/list')
    expect(PLATFORM_USER_GLOBAL_ACTIONS).toContain('agentPresets/read')
    expect(PLATFORM_USER_SESSION_ACTIONS).toContain('agentPresets/select')
    expect(PLATFORM_USER_SESSION_ACTIONS).toContain('workspace/deleteSession')
    expect(PLATFORM_USER_GLOBAL_ACTIONS).toContain('workspace/listSnapshot')
    expect(PLATFORM_USER_SESSION_ACTIONS).toContain('workspace/listSnapshot')
    // DeepSeek account stream must stay off kaifang-user Peers.
    expect(PLATFORM_USER_GLOBAL_ACTIONS).not.toContain('account/watch')
  })

  it('allows catalog and agentPresets list through remoteAccess decide()', async () => {
    const ctx = new Context()
    await ctx.plugin(RemoteAccessService)
    const access = ctx.remoteAccess
    access.registerPolicy('kaifang-user', {
      bindings: () => [
        { role: GLOBAL_ROLE, resource: { kind: 'global' } },
        { role: SESSION_ROLE, resource: { kind: 'session', id: SessionId('user-tenant-1-session-1') } },
      ],
    })

    expect(access.decide({
      principal: USER,
      action: 'permissionPresets/catalog',
      resources: [{ kind: 'global' }],
    })).toEqual({ kind: 'allow' })

    expect(access.decide({
      principal: USER,
      action: 'agentPresets/list',
      resources: [{ kind: 'global' }],
    })).toEqual({ kind: 'allow' })

    expect(access.decide({
      principal: USER,
      action: 'agentPresets/read',
      resources: [{ kind: 'global' }],
    })).toEqual({ kind: 'allow' })

    expect(access.decide({
      principal: USER,
      action: 'agentPresets/select',
      resources: [{ kind: 'session', id: SessionId('user-tenant-1-session-1') }],
    })).toEqual({ kind: 'allow' })

    expect(access.decide({
      principal: USER,
      action: 'account/watch',
      resources: [{ kind: 'global' }],
    })).toMatchObject({ kind: 'deny', reason: 'no-allow' })
  })
})
