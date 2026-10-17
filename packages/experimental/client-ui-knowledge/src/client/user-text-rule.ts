/** Recognize canonical knowledge base mentions in submitted user text. */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    knowledge: { readonly label: string; readonly id: string }
  }
}

const MENTION = /@\[([^\]\n]+)\]\(dsh-knowledge:([A-Za-z0-9_-]+)\)/gu

/** Nearest `@[label](dsh-knowledge:id)`; ordered before the file rule, which also starts at `@`. */
export const knowledgeMentionRule: UserTextRule<'knowledge'> = {
  id: 'knowledge',
  order: 20,
  match(text, from) {
    MENTION.lastIndex = from
    const match = MENTION.exec(text)
    if (match === null) return undefined
    return { id: 'knowledge', start: match.index, end: match.index + match[0].length, data: { label: match[1] as string, id: match[2] as string } }
  },
}
