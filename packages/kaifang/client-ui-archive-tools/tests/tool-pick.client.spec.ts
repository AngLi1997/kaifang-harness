// @vitest-environment jsdom
/** A card pick references the tool in the shown conversation or starts one. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createToolPicker, type ToolPickServices } from '../src/client/tool-pick.ts'
import { REFERENCE_SOURCE } from '../src/client/reference-source.ts'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as TranslateNS<'kaifang.archiveTools'>
const shown = 'shown' as SessionId
const background = 'background' as SessionId

interface Harness {
  readonly services: ToolPickServices
  readonly input: { insertReference: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> }
  readonly selectPanel: ReturnType<typeof vi.fn>
  readonly startSession: ReturnType<typeof vi.fn>
}

function harness(options: { mainView?: SessionId; scoped?: boolean; state?: Partial<InputState>; accept?: boolean } = {}): Harness {
  const row = (id: SessionId) => ({ id, retainedBy: id === options.mainView ? { mainView: 1 } : {} })
  const state = { draft: '', draftRev: 3, phase: 'plain', occurrences: [], ...options.state }
  const input = {
    state: { getSnapshot: () => state },
    insertReference: vi.fn(() => options.accept ?? true),
    notify: vi.fn(),
    focus: vi.fn(),
  }
  const selectPanel = vi.fn()
  const startSession = vi.fn()
  const services = {
    sessions: {
      list: { getSnapshot: () => ({ byId: { [background]: row(background), [shown]: row(shown) } }) },
      scope: (id: SessionId) => options.scoped === false ? undefined : { id },
    },
    conversation: { input: { for: () => input } },
    layout: { selectPanel },
    uiWorkspace: { startSession },
  } as never as ToolPickServices
  return { services, input, selectPanel, startSession }
}

describe('archive tool card pick', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] }) })
  afterEach(() => { vi.useRealTimers() })

  it('starts a conversation carrying the mention when none is shown', () => {
    for (const setup of [{}, { mainView: shown, scoped: false }]) {
      const { services, startSession, selectPanel } = harness(setup)
      expect(createToolPicker(services, t).pick('ocr')).toBe('started')
      expect(startSession).toHaveBeenCalledWith(undefined, { prompt: '@ocr ', clearPreviousDraft: true })
      expect(selectPanel).not.toHaveBeenCalled()
    }
  })

  it('appends the chip after existing chips, reveals the conversation, and focuses the composer after a frame', () => {
    const { services, input, selectPanel } = harness({
      mainView: shown,
      // "see @ocr and " — one chip whose clipboard text is four characters.
      state: { draft: 'see @ocr and ', occurrences: [{ occurrenceId: 1, source: REFERENCE_SOURCE, ref: 'ocr', offset: 4, length: 4, label: 'OCR', clipboardText: '@ocr' }] },
    })
    expect(createToolPicker(services, t).pick('pdf')).toBe('inserted')
    expect(input.insertReference).toHaveBeenCalledWith(
      { source: REFERENCE_SOURCE, ref: 'pdf', label: '图片转双层 PDF', clipboardText: '@pdf' },
      { start: 10, end: 10, draftRev: 3 },
    )
    expect(selectPanel).toHaveBeenCalledWith(null)
    expect(input.focus).not.toHaveBeenCalled()
    vi.advanceTimersToNextFrame()
    expect(input.focus).toHaveBeenCalledTimes(1)
  })

  it('keeps the draft and shows a notice when the composer refuses the chip', () => {
    for (const setup of [{ accept: false }, { state: { phase: 'submitting' as const } }]) {
      const { services, input, selectPanel } = harness({ mainView: shown, ...setup })
      expect(createToolPicker(services, t).pick('demo')).toBe('refused')
      expect(selectPanel).toHaveBeenCalledWith(null)
      expect(input.notify).toHaveBeenCalledWith('error', zh['insert.failed'])
      vi.advanceTimersToNextFrame()
      expect(input.focus).not.toHaveBeenCalled()
    }
  })

  it('cancels a pending focus on a newer pick and on disposal', () => {
    const { services, input } = harness({ mainView: shown })
    const picker = createToolPicker(services, t)
    picker.pick('ocr')
    picker.pick('pdf')
    vi.advanceTimersToNextFrame()
    expect(input.focus).toHaveBeenCalledTimes(1)
    picker.pick('repair')
    picker.dispose()
    vi.advanceTimersToNextFrame()
    expect(input.focus).toHaveBeenCalledTimes(1)
  })
})
