import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'

const mountKnowledge = vi.fn(async () => async () => {})
vi.mock('../src/client/mount.ts', () => ({ inject: ['remote'], mountKnowledge }))
const entry = await import('../src/client/index.ts')

it('mounts the generated knowledge Remote contribution', async () => {
  const ctx = new Context()
  await entry.apply(ctx)
  expect(entry.inject).toEqual(['remote'])
  expect(mountKnowledge).toHaveBeenCalledWith(ctx, expect.objectContaining({ package: '@deepseek-ai/dsh-experimental-knowledge' }))
})
