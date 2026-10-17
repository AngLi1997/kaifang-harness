/** The knowledge namespace and every browser contribution follow Client plugin disposal. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteError, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'
import { inject, mountKnowledge } from '../src/client/mount.ts'
import { apply as hostApply } from '../src/index.ts'
import { KnowledgePage, type KnowledgePageInjected } from '../src/client/KnowledgePage.tsx'
import { KnowledgeMention, type KnowledgeMentionInjected } from '../src/client/KnowledgeMention.tsx'

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-knowledge', descriptors: [] }

vi.mock('../src/client/catalog.ts', () => ({ observeCatalog: () => ({
  state: createSnapshotStore({ catalog: null, connected: true, error: null }), dispose: async () => {},
}) }))

async function fixture() {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      return unmount
    }
  }
  new Remote()
  const ok = <T>(value: T) => vi.fn(async () => ({ ok: true as const, value }))
  const knowledge = {
    create: ok({}), update: ok({}), delete: ok(undefined), reindex: ok(undefined), files: ok({ files: [], truncated: false }),
    upload: ok({}), deleteUpload: ok(undefined), candidates: ok([]),
  }
  ctx.provide('remote.knowledge', knowledge)
  const picker = {
    pick: vi.fn(async () => ({ ok: false as const, error: new RemoteError('directory-picker/unavailable', 'browse', { capability: 'browse' }) })),
    list: ok({ path: '/', home: '/', crumbs: [], entries: [], truncated: false }),
  }
  ctx.provide('remote.directoryPicker', picker)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const sources: unknown[] = []
  ctx.provide('inputTriggers', { registerSource: (source: unknown) => { sources.push(source); return () => { sources.splice(sources.indexOf(source), 1) } } })
  const startSession = vi.fn()
  ctx.provide('uiWorkspace', { startSession })
  const rules: unknown[] = []
  ctx.provide('uiConversation', { userText: { register: (rule: unknown) => { rules.push(rule); return () => { rules.splice(rules.indexOf(rule), 1) } } } })
  const selectPanel = vi.fn()
  ctx.provide('layout', { selectPanel })
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'main': { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
    'conversation.user.text.node': { kind: 'keyed', scope: 'session' },
  } } as never, () => null)
  return { ctx, unmount, knowledge, picker, sources, rules, startSession, selectPanel }
}

it('registers the page, sidebar entry, @ source, and mention chip, and withdraws them all', async () => {
  hostApply()
  const f = await fixture()
  const fiber = f.ctx.plugin({ inject: [...inject], apply: ctx => mountKnowledge(ctx, REMOTE) })
  await fiber
  const page = f.ctx.slots.entries('main').find(entry => entry.component === KnowledgePage)
  expect(page).toMatchObject({ locale: 'knowledge', options: { key: 'knowledge' } })
  const panel = f.ctx.slots.entries('sidebar.panellist').find(entry => entry.options.id === 'knowledge')
  expect(typeof panel?.options.label === 'function' ? panel.options.label() : undefined).toBe('Knowledge bases')
  expect(f.sources).toHaveLength(1)
  expect(f.rules).toHaveLength(1)

  const actions = page!.inject!() as Record<string, unknown> & KnowledgePageInjected
  await actions.create({ name: 'x', directories: [] })
  expect(f.knowledge.create).toHaveBeenCalledWith({ name: 'x', directories: [] })
  expect(await actions.pickDirectory()).toEqual({ kind: 'browse' })
  f.picker.pick.mockResolvedValueOnce({ ok: true, value: '/docs' } as never)
  expect(await actions.pickDirectory()).toEqual({ kind: 'picked', path: '/docs' })
  f.picker.pick.mockResolvedValueOnce({ ok: true, value: null } as never)
  expect(await actions.pickDirectory()).toEqual({ kind: 'cancelled' })
  const failure = new RemoteError('gateway/internal', 'boom', {})
  f.picker.pick.mockResolvedValueOnce({ ok: false, error: failure } as never)
  await expect(actions.pickDirectory()).rejects.toBe(failure)
  f.knowledge.reindex.mockResolvedValueOnce({ ok: false, error: failure } as never)
  await expect(actions.reindex('kb_1' as never)).rejects.toBe(failure)
  await actions.update({ id: 'kb_1' as never, name: 'y', directories: [] })
  await actions.remove('kb_1' as never)
  expect(await actions.listFiles('kb_1' as never)).toEqual({ files: [], truncated: false })
  await actions.uploadFile('kb_1' as never, 'a.md', 'YQ==')
  expect(f.knowledge.upload).toHaveBeenCalledWith({ id: 'kb_1', fileName: 'a.md', contentBase64: 'YQ==' })
  await actions.deleteUpload('kb_1' as never, '/u/a.md')
  expect(await actions.listDirectory(undefined)).toMatchObject({ path: '/' })
  const source = f.sources[0] as { candidates: (session: unknown, request: unknown) => Promise<unknown[]> }
  expect(await source.candidates({ sessionId: 's' }, { query: '', position: 'inline', drilled: false, signal: new AbortController().signal })).toEqual([])
  actions.ask('@[x](dsh-knowledge:kb_1)', 'x')
  expect(f.startSession).toHaveBeenCalledWith(undefined, expect.objectContaining({ clearPreviousDraft: true }))

  const chip = f.ctx.slots.entries('conversation.user.text.node').find(entry => entry.component === KnowledgeMention)
  ;(chip!.inject!('session' as never) as Record<string, unknown> & KnowledgeMentionInjected).openPage()
  expect(f.selectPanel).toHaveBeenCalledWith('knowledge')

  await fiber.dispose()
  expect(f.unmount).toHaveBeenCalledOnce()
  expect(f.sources).toHaveLength(0)
  expect(f.rules).toHaveLength(0)
  expect(f.ctx.slots.entries('main')).toHaveLength(0)
})

it('withdraws the Remote when the browser contributions fail to register', async () => {
  const f = await fixture()
  vi.spyOn(f.ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot failed') })
  const fiber = f.ctx.plugin({ inject: [...inject], apply: ctx => mountKnowledge(ctx, REMOTE) })
  await expect(fiber).rejects.toThrow('slot failed')
  expect(f.unmount).toHaveBeenCalledOnce()
})
