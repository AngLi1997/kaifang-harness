/** knowledge_search runs through the tool registry against the real knowledge service. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import KnowledgeRuntime from '@deepseek-ai/dsh-experimental-knowledge'
import type { KnowledgeBaseId } from '@deepseek-ai/dsh-experimental-knowledge/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { afterEach, expect, it } from 'vitest'
import * as ToolKnowledge from '../src/index.ts'

const roots: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-tool-knowledge-data-'))
  const docs = await mkdtemp(join(tmpdir(), 'dsh-tool-knowledge-docs-'))
  dirs.push(dataRoot, docs)
  await writeFile(join(docs, 'guide.md'), '# 借阅\n借阅档案需要填写借阅登记表。\n')
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(KnowledgeRuntime, KnowledgeRuntime.Config({ dataRoot, watch: false }))
  const fiber = await ctx.plugin(ToolKnowledge, ToolKnowledge.Config({}))
  const base = await ctx.knowledge.create({ name: '制度', directories: [docs] })
  await expect.poll(() => ctx.knowledge.list()[0]?.status.phase).toBe('ready')
  return { ctx, fiber, base, docs }
}

let counter = 0
function call(ctx: Context, args: unknown) {
  return ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`call-${++counter}`), name: 'knowledge_search', arguments: args })
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.text ?? '').join('')
}

it('returns cited passages, a replayable search card, and prompt guidance', async () => {
  const { ctx, base, docs } = await fixture()
  const result = await call(ctx, { query: '借阅登记', knowledgeBaseIds: [base.id] })
  expect(result.isError).toBe(false)
  expect(text(result)).toBe([
    ToolKnowledge.KNOWLEDGE_CONTENT_NOTICE,
    'Searched: 制度',
    `[1] ${join(docs, 'guide.md')} — 借阅 (line 1, 制度)\n# 借阅\n借阅档案需要填写借阅登记表。`,
    'Cite the file paths of the passages you use.',
  ].join('\n\n'))
  expect(result.meta).toEqual({ files: [{ path: join(docs, 'guide.md'), matches: [{ lineNumber: 1, line: '借阅' }] }] })
  expect(ToolKnowledge.presentKnowledgeResult({ content: [], isError: false, meta: result.meta ?? null })).toEqual({
    card: 'search', shape: 'matches', files: [{ path: join(docs, 'guide.md'), matches: [{ lineNumber: 1, line: '借阅' }] }], truncated: false, total: 1,
  })
  expect(ToolKnowledge.presentKnowledgeResult({ content: [], isError: false, meta: { files: 'x' } })).toBeUndefined()
  expect(ToolKnowledge.presentKnowledgeCall({ query: 'q' })).toEqual({ card: 'generic', title: 'q', kind: 'search', rawInput: 'q' })
  const assembly = await ctx.systemPrompt.assemble()
  expect(assembly.sections.find(section => section.name === 'tool:knowledge_search')?.text).toBe(ToolKnowledge.KNOWLEDGE_PROMPT)
})

it('reports empty results, invalid arguments, and unknown bases as tool errors', async () => {
  const { ctx, fiber } = await fixture()
  expect(text(await call(ctx, { query: 'unrelated words here' }))).toContain('No matching passages.')
  expect((await call(ctx, { query: ' ' })).isError).toBe(true)
  expect((await call(ctx, { query: 'x', limit: 0 })).isError).toBe(true)
  const missing = await call(ctx, { query: 'x', knowledgeBaseIds: ['kb_missing' as KnowledgeBaseId] })
  expect(missing.isError).toBe(true)
  expect(text(missing)).toContain('kb_missing')
  await fiber.dispose()
  expect(ctx.tools.get('knowledge_search')).toBeUndefined()
  expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'tool:knowledge_search')).toBe(false)
})

it('marks incomplete bases, omits missing headings, truncates card lines, and rejects malformed card metadata', async () => {
  const hit = {
    knowledgeBaseId: 'kb_1' as KnowledgeBaseId, knowledgeBaseName: 'k', path: '/a.txt', lineStart: 3,
    text: 'y'.repeat(200), score: 1, matchedBy: ['bm25' as const],
  }
  const result = { hits: [hit], searched: [{ id: 'kb_1' as KnowledgeBaseId, name: 'k', phase: 'indexing' as const }], mode: 'bm25' as const }
  expect(ToolKnowledge.formatKnowledgeResult(result)).toContain('Searched: k (indexing; results may be incomplete)')
  expect(ToolKnowledge.formatKnowledgeResult(result)).toContain('[1] /a.txt (line 3, k)')
  expect(ToolKnowledge.formatKnowledgeResult({ ...result, hits: [], searched: [] })).toContain('Searched: no knowledge bases')
  expect(ToolKnowledge.knowledgeCardMeta(result).files[0]?.matches[0]?.line).toBe(`${'y'.repeat(160)}…`)
  for (const meta of [null, [], 'x', { files: [1] }]) {
    expect(ToolKnowledge.presentKnowledgeResult({ content: [], isError: false, meta })).toBeUndefined()
  }
  expect(ToolKnowledge.presentKnowledgeResult({ content: [], isError: true, meta: { files: [] } })).toBeUndefined()
  const { ctx } = await fixture()
  const tool = ctx.tools.get('knowledge_search')
  expect(tool?.presentCall?.({ query: 'q' })).toMatchObject({ title: 'q' })
  expect(tool?.presentResult?.({ query: 'q' }, { content: [], isError: false, meta: { files: [] } })).toMatchObject({ card: 'search', total: 0 })
})

it('omits the guidance from a scope that hides the tool, and is concurrency safe', async () => {
  const { ctx } = await fixture()
  expect(ctx.tools.get('knowledge_search')?.isConcurrencySafe?.({ query: 'q' })).toBe(true)
  const key = {}
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['tools', 'systemPrompt'] }))
  const release = scope.ctx.tools.restrict({ allow: [] })
  try {
    const assembly = await ctx.systemPrompt.assemble({ scope: key })
    expect(assembly.sections.find(section => section.name === 'tool:knowledge_search')?.text ?? '').toBe('')
  } finally {
    release()
    await scope.dispose()
  }
})
