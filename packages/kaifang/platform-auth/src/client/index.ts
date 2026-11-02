/** KaifangMeta's browser contribution to the Harness Models settings page. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { isKaifangModelProvider } from '../provider-id.ts'
import { PlatformModels } from './PlatformModels.tsx'
import type { PlatformModelsState } from './PlatformModels.tsx'
import { en, zh } from './locales.ts'

const NS = 'kaifang.platformModels'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** KaifangMeta's read-only model catalog in Settings. */
    'kaifang.platformModels': keyof typeof en
  }
}

/** Required services for the Models footer and the current Peer's model catalog. */
export const inject = ['slots', 'locale', 'remote', 'remote.session']

/** Register the account-scoped platform model list under Settings → Models. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'kaifang-platform-auth: model catalog copy')
  const catalog = createSnapshotStore<PlatformModelsState>({ loading: true, error: null, groups: [] })
  let pageLoaded = false
  let pending: Promise<void> | undefined
  const loadCatalog = (): Promise<void> => {
    pageLoaded = true
    if (pending !== undefined) return pending
    catalog.update((state) => { state.loading = true; state.error = null })
    pending = (async () => {
      const response = await ctx.remote.session.modelCatalog()
      if (!response.ok) {
        catalog.update((state) => { state.loading = false; state.error = response.error.message })
        return
      }
      const groups = response.value.groups.filter(group => isKaifangModelProvider(group.id))
      const failure = response.value.failures.find(item => isKaifangModelProvider(item.id))
      catalog.update((state) => {
        state.loading = false
        state.groups = groups
        state.error = failure?.message ?? null
      })
    })().catch((error: unknown) => {
      catalog.update((state) => {
        state.loading = false
        state.error = error instanceof Error ? error.message : String(error)
      })
    }).finally(() => { pending = undefined })
    return pending
  }
  ctx.effect(() => {
    const refresh = (): void => { if (pageLoaded) void loadCatalog() }
    const disposers = [ctx.on('connection/reset', refresh)]
    return () => { for (const dispose of disposers) dispose() }
  }, 'kaifang-platform-auth: model catalog refresh')
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'kaifang-platform-models',
    order: 0,
    locale: NS,
    inject: () => ({ loadCatalog, hooks: { catalog } }),
  }, PlatformModels))
}
