/** Card-pick action: reference a tool in the conversation shown by the main view. */
import type { Context } from '@deepseek-ai/cordis'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { toolMention, type ArchiveToolId } from './catalog.ts'
import { toolReference } from './reference-source.ts'

/** Services the pick action reads and drives. */
export type ToolPickServices = Pick<Context, 'sessions' | 'conversation' | 'layout' | 'uiWorkspace'>

/** Outcome of one card pick. */
export type ToolPickOutcome = 'inserted' | 'refused' | 'started'

/** Card-pick action and the deferred composer focus it owns. */
export interface ToolPicker {
  /**
   * Append the tool's chip to the draft of the conversation shown by the main
   * view, reveal that conversation, and return the keyboard to its composer.
   * Without a shown conversation, start one whose draft carries the mention.
   * @param id - picked catalog tool.
   * @returns what the pick did; `refused` keeps the draft and shows a composer notice.
   */
  pick(id: ArchiveToolId): ToolPickOutcome
  /** Cancel a pending composer focus. */
  dispose(): void
}

/**
 * Create the card-pick action.
 * @param services - Session, Conversation, layout, and Workspace navigation services.
 * @param t - this plugin's translator.
 * @returns the picker; its owner disposes it with the plugin.
 */
export function createToolPicker(services: ToolPickServices, t: TranslateNS<'kaifang.archiveTools'>): ToolPicker {
  const { sessions, conversation, layout, uiWorkspace } = services
  let frame: number | undefined
  const cancelFocus = (): void => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }
  return {
    pick(id) {
      const sessionId = mainSessionId(services)
      const actx = sessionId === undefined ? undefined : sessions.scope(sessionId)
      if (actx === undefined) {
        uiWorkspace.startSession(undefined, { prompt: `${toolMention(id)} `, clearPreviousDraft: true })
        return 'started'
      }
      const input = conversation.input.for(actx)
      const state = input.state.getSnapshot()
      const end = detectLength(state)
      const inserted = state.phase === 'plain'
        && input.insertReference(toolReference(t, id), { start: end, end, draftRev: state.draftRev })
      // null reveals the Conversation panel over this catalog.
      layout.selectPanel(null)
      if (!inserted) {
        input.notify('error', t('insert.failed'))
        return 'refused'
      }
      // The composer mounts when the Conversation panel commits; focus after that frame.
      cancelFocus()
      frame = requestAnimationFrame(() => {
        frame = undefined
        input.focus()
      })
      return 'inserted'
    },
    dispose: cancelFocus,
  }
}

/**
 * Find the Session the main view retains.
 * @param services - Session list owner.
 * @returns the shown Session, or undefined when no conversation is shown.
 */
function mainSessionId({ sessions }: ToolPickServices): SessionId | undefined {
  return Object.values(sessions.list.getSnapshot().byId)
    .find(row => (row.retainedBy.mainView ?? 0) > 0)?.id
}

/**
 * Length of the draft in span coordinates, where each reference chip counts as
 * one placeholder character, while `draft` expands chips to their clipboard text.
 * @param state - published input state.
 * @returns the end offset of the draft in span coordinates.
 */
function detectLength(state: InputState): number {
  return state.occurrences.reduce((length, occurrence) => length - occurrence.length + 1, state.draft.length)
}
