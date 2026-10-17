/**
 * Reciprocal-rank fusion. BM25 scores, substring counts, and cosine
 * similarities are not comparable, so each ranked list contributes
 * `1 / (k + rank)` per item and the sums decide the final order.
 */

import type { KnowledgeMatchSignal } from './types.ts'

/** One ranked list of item keys, best first. */
export interface RankedList {
  /** Signal reported for items in this list. */
  readonly signal: KnowledgeMatchSignal
  /** Item keys in rank order. */
  readonly keys: readonly string[]
}

/** One fused item. */
export interface FusedItem {
  /** Item key. */
  readonly key: string
  /** Summed reciprocal-rank score. */
  readonly score: number
  /** Signals whose lists contained the item, in first-contribution order. */
  readonly signals: KnowledgeMatchSignal[]
}

/**
 * Fuse ranked lists.
 * @param lists - ranked lists; a key repeated within one list counts at its first rank.
 * @param k - rank damping constant.
 * @returns items by descending score, ties by first appearance.
 */
export function fuseRanks(lists: readonly RankedList[], k: number): FusedItem[] {
  const items = new Map<string, { score: number; signals: KnowledgeMatchSignal[]; order: number }>()
  for (const list of lists) {
    const seen = new Set<string>()
    for (const [rank, key] of list.keys.entries()) {
      if (seen.has(key)) continue
      seen.add(key)
      const item = items.get(key) ?? { score: 0, signals: [], order: items.size }
      item.score += 1 / (k + rank + 1)
      if (!item.signals.includes(list.signal)) item.signals.push(list.signal)
      items.set(key, item)
    }
  }
  return [...items.entries()]
    .sort(([, left], [, right]) => right.score - left.score || left.order - right.order)
    .map(([key, item]) => ({ key, score: item.score, signals: item.signals }))
}
