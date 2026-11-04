import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ClientSessions, type SessionBinding } from '../src/client/sessions/service.ts'

it('answers binding and scope from another catalog when this one has no generation', async () => {
  const ctx = new Context()
  const sessions = new ClientSessions(ctx, {} as never, { publish: false })
  const id = 'user-account-session-1' as SessionId
  const binding = { sessionId: id, ctx } as SessionBinding
  sessions.setExternalBindings(requested => requested === id ? binding : undefined)
  expect(sessions.binding(id)).toBe(binding)
  expect(sessions.scope(id)).toBe(ctx)
  expect(sessions.binding('missing' as SessionId)).toBeUndefined()
  sessions.setExternalBindings(undefined)
  expect(sessions.binding(id)).toBeUndefined()
  expect(sessions.scope(id)).toBeUndefined()
  await ctx.fiber.dispose()
})
