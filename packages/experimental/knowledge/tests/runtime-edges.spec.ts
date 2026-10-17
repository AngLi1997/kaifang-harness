/** Runtime failure, cancellation, queueing, and on-demand vector behavior. */
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, expect, it } from 'vitest'
import KnowledgeRuntime from '../src/index.ts'
import type { Config } from '../src/config.ts'
import type { KnowledgeBaseId } from '../src/types.ts'

const roots: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-knowledge-runtime-'))
  dirs.push(dir)
  return dir
}
async function start(dataRoot: string, config: Partial<Config> = {}): Promise<{ ctx: Context; runtime: KnowledgeRuntime }> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(KnowledgeRuntime, KnowledgeRuntime.Config({ dataRoot, watch: false, ...config }))
  return { ctx, runtime: ctx.knowledge }
}
function phase(runtime: KnowledgeRuntime, id: KnowledgeBaseId) {
  return runtime.list().find(base => base.id === id)?.status.phase
}
const signal = (): AbortSignal => new AbortController().signal

it('rolls definition changes back when the definition file cannot be written', async () => {
  const dataRoot = await tempDir()
  const { runtime } = await start(dataRoot)
  const base = await runtime.create({ name: 'a', directories: [] })
  await expect.poll(() => phase(runtime, base.id)).toBe('ready')
  await rm(join(dataRoot, 'bases.json'))
  await mkdir(join(dataRoot, 'bases.json', 'blocker'), { recursive: true })
  await expect(runtime.create({ name: 'b', directories: [] })).rejects.toThrow()
  await expect(runtime.update({ id: base.id, name: 'renamed', directories: [] })).rejects.toThrow()
  await expect(runtime.remove(base.id)).rejects.toThrow()
  expect(runtime.list().map(item => item.name)).toEqual(['a'])
})

it('reports index failures, failed files, unchanged files, missing folders, and truncated hits', async () => {
  const dataRoot = await tempDir()
  const docs = await tempDir()
  await writeFile(join(docs, 'broken.docx'), 'not a zip')
  await writeFile(join(docs, 'long.md'), `封条 ${'x'.repeat(300)}`)
  const extra = join(docs, 'extra')
  await mkdir(extra)
  const { runtime } = await start(dataRoot, { maxHitChars: 100, indexYieldMs: 1 })
  const base = await runtime.create({ name: 'a', directories: [docs, extra] })
  await expect.poll(() => phase(runtime, base.id)).toBe('ready')
  const files = await runtime.files(base.id)
  const broken = files.files.find(file => file.path.endsWith('broken.docx'))
  expect(broken?.state).toBe('failed')
  expect(broken?.error).toBeTypeOf('string')
  const hit = (await runtime.search({ query: '封条', knowledgeBaseIds: [base.id], limit: 99 }, signal())).hits[0]
  expect(hit?.text).toHaveLength(101)
  const later = new Date(Date.now() + 10_000)
  await utimes(join(docs, 'long.md'), later, later)
  await rm(extra, { recursive: true })
  runtime.reindex(base.id)
  await expect.poll(() => runtime.list()[0]?.status.missingDirectories).toEqual([extra])
  expect(runtime.list()[0]?.status).toMatchObject({ phase: 'ready', indexedFiles: 1, failedFiles: 1 })
  await rm(join(dataRoot, 'bases', base.id), { recursive: true })
  await writeFile(join(dataRoot, 'bases', base.id), 'file blocks the index directory')
  const second = await runtime.create({ name: 'b', directories: [] })
  await expect.poll(() => phase(runtime, second.id)).toBe('ready')
  expect(runtime.list().find(item => item.id === base.id)?.status.phase).toBe('ready')
})

it('cancels a running index on removal or disposal and skips a queued base that was removed', async () => {
  const dataRoot = await tempDir()
  const docs = await tempDir()
  for (let index = 0; index < 40; index += 1) await writeFile(join(docs, `${index}.md`), `内容 ${index}`)
  const { ctx, runtime } = await start(dataRoot, { indexYieldMs: 5 })
  const first = await runtime.create({ name: 'first', directories: [docs] })
  const queued = await runtime.create({ name: 'queued', directories: [] })
  await expect.poll(() => phase(runtime, first.id)).toBe('indexing')
  runtime.reindex(first.id)
  await runtime.remove(queued.id)
  await runtime.remove(first.id)
  expect(runtime.list()).toEqual([])
  const third = await runtime.create({ name: 'third', directories: [docs] })
  await expect.poll(() => phase(runtime, third.id)).toBe('indexing')
  await ctx.fiber.dispose()
  roots.splice(roots.indexOf(ctx), 1)
})

