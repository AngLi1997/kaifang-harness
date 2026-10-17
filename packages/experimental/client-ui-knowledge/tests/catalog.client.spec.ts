import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import type { KnowledgeCatalog } from '@deepseek-ai/dsh-experimental-knowledge/types'
import { observeCatalog } from '../src/client/catalog.ts'

const catalog: KnowledgeCatalog = { bases: [], retrieval: 'bm25', maxUploadBytes: 1, extensions: [] }

function fakeContext(items: () => AsyncIterable<{ value: KnowledgeCatalog; accept: () => void }>) {
  const ctx = new Context()
  const dispose = vi.fn(async () => {})
  let options!: { open: (signal: AbortSignal) => unknown; ended: () => Error; carrierFailed: (error: unknown) => void }
  const follow = vi.fn()
  ctx.provide('remote', {
    $stream: (given: typeof options) => { options = given; return Object.assign(items(), { dispose }) },
    knowledge: { follow },
  })
  return { ctx, dispose, follow, options: () => options }
}

it('mirrors catalog snapshots, records carrier failures, and ends on disposal', async () => {
  const accept = vi.fn()
  const f = fakeContext(async function* () { yield { value: catalog, accept } })
  const observed = observeCatalog(f.ctx)
  await vi.waitFor(() => { expect(observed.state.getSnapshot()).toEqual({ catalog, connected: true, error: null }) })
  expect(accept).toHaveBeenCalledOnce()
  f.options().open(new AbortController().signal)
  expect(f.follow).toHaveBeenCalled()
  expect(f.options().ended().message).toBe('Knowledge catalog stream ended')
  f.options().carrierFailed('reset')
  expect(observed.state.getSnapshot()).toMatchObject({ connected: false, error: 'reset' })
  await observed.dispose()
  expect(f.dispose).toHaveBeenCalledOnce()
})

it('records a stream failure unless the observation was disposed', async () => {
  const failing = fakeContext(async function* () { throw new Error('closed') })
  const observed = observeCatalog(failing.ctx)
  await vi.waitFor(() => { expect(observed.state.getSnapshot()).toMatchObject({ connected: false, error: 'closed' }) })
  await observed.dispose()
  let fail!: (error: Error) => void
  const late = fakeContext(async function* () { await new Promise<never>((_resolve, reject) => { fail = reject }) })
  const disposed = observeCatalog(late.ctx)
  const done = disposed.dispose()
  fail(new Error('after dispose'))
  await done
  expect(disposed.state.getSnapshot()).toEqual({ catalog: null, connected: false, error: null })
})
