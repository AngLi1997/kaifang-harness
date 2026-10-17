/** Edge behavior of the index store, definition file, config, embedders, extraction, and scanning. */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readBases, writeBases } from '../src/bases.ts'
import { chunkParts } from '../src/chunk.ts'
import { ConfigSchema, validateConfig } from '../src/config.ts'
import { createHashedNgramEmbedder, createOpenAiCompatibleEmbedder, quantize } from '../src/embedding.ts'
import { extractText } from '../src/extract.ts'
import { fuseRanks } from '../src/fusion.ts'
import { formatKnowledgeMention } from '../src/mention.ts'
import { queryTerms } from '../src/query.ts'
import { scanRoots } from '../src/scan.ts'
import { KnowledgeIndexStore, KNOWLEDGE_INDEX_SCHEMA_VERSION } from '../src/store-sqlite.ts'
import type { KnowledgeBaseId } from '../src/types.ts'

const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
/** A one-page PDF whose content stream is `stream`. */
function pdf(stream: string): Buffer {
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

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-knowledge-edges-'))
  dirs.push(dir)
  return dir
}

describe('KnowledgeIndexStore', () => {
  it('rebuilds an index from another schema version and rejects a non-database file', async () => {
    const dir = await tempDir()
    const path = join(dir, 'index.sqlite')
    const { DatabaseSync } = await import('node:sqlite')
    const old = new DatabaseSync(path)
    old.exec('CREATE TABLE legacy(x); PRAGMA user_version = 99')
    old.close()
    const store = await KnowledgeIndexStore.open(path)
    store.close()
    store.close()
    const check = new DatabaseSync(path)
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: KNOWLEDGE_INDEX_SCHEMA_VERSION })
    expect(check.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?').get('legacy')).toEqual({ n: 0 })
    check.close()
    await writeFile(join(dir, 'bad.sqlite'), 'not a database at all, just text that is long enough to fill a header')
    await expect(KnowledgeIndexStore.open(join(dir, 'bad.sqlite'))).rejects.toThrow()
  })

  it('keeps unchanged files, records failures, reads vectors by hash, and rolls back failed writes', async () => {
    const store = await KnowledgeIndexStore.open(':memory:')
    const id = store.upsertPending('/a.md', '/', 1, 1)
    store.replaceChunks(id, 'h', [{ lineStart: 1, text: 'alpha', hash: 'c1' }, { heading: 'H', lineStart: 2, text: 'beta', hash: 'c2' }])
    store.markUnchanged(store.upsertPending('/a.md', '/', 1, 2))
    expect(store.listFiles(5)).toMatchObject([{ path: '/a.md', state: 'indexed', chunks: 2 }])
    store.markFailed(id, 'broken')
    expect(store.listFiles(5)).toMatchObject([{ state: 'failed', error: 'broken', chunks: 0 }])
    store.replaceChunks(id, 'h', [{ lineStart: 1, text: 'alpha', hash: 'c1' }])
    store.putVectors('m', [])
    store.putVectors('m', [{ hash: 'c1', vector: { scale: 0.5, data: Int8Array.from([1, -2]) } }])
    expect(store.vectors('m', ['c1', 'missing'])).toEqual(new Map([['c1', { scale: 0.5, data: Int8Array.from([1, -2]) }]]))
    expect(store.chunkIdsByHash(['c1', 'missing'])).toHaveLength(1)
    expect(store.chunks([999])).toEqual(new Map())
    expect(store.substring([], 5)).toEqual([])
    store.removeFiles([])
    expect(() => { store.replaceChunks(id, 'h', [{ lineStart: null as never, text: 'x', hash: 'x' }]) }).toThrow()
    expect(store.listFiles(5)).toMatchObject([{ chunks: 1 }])
    store.close()
  })
})