it('vectorizes lexical candidates on demand and reuses stored vectors', async () => {
  const dataRoot = await tempDir()
  const docs = await tempDir()
  await writeFile(join(docs, 'a.md'), '会计凭证保管期限为三十年。')
  await writeFile(join(docs, 'b.md'), '人事档案调阅需要部门负责人签字。')
  const { runtime } = await start(dataRoot, { retrieval: 'hybrid', vectorize: 'on-demand' })
  const base = await runtime.create({ name: 'a', directories: [docs] })
  await expect.poll(() => phase(runtime, base.id)).toBe('ready')
  expect(runtime.list()[0]?.status.vectorCount).toBe(0)
  const first = await runtime.search({ query: '会计凭证', knowledgeBaseIds: [], limit: 2 }, signal())
  expect(first.hits[0]).toMatchObject({ path: join(docs, 'a.md'), matchedBy: ['bm25', 'vector'] })
  const again = await runtime.search({ query: '会计凭证', knowledgeBaseIds: [], limit: 2 }, signal())
  expect(again.hits[0]?.path).toBe(join(docs, 'a.md'))
  runtime.reindex(base.id)
  await expect.poll(() => runtime.list()[0]?.status.vectorCount).toBe(1)
  const aborted = new AbortController()
  aborted.abort()
  await expect(runtime.search({ query: 'x', knowledgeBaseIds: [], limit: 1 }, aborted.signal)).rejects.toThrow()
  await expect(runtime.upload({ id: base.id, fileName: '.hidden.md', contentBase64: '' })).rejects.toMatchObject({ code: 'knowledge/invalid-input' })
})

it('rejects decoded uploads above the byte limit and accepts the base64 bound exactly', async () => {
  const dataRoot = await tempDir()
  const { runtime } = await start(dataRoot, { maxUploadBytes: 10 })
  const base = await runtime.create({ name: 'a', directories: [] })
  const twelve = Buffer.alloc(12, 1).toString('base64')
  await expect(runtime.upload({ id: base.id, fileName: 'a.md', contentBase64: twelve })).rejects.toMatchObject({ code: 'knowledge/unsupported-file' })
  await expect(runtime.upload({ id: base.id, fileName: 'a.md', contentBase64: Buffer.alloc(10, 1).toString('base64') })).resolves.toMatchObject({ size: 10 })
})

it('marks a base failed when its index cannot be opened', async () => {
  const dataRoot = await tempDir()
  await writeFile(join(dataRoot, 'bases'), 'a file where the index directory belongs')
  const { runtime } = await start(dataRoot)
  const base = await runtime.create({ name: 'a', directories: [] })
  await expect.poll(() => phase(runtime, base.id)).toBe('error')
  expect(runtime.list()[0]?.status.error).toEqual(expect.any(String))
})

it('renames without re-indexing, coalesces queued requests, and ends observers on disposal', async () => {
  const dataRoot = await tempDir()
  const docs = await tempDir()
  for (let index = 0; index < 20; index += 1) await writeFile(join(docs, `${index}.md`), `内容 ${index}`)
  const { ctx, runtime } = await start(dataRoot, { indexYieldMs: 5 })
  const busy = await runtime.create({ name: 'busy', directories: [docs] })
  const waiting = await runtime.create({ name: 'waiting', directories: [] })
  runtime.reindex(waiting.id)
  runtime.reindex(waiting.id)
  const renamed = await runtime.update({ id: busy.id, name: 'renamed', directories: [docs] })
  expect(renamed.name).toBe('renamed')
  const aborted = new AbortController()
  const first = runtime.follow(aborted.signal)[Symbol.asyncIterator]()
  await first.next()
  const pending = first.next()
  aborted.abort()
  expect((await pending).done).toBe(true)
  const open = runtime.follow(signal())[Symbol.asyncIterator]()
  await open.next()
  const ending = open.next()
  await ctx.fiber.dispose()
  roots.splice(roots.indexOf(ctx), 1)
  expect((await ending).done).toBe(true)
})

it('ranks several vectors and embeds through a configured endpoint', async () => {
  const dataRoot = await tempDir()
  const docs = await tempDir()
  await writeFile(join(docs, 'a.md'), '档案借阅登记')
  await writeFile(join(docs, 'b.md'), '档案借阅审批')
  const fetch = async (_url: string, init: { body: string }) => {
    const input = (JSON.parse(init.body) as { input: string[] }).input
    return new Response(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: [1, text.length % 3] })) }))
  }
  const original = globalThis.fetch
  globalThis.fetch = fetch as typeof globalThis.fetch
  try {
    const { runtime } = await start(dataRoot, {
      retrieval: 'hybrid', vectorize: 'eager',
      embedder: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', batchSize: 8, timeoutMs: 1000 },
    })
    const base = await runtime.create({ name: 'a', directories: [docs] })
    await expect.poll(() => phase(runtime, base.id)).toBe('ready')
    const result = await runtime.search({ query: '档案借阅', knowledgeBaseIds: [], limit: 5 }, signal())
    expect(result.hits.map(hit => hit.path).sort()).toEqual([join(docs, 'a.md'), join(docs, 'b.md')])
    expect(runtime.catalog().embedder).toBe('openai-compatible:m')
  } finally {
    globalThis.fetch = original
  }
})
