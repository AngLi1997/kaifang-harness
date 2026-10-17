import { describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ClientSessionContext, InputTriggerCandidate } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { KnowledgeBaseId, KnowledgeMentionCandidate } from '@deepseek-ai/dsh-experimental-knowledge/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { baseName, encodeBase64, extensionOf, knowledgeDraft } from '../src/client/draft.ts'
import { en } from '../src/client/locales.ts'
import { createMentionSource } from '../src/client/mention-source.ts'
import { knowledgeMentionRule } from '../src/client/user-text-rule.ts'

const id = 'kb_1' as KnowledgeBaseId
const candidate: KnowledgeMentionCandidate = { id, name: '制度', indexedFiles: 3, phase: 'ready', mention: '@[制度](dsh-knowledge:kb_1)' }
const session: ClientSessionContext = { sessionId: 's' as SessionId }
const t = makeTranslate(en)
const pick = { session, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 0 } } as const

describe('@ source', () => {
  it('lists candidates, skips path queries, and inserts a folder chip', async () => {
    const fetch = vi.fn(async () => [candidate, { ...candidate, name: 'x', phase: 'error' as const }])
    const source = createMentionSource(fetch, t)
    const signal = new AbortController().signal
    const rows = await source.candidates(session, { query: '制', position: 'inline', drilled: false, signal })
    expect(rows.map(row => [row.name, row.description, row.section])).toEqual([
      ['制度', '3 files · Ready', 'Knowledge bases'],
      ['x', '3 files · Indexing failed', 'Knowledge bases'],
    ])
    expect(fetch).toHaveBeenCalledWith('制', signal)
    expect(await source.candidates(session, { query: 'a/b', position: 'inline', drilled: false, signal })).toEqual([])
    expect(await source.candidates(session, { query: 'a', quoted: true, position: 'inline', drilled: false, signal })).toEqual([])
    expect(source.onPick({ ...pick, candidate: rows[0] as InputTriggerCandidate })).toEqual({
      insert: { source: 'knowledge', ref: candidate.mention, label: '制度', appearance: 'folder', clipboardText: candidate.mention },
    })
    expect(source.onPick({ ...pick, candidate: { name: 'x' } })).toBeUndefined()
    expect(source.codec?.clipboardText('r')).toBe('r')
    expect(await source.codec?.serialize('r', signal)).toBe('r')
  })
})

describe('mention text rule', () => {
  it('matches canonical mentions from the given offset only', () => {
    const text = 'see @[a b](dsh-knowledge:kb_1) and @[c](dsh-knowledge:kb_2) not @[d](dsh-session:s)'
    const first = knowledgeMentionRule.match(text, 0, {} as never)
    expect(first).toEqual({ id: 'knowledge', start: 4, end: 30, data: { label: 'a b', id: 'kb_1' } })
    expect(knowledgeMentionRule.match(text, 30, {} as never)).toMatchObject({ data: { id: 'kb_2' } })
    expect(knowledgeMentionRule.match(text, 60, {} as never)).toBeUndefined()
  })
})

describe('draft helpers', () => {
  it('builds a draft whose chip span equals its mention', () => {
    const draft = knowledgeDraft(candidate.mention, '制度', 'Q: ')
    const reference = draft.references[0]
    expect(draft.text).toBe('@[制度](dsh-knowledge:kb_1) Q: ')
    expect(draft.text.slice(reference?.offset, (reference?.offset ?? 0) + (reference?.length ?? 0))).toBe(reference?.clipboardText)
  })

  it('encodes base64 across chunk boundaries and reads names and extensions', () => {
    const bytes = new Uint8Array(0x8000 + 3).map((_, index) => index % 256)
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
    expect(extensionOf('A.MD')).toBe('.md')
    expect(extensionOf('.hidden')).toBe('')
    expect(extensionOf('none')).toBe('')
    expect(baseName('/a/b/c.md')).toBe('c.md')
    expect(baseName('C:\\x\\y.txt')).toBe('y.txt')
  })
})