describe('definition file', () => {
  it('rejects malformed definitions and repeated ids', async () => {
    const dir = await tempDir()
    const path = join(dir, 'bases.json')
    const base = { id: 'kb_1', name: 'a', directories: [], createdAt: 1, updatedAt: 1 }
    for (const bad of [[1], [{ ...base, id: 'x y' }], [{ ...base, name: ' ' }], [{ ...base, directories: [1] }], [{ ...base, createdAt: '1' }], [base, base]]) {
      await writeFile(path, JSON.stringify({ version: 1, bases: bad }))
      await expect(readBases(path)).rejects.toThrow()
    }
    await mkdir(join(dir, 'dir.json'))
    await expect(readBases(join(dir, 'dir.json'))).rejects.toThrow()
    await writeBases(path, [{ ...base, id: 'kb_1' as KnowledgeBaseId }])
    expect(await readBases(path)).toEqual([base])
  })
})

describe('config', () => {
  it('applies defaults and rejects invalid extensions, overlap, and endpoint URLs', () => {
    const config = ConfigSchema({ dataRoot: '/d' })
    expect(config).toMatchObject({ retrieval: 'bm25', embedder: { provider: 'hashed-ngram', dimensions: 256 }, vectorize: 'on-demand' })
    expect(() => validateConfig({ ...config, extensions: ['md'] })).toThrow(/leading dot/)
    expect(() => validateConfig({ ...config, chunkOverlapChars: config.chunkChars })).toThrow(/smaller/)
    const remote = { provider: 'openai-compatible' as const, baseUrl: 'nope', model: 'm', batchSize: 1, timeoutMs: 1 }
    expect(() => validateConfig({ ...config, embedder: remote })).toThrow(/not a URL/)
    expect(validateConfig({ ...config, embedder: { ...remote, baseUrl: 'http://127.0.0.1:1/v1' } })).toBeDefined()
  })
})

describe('embedders and helpers', () => {
  it('hashes mixed and short words, and leaves an empty text as a zero vector', async () => {
    const embedder = createHashedNgramEmbedder(32)
    const [mixed, short, empty] = await embedder.embed(['档案abc编号', 'abc', ''], new AbortController().signal)
    expect(mixed?.some(value => value !== 0)).toBe(true)
    expect(short?.some(value => value !== 0)).toBe(true)
    expect(empty?.every(value => value === 0)).toBe(true)
    expect(quantize(empty as Float32Array)).toEqual({ scale: 0, data: new Int8Array(32) })
  })

  it('calls an OpenAI-compatible endpoint in batches and rejects malformed responses', async () => {
    const respond = vi.fn(async (_url: string, init: { body: string }) => {
      const input = (JSON.parse(init.body) as { input: string[] }).input
      const data = input.map((_text, index) => ({ index: input.length - 1 - index, embedding: [index + 1, 0] })).reverse()
      return new Response(JSON.stringify({ data }))
    })
    vi.stubGlobal('fetch', respond)
    const embedder = createOpenAiCompatibleEmbedder({ baseUrl: 'http://127.0.0.1:1/v1/', model: 'bge', batchSize: 2, timeoutMs: 1000 })
    expect(embedder.id).toBe('openai-compatible:bge')
    const vectors = await embedder.embed(['a', 'b', 'c'], new AbortController().signal)
    expect(vectors.map(vector => [...vector])).toEqual([[1, 0], [1, 0], [1, 0]])
    expect(respond).toHaveBeenCalledTimes(2)
    expect(respond.mock.calls[0]?.[0]).toBe('http://127.0.0.1:1/v1/embeddings')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [0, 2] }, { embedding: [3, 0] }] }))))
    expect((await embedder.embed(['a', 'b'], new AbortController().signal)).map(vector => [...vector])).toEqual([[0, 1], [1, 0]])
    for (const response of [
      new Response('no', { status: 500 }),
      new Response(JSON.stringify({ data: [] })),
      new Response(JSON.stringify({})),
      new Response(JSON.stringify({ data: [{}] })),
      new Response(JSON.stringify({ data: [{ embedding: [] }] })),
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => response))
      await expect(embedder.embed(['a'], new AbortController().signal)).rejects.toThrow()
    }
  })

  it('breaks fusion ties by first appearance, labels unnamed mentions by id, and splits mixed-script tokens', () => {
    expect(fuseRanks([{ signal: 'bm25', keys: ['a'] }, { signal: 'vector', keys: ['b'] }], 1).map(item => item.key)).toEqual(['a', 'b'])
    expect(formatKnowledgeMention('kb_1' as KnowledgeBaseId, '[]')).toBe('@[kb_1](dsh-knowledge:kb_1)')
    expect(queryTerms('档案abc', 10)).toEqual({ indexed: ['abc'], short: ['档案'] })
    expect(chunkParts([{ text: '   ' }], { chunkChars: 100, overlapChars: 0 })).toEqual([])
    expect(chunkParts([{ label: 'Slide 1', text: '# Title\nbody' }], { chunkChars: 100, overlapChars: 0 })).toEqual([
      { heading: 'Slide 1 › Title', lineStart: 1, text: '# Title\nbody' },
    ])
    const overlapped = chunkParts([{ text: ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30), 'd'.repeat(30)].join('\n') }], { chunkChars: 70, overlapChars: 20 })
    expect(overlapped.map(chunk => chunk.lineStart)).toEqual([1, 3])
  })
})

