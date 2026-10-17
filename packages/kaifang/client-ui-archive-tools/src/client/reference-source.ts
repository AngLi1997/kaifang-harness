/** `@` trigger source listing archive tools and serializing their reference chips. */
import type { ReferenceInsert } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerCandidate, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ARCHIVE_TOOLS, isArchiveToolId, toolMention, type ArchiveToolId } from './catalog.ts'
import { TOOL_ICONS } from './icons.tsx'
import { en } from './locales.ts'

/** Trigger-source name; also the serializer key carried by reference chips. */
export const REFERENCE_SOURCE = 'kaifang-archive-tools'

type Translate = TranslateNS<'kaifang.archiveTools'>

/**
 * Build the reference chip of one tool.
 * @param t - this plugin's translator.
 * @param id - catalog tool.
 * @returns the chip inserted into a draft.
 */
export function toolReference(t: Translate, id: ArchiveToolId): ReferenceInsert {
  return { source: REFERENCE_SOURCE, ref: id, label: t(`tool.${id}.name`), clipboardText: toolMention(id) }
}

/**
 * List the tools matching one query. The id, the active-language copy, and
 * the English copy are all searched, so `ocr` and `OCR` match in any language.
 * @param t - this plugin's translator.
 * @param query - text typed after `@`.
 * @returns menu candidates in catalog order.
 */
export function toolCandidates(t: Translate, query: string): InputTriggerCandidate[] {
  const needle = query.trim().toLowerCase()
  return ARCHIVE_TOOLS.filter(({ id }) => needle === '' || [
    id,
    t(`tool.${id}.name`), en[`tool.${id}.name`],
    t(`tool.${id}.desc`), en[`tool.${id}.desc`],
  ].join(' ').toLowerCase().includes(needle)).map(({ id, meta }) => ({
    name: id,
    label: t(`tool.${id}.name`),
    description: t(meta),
    icon: TOOL_ICONS[id],
    section: t('menu.section'),
    value: id,
  }))
}

/**
 * Build the `@` source: candidates, the chip a pick inserts, the static
 * lexicon that decorates typed `@<id>` text, and the codec that sends a chip
 * to the model as its `@<id>` mention.
 * @param t - this plugin's translator.
 * @returns one trigger source.
 */
export function createToolSource(t: Translate): InputTriggerSource {
  const ids = ARCHIVE_TOOLS.map(tool => tool.id)
  return {
    trigger: '@',
    name: REFERENCE_SOURCE,
    // Ahead of the file/session reference group (order 0).
    order: -10,
    // Candidates carry their own section heading.
    showGroupTitle: false,
    candidates: (_session, request) => Promise.resolve(toolCandidates(t, request.query)),
    onPick: ({ candidate }) => isArchiveToolId(candidate.value) ? { insert: toolReference(t, candidate.value) } : undefined,
    lexicon: () => ids,
    codec: {
      clipboardText: ref => `@${ref}`,
      serialize: ref => Promise.resolve(`@${ref}`),
    },
  }
}
