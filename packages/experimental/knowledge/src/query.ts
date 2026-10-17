/**
 * Query terms for the trigram full-text index. FTS5 `trigram` matches only
 * terms of three or more characters, so a CJK run of three or more characters
 * becomes its overlapping trigrams, Latin words of three or more characters
 * stay whole, and shorter terms are matched by substring scan instead.
 */

const CJK = /[㐀-鿿豈-﫿]/u
const TOKEN = /[\p{L}\p{N}_]+/gu

/** Terms of one query, split by the matching strategy each needs. */
export interface QueryTerms {
  /** Terms of three or more characters matched through the FTS5 index. */
  readonly indexed: readonly string[]
  /** One- and two-character terms matched by substring scan. */
  readonly short: readonly string[]
}

/** Split a token into runs of CJK and non-CJK characters. */
function runs(token: string): string[] {
  const result: string[] = []
  let current = ''
  let cjk: boolean | undefined
  for (const char of token) {
    const isCjk = CJK.test(char)
    if (cjk !== undefined && isCjk !== cjk) {
      result.push(current)
      current = ''
    }
    cjk = isCjk
    current += char
  }
  result.push(current)
  return result
}

/**
 * Derive bounded, de-duplicated query terms.
 * @param query - user or model query text.
 * @param maxTerms - upper bound on indexed plus short terms.
 * @returns indexed and short terms in query order.
 */
export function queryTerms(query: string, maxTerms: number): QueryTerms {
  const indexed = new Set<string>()
  const short = new Set<string>()
  for (const match of query.toLowerCase().matchAll(TOKEN)) {
    for (const run of runs(match[0])) {
      const chars = Array.from(run)
      if (chars.length < 3) {
        short.add(run)
      } else if (CJK.test(chars[0] as string)) {
        for (let index = 0; index + 3 <= chars.length; index += 1) indexed.add(chars.slice(index, index + 3).join(''))
      } else {
        indexed.add(run)
      }
    }
  }
  const indexedTerms = [...indexed].slice(0, maxTerms)
  return { indexed: indexedTerms, short: [...short].slice(0, Math.max(0, maxTerms - indexedTerms.length)) }
}

/**
 * Render indexed terms as one FTS5 OR expression of quoted strings.
 * @param terms - indexed terms.
 * @returns the MATCH expression, or undefined when there are no terms.
 */
export function matchExpression(terms: readonly string[]): string | undefined {
  if (terms.length === 0) return undefined
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
}

/**
 * Escape a term for a `LIKE ... ESCAPE '\'` substring pattern.
 * @param term - short term.
 * @returns the `%term%` pattern.
 */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/gu, char => `\\${char}`)}%`
}
