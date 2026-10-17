/** A non-Error extraction failure is recorded as text on the file. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { expect, it, vi } from 'vitest'

vi.mock('../src/extract.ts', () => ({
  // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error extraction failure is the scenario.
  extractText: () => Promise.reject('unreadable'),
}))
const { default: KnowledgeRuntime } = await import('../src/index.ts')

it('stores the string form of a thrown value', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-knowledge-extract-'))
  const docs = await mkdtemp(join(tmpdir(), 'dsh-knowledge-extract-docs-'))
  await writeFile(join(docs, 'a.md'), 'a')
  const ctx = new Context()
  try {
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(KnowledgeRuntime, KnowledgeRuntime.Config({ dataRoot, watch: false }))
    const base = await ctx.knowledge.create({ name: 'a', directories: [docs] })
    await expect.poll(() => ctx.knowledge.list()[0]?.status.phase).toBe('ready')
    expect((await ctx.knowledge.files(base.id)).files).toMatchObject([{ state: 'failed', error: 'unreadable' }])
  } finally {
    await ctx.fiber.dispose()
    await rm(dataRoot, { recursive: true, force: true })
    await rm(docs, { recursive: true, force: true })
  }
})