describe('extractText edges', () => {
  it('decodes entities, tolerates missing Office parts, and reads sparse worksheets and multi-line PDFs', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.html'), '<p>&#x4f60;&#X597D; &unknown; &lt;b&gt;</p>')
    await writeFile(join(dir, 'empty.docx'), zipSync({ 'other.xml': strToU8('<x/>') }))
    await writeFile(join(dir, 'plain.xlsx'), zipSync({
      'xl/worksheets/sheet2.xml': strToU8('<row><c><v>2</v></c></row>'),
      'xl/worksheets/sheet1.xml': strToU8('<row><c r="A1"/><c t="s"><v>9</v></c></row><row><c><is><t>inline</t></is></c><c><f>1+1</f></c></row>'),
    }))
    await writeFile(join(dir, 'two.pdf'), pdf('BT /F1 12 Tf 72 720 Td (Line one) Tj 0 -20 Td (Line two) Tj ET'))
    expect(await extractText(join(dir, 'a.html'))).toEqual([{ text: '你好 &unknown; <b>\n' }])
    expect(await extractText(join(dir, 'empty.docx'))).toEqual([])
    expect(await extractText(join(dir, 'plain.xlsx'))).toEqual([{ label: 'Sheet 1', text: 'inline\t' }, { label: 'Sheet 2', text: '2' }])
    expect((await extractText(join(dir, 'two.pdf')))[0]?.text).toMatch(/Line one\s*\n\s*Line two/u)
    await writeFile(join(dir, 'broken.docx'), 'not a zip')
    await expect(extractText(join(dir, 'broken.docx'))).rejects.toThrow()
  })
})

describe('scanRoots', () => {
  it('reports missing and non-directory roots, skips links and large files, and stops at the file limit', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.md'), 'a')
    await writeFile(join(dir, 'b.md'), 'b')
    await writeFile(join(dir, 'big.md'), 'x'.repeat(100))
    await symlink(join(dir, 'a.md'), join(dir, 'link.md'))
    const options = { extensions: new Set(['.md']), excludedDirectories: new Set<string>(), maxFileBytes: 10, maxFiles: 1 }
    const result = await scanRoots([join(dir, 'missing'), join(dir, 'a.md'), dir, dir], options, new AbortController().signal, async () => {})
    expect(result.missing).toEqual([join(dir, 'missing'), join(dir, 'a.md')])
    expect(result.limitReached).toBe(true)
    expect(result.files.size).toBe(1)
    const all = await scanRoots([dir, dir], { ...options, maxFiles: 10 }, new AbortController().signal, async () => {})
    expect([...all.files.keys()].sort()).toEqual([join(dir, 'a.md'), join(dir, 'b.md')])
    const aborted = new AbortController()
    aborted.abort()
    await expect(scanRoots([dir], options, aborted.signal, async () => {})).rejects.toThrow()
  })
})
