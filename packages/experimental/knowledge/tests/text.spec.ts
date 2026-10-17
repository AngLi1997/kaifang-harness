/** Chunking, query terms, rank fusion, embeddings, and extraction behave independently of the service. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { chunkParts } from '../src/chunk.ts'
import { createHashedNgramEmbedder, quantize, similarity } from '../src/embedding.ts'
import { extractText } from '../src/extract.ts'
import { fuseRanks } from '../src/fusion.ts'
import { formatKnowledgeMention, parseKnowledgeMentions } from '../src/mention.ts'
import { likePattern, matchExpression, queryTerms } from '../src/query.ts'
import type { KnowledgeBaseId } from '../src/types.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

describe('chunkParts', () => {
  it('starts a chunk at each heading and records its first line', () => {
    const chunks = chunkParts([{ text: 'intro\n# 借阅\n第一行\n第二行\n## 归还\n还书' }], { chunkChars: 200, overlapChars: 0 })
    expect(chunks).toEqual([
      { lineStart: 1, text: 'intro' },
      { heading: '借阅', lineStart: 2, text: '# 借阅\n第一行\n第二行' },
      { heading: '归还', lineStart: 5, text: '## 归还\n还书' },
    ])
  })

  it('bounds chunk size, splits long lines, and repeats trailing lines as overlap', () => {
    const text = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(250)].join('\n')
    const chunks = chunkParts([{ label: 'Page 1', text }], { chunkChars: 100, overlapChars: 45 })
    expect(chunks.every(chunk => chunk.heading === 'Page 1')).toBe(true)
    expect(chunks[0]).toMatchObject({ lineStart: 1, text: `${'a'.repeat(40)}\n${'b'.repeat(40)}` })
    expect(chunks[1]?.text.startsWith('b'.repeat(40))).toBe(true)
    expect(chunks.filter(chunk => chunk.text.startsWith('d')).map(chunk => chunk.lineStart)).toEqual([4, 4, 4])
    expect(Math.max(...chunks.map(chunk => chunk.text.length))).toBeLessThanOrEqual(100)
  })
})

describe('queryTerms', () => {
  it('splits CJK runs into trigrams and keeps short terms for substring scan', () => {
    expect(queryTerms('档案借阅 流程 of API', 10)).toEqual({ indexed: ['档案借', '案借阅', 'api'], short: ['流程', 'of'] })
    expect(queryTerms('一二三四五六', 2)).toEqual({ indexed: ['一二三', '二三四'], short: [] })
  })

  it('quotes FTS terms and escapes LIKE patterns', () => {
    expect(matchExpression([])).toBeUndefined()
    expect(matchExpression(['a"b', 'cde'])).toBe('"a""b" OR "cde"')
    expect(likePattern('5%_\\')).toBe('%5\\%\\_\\\\%')
  })
})

describe('fuseRanks', () => {
  it('sums reciprocal ranks and records contributing signals', () => {
    const fused = fuseRanks([
      { signal: 'bm25', keys: ['a', 'b', 'a'] },
      { signal: 'vector', keys: ['b', 'c'] },
    ], 1)
    expect(fused.map(item => item.key)).toEqual(['b', 'a', 'c'])
    expect(fused[0]).toMatchObject({ score: 1 / 3 + 1 / 2, signals: ['bm25', 'vector'] })
  })
})

describe('hashed n-gram embedder', () => {
  it('ranks lexically related text above unrelated text', async () => {
    const embedder = createHashedNgramEmbedder(256)
    const [query, near, far] = (await embedder.embed(['档案借阅流程', '借阅档案需要登记流程', 'weather forecast tomorrow'], new AbortController().signal))
      .map(vector => quantize(vector))
    expect(embedder.id).toBe('hashed-ngram-256')
    expect(similarity(query!, near!)).toBeGreaterThan(0.4)
    expect(similarity(query!, far!)).toBeLessThan(0.1)
    expect(similarity(query!, { scale: 1, data: new Int8Array(3) })).toBe(0)
  })
})

describe('mentions', () => {
  it('formats sanitized labels and parses them back with offsets', () => {
    const mention = formatKnowledgeMention('kb_1' as KnowledgeBaseId, '产品[文档](v2)')
    expect(mention).toBe('@[产品 文档 v2](dsh-knowledge:kb_1)')
    expect(parseKnowledgeMentions(`问 ${mention} 和 @[x](dsh-session:s)`)).toEqual([{ id: 'kb_1', label: '产品 文档 v2', start: 2, end: 2 + mention.length }])
  })
})

describe('extractText', () => {
  it('reads plain text, HTML, and Office XML parts, and treats NUL bytes as binary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-knowledge-extract-'))
    dirs.push(dir)
    const docx = zipSync({ 'word/document.xml': strToU8('<w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">A &amp; B</w:t></w:r></w:p></w:body>') })
    const pptx = zipSync({
      'ppt/slides/slide2.xml': strToU8('<a:p><a:t>second</a:t></a:p>'),
      'ppt/slides/slide1.xml': strToU8('<a:p><a:t>first</a:t></a:p>'),
    })
    const xlsx = zipSync({
      'xl/sharedStrings.xml': strToU8('<sst><si><t>名称</t></si><si><t>数量</t></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8('<sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c><v>7</v></c><c t="inlineStr"><is><t>x</t></is></c></row></sheetData>'),
    })
    await writeFile(join(dir, 'a.docx'), docx)
    await writeFile(join(dir, 'b.pptx'), pptx)
    await writeFile(join(dir, 'c.xlsx'), xlsx)
    await writeFile(join(dir, 'd.html'), '<style>x{}</style><p>Hello&nbsp;<b>world</b></p><p>&#20320;</p>')
    await writeFile(join(dir, 'e.txt'), Buffer.from([0x61, 0x00, 0x62]))
    expect(await extractText(join(dir, 'a.docx'))).toEqual([{ text: '第一段\nA & B' }])
    expect(await extractText(join(dir, 'b.pptx'))).toEqual([{ label: 'Slide 1', text: 'first' }, { label: 'Slide 2', text: 'second' }])
    expect(await extractText(join(dir, 'c.xlsx'))).toEqual([{ label: 'Sheet 1', text: '名称\t数量\n7\tx' }])
    expect(await extractText(join(dir, 'd.html'))).toEqual([{ text: 'Hello world\n你\n' }])
    expect(await extractText(join(dir, 'e.txt'))).toEqual([{ text: '' }])
  })
})
