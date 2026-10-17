/** The browser half registers its contributions and removes them on disposal. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import { REFERENCE_SOURCE } from '../src/client/reference-source.ts'

const Empty = () => null

it('registers the @ source, the catalog page, and its sidebar entry, and removes them on disposal', async () => {
  expect(applyNode).not.toThrow()
  const ctx = new Context()
  try {
    await ctx.plugin(SlotRegistry).await()
    const unregister = vi.fn()
    const registerSource = vi.fn(() => unregister)
    ctx.provide('inputTriggers', { registerSource } as never)
    ctx.provide('sessions', {} as never)
    ctx.provide('conversation', {} as never)
    ctx.provide('layout', {} as never)
    ctx.provide('uiWorkspace', {} as never)
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.slots.register({ name: 'root', children: {
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    } } as never, Empty)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(registerSource).toHaveBeenCalledTimes(1)
    expect(registerSource.mock.calls[0]).toMatchObject([{ trigger: '@', name: REFERENCE_SOURCE }])
    expect(ctx.slots.entries('main').map(entry => entry.options.key)).toEqual(['kaifang-archive-tools'])
    const [row] = ctx.slots.entries('sidebar.panellist')
    expect(row?.options).toMatchObject({ id: 'kaifang-archive-tools', order: 1 })
    expect(resolveSlotLabel(row!.options.label)).toBe('Archive tools')
    await fiber.dispose()
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(ctx.slots.entries('main')).toHaveLength(0)
    expect(ctx.slots.entries('sidebar.panellist')).toHaveLength(0)
  } finally {
    await ctx.fiber.dispose()
  }
})
