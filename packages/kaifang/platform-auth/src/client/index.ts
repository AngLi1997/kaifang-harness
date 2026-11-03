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
  let redirecting = false
  const checkLogin = async (): Promise<void> => {
    if (redirecting) return
    // Desktop owns platform admission (local Host or shared-Host device ticket).
    // Never bounce the native shell into the Host browser IAM entry page.
    const transport = (globalThis as { __DSH_TRANSPORT__?: { ownsHost?: boolean } }).__DSH_TRANSPORT__
    if (transport?.ownsHost === true) return
    if ((globalThis as { dshDesktopBoot?: unknown }).dshDesktopBoot !== undefined) return
    try {
      const response = await fetch('/kaifang/auth/status', { headers: { accept: 'application/json' } })
      if (!response.ok) return
      const status: unknown = await response.json()
      if (typeof status !== 'object' || status === null || !('configured' in status) || !('account' in status)) return
      if (status.configured === true && status.account === null) {
        redirecting = true
        window.location.replace('/kaifang/auth/entry')
      }
    } catch (_unavailable) {
      // A transient Host failure is retried when the client connection resets.
    }
  }
  void checkLogin()
  ctx.effect(() => ctx.on('connection/reset', () => { void checkLogin() }), 'kaifang-platform-auth: login redirect')
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
  // Desktop Remote Client: warm the shared-Host platform catalog without waiting for Settings.
  {
    const transport = (globalThis as { __DSH_TRANSPORT__?: { ownsHost?: boolean } }).__DSH_TRANSPORT__
    if ((globalThis as { dshDesktopBoot?: unknown }).dshDesktopBoot !== undefined && transport?.ownsHost === false) {
      void loadCatalog()
      ctx.effect(() => ctx.on('connection/reset', () => { void loadCatalog() }), 'kaifang-platform-auth: desktop shared catalog')
    }
  }
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'kaifang-platform-models',
    order: 0,
    locale: NS,
    inject: () => ({ loadCatalog, hooks: { catalog } }),
  }, PlatformModels))
}
