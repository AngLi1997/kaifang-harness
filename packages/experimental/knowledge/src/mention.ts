/**
 * Canonical knowledge base mention grammar shared by the Host tool guidance
 * and browser surfaces: `@[label](dsh-knowledge:<id>)`. The module has no
 * runtime imports.
 * @module @deepseek-ai/dsh-experimental-knowledge/mention
 */

import type { KnowledgeBaseId } from './types.ts'

/** URI scheme of a knowledge base mention. */
export const KNOWLEDGE_MENTION_SCHEME = 'dsh-knowledge'

/** One parsed mention. */
export interface KnowledgeMention {
  /** Referenced base. */
  id: KnowledgeBaseId
  /** Label text between the brackets. */
  label: string
  /** UTF-16 offset of the leading `@`. */
  start: number
  /** UTF-16 offset after the closing parenthesis. */
  end: number
}

const MENTION = /@\[([^\]\n]+)\]\(dsh-knowledge:([A-Za-z0-9_-]+)\)/gu

/**
 * Format the canonical mention of one knowledge base.
 * @param id - referenced base.
 * @param name - user-facing name; brackets, parentheses, and line breaks become spaces.
 * @returns the mention text.
 */
export function formatKnowledgeMention(id: KnowledgeBaseId, name: string): string {
  const label = name.replace(/[[\]()\r\n]+/gu, ' ').trim()
  return `@[${label === '' ? id : label}](${KNOWLEDGE_MENTION_SCHEME}:${id})`
}

/**
 * Find every canonical mention in text.
 * @param text - prompt or draft text.
 * @returns mentions in text order.
 */
export function parseKnowledgeMentions(text: string): KnowledgeMention[] {
  return [...text.matchAll(MENTION)].map(match => ({
    id: match[2] as KnowledgeBaseId,
    label: match[1] as string,
    start: match.index,
    end: match.index + match[0].length,
  }))
}
