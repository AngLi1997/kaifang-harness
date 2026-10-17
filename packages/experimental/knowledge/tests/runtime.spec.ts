/** The knowledge service indexes directories and uploads incrementally and serves BM25 and hybrid search. */
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, expect, it } from 'vitest'
import KnowledgeRuntime from '../src/index.ts'
import type { Config } from '../src/config.ts'
import type { KnowledgeBaseId, KnowledgeCatalog } from '../src/types.ts'

const roots: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function start(dataRoot: string, config: Partial<Config> = {}): Promise<KnowledgeRuntime> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(KnowledgeRuntime, KnowledgeRuntime.Config({ dataRoot, watch: false, ...config }))
  return ctx.knowledge
}

async function ready(runtime: KnowledgeRuntime, id: KnowledgeBaseId): Promise<KnowledgeCatalog> {
  const lifetime = new AbortController()
  try {
    for await (const catalog of runtime.follow(lifetime.signal)) {
      const base = catalog.bases.find(item => item.id === id)
      if (base?.status.phase === 'ready' || base?.status.phase === 'error') return catalog
    }
  } finally {
    lifetime.abort()
  }
  throw new Error('follow ended')
}

/** A one-page PDF whose text layer contains `text`. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

it('creates, indexes, searches, updates, and removes a knowledge base', async () => {
  const dataRoot = await tempDir('dsh-knowledge-data-')
  const docs = await tempDir('dsh-knowledge-docs-')
  await mkdir(join(docs, 'policy'))
  await mkdir(join(docs, 'node_modules'))
  await mkdir(join(docs, '.hidden'))
  await writeFile(join(docs, 'policy', 'borrow.md'), '# 档案借阅\n借阅档案需要填写借阅登记表，并由档案室审批。\n')
  await writeFile(join(docs, 'policy', 'return.txt'), '归还档案时核对页数。')
  await writeFile(join(docs, 'scan.pdf'), pdf('Retention schedule for contracts'))
  await writeFile(join(docs, 'node_modules', 'skip.md'), '档案借阅 skipped')
  await writeFile(join(docs, '.hidden', 'skip.md'), '档案借阅 hidden')
  await writeFile(join(docs, 'image.png'), 'not indexed')
  const runtime = await start(dataRoot)

  await expect(runtime.create({ name: '  ', directories: [] })).rejects.toMatchObject({ code: 'knowledge/invalid-input' })
  await expect(runtime.create({ name: 'x', directories: ['relative'] })).rejects.toMatchObject({ code: 'knowledge/invalid-directory' })
  await expect(runtime.create({ name: 'x', directories: [join(docs, 'missing')] })).rejects.toMatchObject({ code: 'knowledge/invalid-directory' })
  await expect(runtime.create({ name: 'x', directories: [dataRoot] })).rejects.toMatchObject({ code: 'knowledge/invalid-directory' })

  const base = await runtime.create({ name: '档案制度', directories: [docs, `${docs}/`] })
  expect(base).toMatchObject({ directories: [docs], mention: `@[档案制度](dsh-knowledge:${base.id})` })
  await expect(runtime.create({ name: '档案制度', directories: [] })).rejects.toMatchObject({ code: 'knowledge/duplicate-name' })
  const catalog = await ready(runtime, base.id)
  expect(catalog.bases[0]?.status).toMatchObject({ phase: 'ready', totalFiles: 3, indexedFiles: 3, failedFiles: 0 })
  expect(catalog.retrieval).toBe('bm25')

  const borrow = await runtime.search({ query: '借阅登记', knowledgeBaseIds: [base.id], limit: 5 }, new AbortController().signal)
  expect(borrow.hits[0]).toMatchObject({ path: join(docs, 'policy', 'borrow.md'), heading: '档案借阅', lineStart: 1, matchedBy: ['bm25'] })
  expect(borrow.searched).toEqual([{ id: base.id, name: '档案制度', phase: 'ready' }])
  const short = await runtime.search({ query: '页数', knowledgeBaseIds: [], limit: 5 }, new AbortController().signal)
  expect(short.hits.map(hit => hit.path)).toEqual([join(docs, 'policy', 'return.txt')])
  const pdfHits = await runtime.search({ query: 'retention', knowledgeBaseIds: [base.id], limit: 5 }, new AbortController().signal)
  expect(pdfHits.hits[0]).toMatchObject({ path: join(docs, 'scan.pdf'), heading: 'Page 1' })
  await expect(runtime.search({ query: ' ', knowledgeBaseIds: [], limit: 5 }, new AbortController().signal)).rejects.toMatchObject({ code: 'knowledge/invalid-input' })
  await expect(runtime.search({ query: 'x', knowledgeBaseIds: ['kb_missing' as KnowledgeBaseId], limit: 5 }, new AbortController().signal)).rejects.toMatchObject({ code: 'knowledge/not-found' })

  // Incremental pass: one changed file, one deleted file, one upload.
  await writeFile(join(docs, 'policy', 'return.txt'), '归还档案时核对页数和封条。')
  const later = new Date(Date.now() + 5000)
  await utimes(join(docs, 'policy', 'return.txt'), later, later)
  await rm(join(docs, 'scan.pdf'))
  await expect(runtime.upload({ id: base.id, fileName: 'evil.exe', contentBase64: '' })).rejects.toMatchObject({ code: 'knowledge/unsupported-file' })
  await expect(runtime.upload({ id: base.id, fileName: 'a.md', contentBase64: 'AAAA?' })).rejects.toMatchObject({ code: 'knowledge/invalid-input' })
  const uploaded = await runtime.upload({ id: base.id, fileName: '../../notes.md', contentBase64: Buffer.from('封条编号规则').toString('base64') })
  expect(uploaded).toMatchObject({ path: join(base.uploadDirectory, 'notes.md'), uploaded: true, state: 'pending' })
  const second = await runtime.upload({ id: base.id, fileName: 'notes.md', contentBase64: Buffer.from('x').toString('base64') })
  expect(second.path).toBe(join(base.uploadDirectory, 'notes (1).md'))
  await ready(runtime, base.id)
  const files = await runtime.files(base.id)
  expect(files.files.map(file => [file.path, file.state, file.uploaded])).toEqual([
    [join(docs, 'policy', 'borrow.md'), 'indexed', false],
    [join(docs, 'policy', 'return.txt'), 'indexed', false],
    [join(base.uploadDirectory, 'notes (1).md'), 'indexed', true],
    [join(base.uploadDirectory, 'notes.md'), 'indexed', true],
  ].sort((left, right) => String(left[0]).localeCompare(String(right[0]))))
  const seal = await runtime.search({ query: '封条', knowledgeBaseIds: [base.id], limit: 5 }, new AbortController().signal)
  expect(seal.hits.map(hit => hit.path).sort()).toEqual([join(docs, 'policy', 'return.txt'), join(base.uploadDirectory, 'notes.md')].sort())
  await expect(runtime.deleteUpload(base.id, join(docs, 'policy', 'borrow.md'))).rejects.toMatchObject({ code: 'knowledge/invalid-input' })
  await runtime.deleteUpload(base.id, uploaded.path)
  await ready(runtime, base.id)
  expect((await runtime.files(base.id)).files).toHaveLength(3)

  expect(runtime.candidates('档案', new AbortController().signal)).toEqual([{ id: base.id, name: '档案制度', indexedFiles: 3, phase: 'ready', mention: `@[档案制度](dsh-knowledge:${base.id})` }])
  expect(runtime.candidates('nothing', new AbortController().signal)).toEqual([])

  const renamed = await runtime.update({ id: base.id, name: '制度库', directories: [] })
  expect(renamed).toMatchObject({ name: '制度库', directories: [] })
  await ready(runtime, base.id)
  expect((await runtime.files(base.id)).files.map(file => file.uploaded)).toEqual([true])
  expect(JSON.parse(await readFile(join(dataRoot, 'bases.json'), 'utf8'))).toMatchObject({ version: 1, bases: [{ id: base.id, name: '制度库' }] })

  await runtime.remove(base.id)
  expect(runtime.list()).toEqual([])
  await expect(stat(join(dataRoot, 'bases', base.id))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(docs)).resolves.toBeDefined()
})

it('reloads definitions, keeps unchanged files, and ranks vectors in hybrid mode', async () => {
  const dataRoot = await tempDir('dsh-knowledge-data-')
  const docs = await tempDir('dsh-knowledge-docs-')
  await writeFile(join(docs, 'a.md'), '会计凭证保管期限为三十年。')
  await writeFile(join(docs, 'b.md'), '人事档案调阅需要部门负责人签字。')
  const first = await start(dataRoot, { retrieval: 'hybrid', vectorize: 'eager' })
  const base = await first.create({ name: 'docs', directories: [docs] })
  const catalog = await ready(first, base.id)
  expect(catalog).toMatchObject({ retrieval: 'hybrid', embedder: 'hashed-ngram-256' })
  expect(catalog.bases[0]?.status).toMatchObject({ chunkCount: 2, vectorCount: 2 })
  const hits = await first.search({ query: '会计凭证', knowledgeBaseIds: [base.id], limit: 1 }, new AbortController().signal)
  expect(hits).toMatchObject({ mode: 'hybrid', hits: [{ path: join(docs, 'a.md'), matchedBy: ['bm25', 'vector'] }] })
  await roots.splice(0)[0]?.fiber.dispose()

  const second = await start(dataRoot, { retrieval: 'hybrid', vectorize: 'on-demand' })
  expect(second.list().map(item => item.id)).toEqual([base.id])
  const reloaded = await ready(second, base.id)
  expect(reloaded.bases[0]?.status).toMatchObject({ indexedFiles: 2, chunkCount: 2, vectorCount: 2 })
  const vectorOnly = await second.search({ query: '签字 负责人', knowledgeBaseIds: [base.id], limit: 2 }, new AbortController().signal)
  expect(vectorOnly.hits[0]?.path).toBe(join(docs, 'b.md'))
})

it('rejects an invalid definition file instead of replacing it', async () => {
  const dataRoot = await tempDir('dsh-knowledge-data-')
  await writeFile(join(dataRoot, 'bases.json'), '{"version":2,"bases":[]}')
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  const fiber = ctx.plugin(KnowledgeRuntime, KnowledgeRuntime.Config({ dataRoot, watch: false }))
  await expect(fiber).rejects.toThrow(/version 1/)
  expect(await readFile(join(dataRoot, 'bases.json'), 'utf8')).toBe('{"version":2,"bases":[]}')
})

it('re-indexes after a watched directory changes', async () => {
  const dataRoot = await tempDir('dsh-knowledge-data-')
  const docs = await tempDir('dsh-knowledge-docs-')
  const runtime = await start(dataRoot, { watch: true, watchDebounceMs: 20 })
  const base = await runtime.create({ name: 'watched', directories: [docs] })
  expect((await ready(runtime, base.id)).bases[0]?.status).toMatchObject({ watching: true, totalFiles: 0 })
  await writeFile(join(docs, 'new.md'), '新增文件内容')
  await expect.poll(async () => (await runtime.search({ query: '新增文件', knowledgeBaseIds: [base.id], limit: 1 }, new AbortController().signal)).hits.length, { timeout: 5000 }).toBe(1)
})
