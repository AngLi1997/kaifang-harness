/** Browser entry for the knowledge base page, `@` source, and mention chips. */
import type { Context } from '@deepseek-ai/cordis'
import knowledgeRemote from '@deepseek-ai/dsh-experimental-knowledge/remote'
import { mountKnowledge } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Activate the knowledge base browser contributions.
 * @param ctx - Client runtime.
 * @returns complete UI and Remote disposer.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountKnowledge(ctx, knowledgeRemote)
}
