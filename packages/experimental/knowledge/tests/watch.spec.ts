/** Directory watching ignores hidden entries, debounces changes, and degrades when a watcher fails. */
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, expect, it, vi } from 'vitest'

interface FakeWatcher extends EventEmitter {
  readonly root: string
  readonly listener: (event: string, file: string | null) => void
  close: () => void
}
const watchers: FakeWatcher[] = []
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return {
    ...actual,
    watch: (root: string, _options: unknown, listener: FakeWatcher['listener']) => {
      if (root.endsWith('unwatchable')) throw new Error('unsupported')
      const watcher = Object.assign(new EventEmitter(), { root, listener, close: vi.fn() })
      watchers.push(watcher)
      return watcher
    },
  }
})

const { default: KnowledgeRuntime } = await import('../src/index.ts')

const roots: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  watchers.length = 0
})

it('schedules one index pass after visible changes and stops reporting watching after errors', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-knowledge-watch-'))
  const docs = await mkdtemp(join(tmpdir(), 'dsh-knowledge-watch-docs-'))
  dirs.push(dataRoot, docs)
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(KnowledgeRuntime, KnowledgeRuntime.Config({ dataRoot, watch: true, watchDebounceMs: 1 }))
  const base = await ctx.knowledge.create({ name: 'a', directories: [docs] })
  await expect.poll(() => ctx.knowledge.list()[0]?.status.phase).toBe('ready')
  expect(watchers.map(watcher => watcher.root)).toEqual([docs, base.uploadDirectory])
  const indexedAt = ctx.knowledge.list()[0]?.status.indexedAt
  watchers[0]?.listener('rename', '.git/index')
  watchers[0]?.listener('change', 'a.md')
  watchers[0]?.listener('change', null)
  await expect.poll(() => ctx.knowledge.list()[0]?.status.indexedAt).not.toBe(indexedAt)
  watchers[0]?.emit('error', new Error('gone'))
  watchers[1]?.emit('error', new Error('gone'))
  expect(ctx.knowledge.list()[0]?.status.watching).toBe(false)
  expect(watchers[0]?.close).toHaveBeenCalled()
})

it('indexes a folder that cannot be watched', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-knowledge-watch-'))
  const parent = await mkdtemp(join(tmpdir(), 'dsh-knowledge-watch-docs-'))
  dirs.push(dataRoot, parent)
  const docs = join(parent, 'unwatchable')
  await import('node:fs/promises').then(fs => fs.mkdir(docs))
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(KnowledgeRuntime, KnowledgeRuntime.Config({ dataRoot, watch: true }))
  await ctx.knowledge.create({ name: 'a', directories: [docs] })
  await expect.poll(() => ctx.knowledge.list()[0]?.status.phase).toBe('ready')
  expect(watchers.map(watcher => watcher.root)).toHaveLength(1)
})
