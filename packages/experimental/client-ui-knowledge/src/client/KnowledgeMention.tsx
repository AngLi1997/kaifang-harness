/** Transcript chip for a knowledge base mention; activation opens the knowledge base page. */
import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './user-text-rule.ts'

/** Navigation injected into the chip. */
export interface KnowledgeMentionInjected {
  /** Show the knowledge base page. */
  readonly openPage: () => void
}

/**
 * Render one mention as a folder chip.
 * @param props - matched node, original spelling, interaction policy, and navigation.
 * @returns the inline chip.
 */
export function KnowledgeMention({ node, raw, interactive, openPage }: UserTextNodeProps<'knowledge'> & InjectFace<KnowledgeMentionInjected>) {
  return <ReferenceChip appearance="folder" label={node.data.label} title={raw} {...interactive ? { onActivate: openPage } : {}} />
}
