/** One reconnecting mirror of the Host knowledge catalog shared by every page occurrence. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { KnowledgeCatalog } from '@deepseek-ai/dsh-experimental-knowledge/types'
import type {} from '@deepseek-ai/dsh-experimental-knowledge/remote'

/** Latest Host catalog and the transport state of its observation. */
export interface KnowledgeCatalogState {
  /** Latest complete catalog; null before the first snapshot. */
  readonly catalog: KnowledgeCatalog | null
  /** Whether the observation stream is delivering snapshots. */
  readonly connected: boolean
  /** Latest transport failure; null while connected. */
  readonly error: string | null
}

/**
 * Follow the Host catalog for the plugin lifetime, independent of rendered pages.
 * @param ctx - Client context owning the mounted `knowledge` Remote.
 * @returns the shared snapshot store and a disposer that ends the observation.
 */
export function observeCatalog(ctx: Context): { state: SnapshotStore<KnowledgeCatalogState>; dispose: () => Promise<void> } {
  const state = createSnapshotStore<KnowledgeCatalogState>({ catalog: null, connected: false, error: null })
  let disposed = false
  const isDisposed = (): boolean => disposed
  const fail = (error: unknown): void => {
    state.set({ ...state.getSnapshot(), connected: false, error: error instanceof Error ? error.message : String(error) })
  }
  const stream = ctx.remote.$stream<KnowledgeCatalog>({
    name: 'Knowledge catalog', open: signal => ctx.remote.knowledge.follow(signal),
    ended: () => new RemoteStreamCarrierError('Knowledge catalog stream ended'), carrierFailed: fail,
  })
  const observing = (async () => {
    try {
      for await (const item of stream) {
        state.set({ catalog: item.value, connected: true, error: null })
        item.accept()
      }
    } catch (error) {
      if (!isDisposed()) fail(error)
    }
  })()
  return { state, dispose: async () => { disposed = true; await stream.dispose(); await observing } }
}
