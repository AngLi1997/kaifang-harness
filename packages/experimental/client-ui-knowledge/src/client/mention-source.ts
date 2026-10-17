/** The `@` menu source that lists knowledge bases and inserts their mention chips. */
import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputTriggerCandidate, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { KnowledgeIndexPhase, KnowledgeMentionCandidate } from '@deepseek-ai/dsh-experimental-knowledge/types'
import { KNOWLEDGE_SOURCE } from './draft.ts'
import type { KnowledgeKey } from './locales.ts'

type Translate = (key: KnowledgeKey, params?: Record<string, unknown>) => string

/** Pick payload carried by each candidate. */
interface CandidateValue {
  readonly label: string
  readonly mention: string
}

/**
 * Project Host candidates to menu rows.
 * @param candidates - Host candidates in Host order.
 * @param t - knowledge dictionary.
 * @returns menu rows under the knowledge section.
 */
export function mentionRows(candidates: readonly KnowledgeMentionCandidate[], t: Translate): InputTriggerCandidate[] {
  return candidates.map(candidate => ({
    name: candidate.name,
    description: t('mention.description', { files: candidate.indexedFiles, phase: phaseLabel(candidate.phase, t) }),
    icon: IconDatabaseOutlineRegular,
    section: t('mention.section'),
    value: JSON.stringify({ label: candidate.name, mention: candidate.mention } satisfies CandidateValue),
  }))
}

function phaseLabel(phase: KnowledgeIndexPhase, t: Translate): string {
  return phase === 'error' ? t('phase.failed') : t(`phase.${phase}`)
}

/**
 * Create the `@` source.
 * @param fetchCandidates - Host candidate lookup; rejects on transport failure.
 * @param t - knowledge dictionary.
 * @returns the source registered with the input-trigger service.
 */
export function createMentionSource(
  fetchCandidates: (query: string, signal: AbortSignal) => Promise<readonly KnowledgeMentionCandidate[]>,
  t: Translate,
): InputTriggerSource {
  return {
    trigger: '@',
    name: KNOWLEDGE_SOURCE,
    order: -1,
    showGroupTitle: false,
    async candidates(_session, { query, quoted, signal }) {
      // A quoted token is a file path being typed; knowledge base names never use that spelling.
      if (quoted === true || query.includes('/')) return []
      return mentionRows(await fetchCandidates(query, signal), t)
    },
    onPick({ candidate }) {
      if (candidate.value === undefined) return undefined
      const value = JSON.parse(candidate.value) as CandidateValue
      return {
        insert: { source: KNOWLEDGE_SOURCE, ref: value.mention, label: value.label, appearance: 'folder', clipboardText: value.mention },
      }
    },
    codec: {
      clipboardText: ref => ref,
      serialize: ref => Promise.resolve(ref),
    },
  }
}
