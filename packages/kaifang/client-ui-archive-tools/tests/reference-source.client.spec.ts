/** The @ source lists matching tools, inserts their chips, and serializes them as mentions. */
import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { InputTriggerPick } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createToolSource, REFERENCE_SOURCE, toolCandidates } from '../src/client/reference-source.ts'
import { TOOL_ICONS } from '../src/client/icons.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as TranslateNS<'kaifang.archiveTools'>
const session = { sessionId: 'session-1' as SessionId }

function pick(value: string | undefined): InputTriggerPick {
  return {
    candidate: { name: value ?? 'none', ...value === undefined ? {} : { value } },
    session, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 0 },
  }
}

describe('archive tool @ source', () => {
  it('lists every tool in catalog order with its group metadata', () => {
    const candidates = toolCandidates(t, '')
    expect(candidates.map(candidate => candidate.name)).toEqual(['ocr', 'pdf', 'repair', 'polish', 'demo'])
    expect(candidates[0]).toEqual({
      name: 'ocr', label: 'OCR 文字识别', description: '本地 · 图像处理', icon: TOOL_ICONS.ocr, section: '档案工具', value: 'ocr',
    })
    expect(candidates[3]?.description).toBe('本地 · 文档处理')
    expect(candidates[4]?.description).toBe('在线')
  })

  it('matches the id, the active-language copy, and the English copy', () => {
    expect(toolCandidates(t, ' OCR ').map(candidate => candidate.name)).toEqual(['ocr'])
    expect(toolCandidates(t, '润色').map(candidate => candidate.name)).toEqual(['polish'])
    expect(toolCandidates(t, 'searchable pdf').map(candidate => candidate.name)).toEqual(['pdf'])
    expect(toolCandidates(t, 'nothing-matches')).toEqual([])
  })

  it('inserts a chip for a catalog tool and ignores other values', async () => {
    const source = createToolSource(t)
    expect(source).toMatchObject({ trigger: '@', name: REFERENCE_SOURCE, order: -10, showGroupTitle: false })
    await expect(source.candidates(session, { query: 'demo', position: 'inline', drilled: false, signal: new AbortController().signal }))
      .resolves.toHaveLength(1)
    expect(source.onPick(pick('repair'))).toEqual({
      insert: { source: REFERENCE_SOURCE, ref: 'repair', label: 'AI 修档案', clipboardText: '@repair' },
    })
    expect(source.onPick(pick('unknown'))).toBeUndefined()
    expect(source.onPick(pick(undefined))).toBeUndefined()
    expect(source.lexicon?.(session)).toEqual(['ocr', 'pdf', 'repair', 'polish', 'demo'])
    expect(source.codec?.clipboardText('ocr')).toBe('@ocr')
    await expect(source.codec?.serialize('ocr', new AbortController().signal)).resolves.toBe('@ocr')
  })
})
