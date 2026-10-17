/**
 * Kaifang archive toolkit, browser half: the "Archive tools" sidebar entry,
 * the catalog it opens in the main column, the `@` trigger source whose picks
 * insert a tool reference chip, and the card pick that references a tool in
 * the shown conversation.
 *
 * The sidebar entry and the catalog share one main panel id, so the sidebar's
 * own panel button switches the main column to the catalog. A reference
 * reaches the model as its `@<tool id>` mention; the tools themselves are not
 * implemented by this package.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { ArchiveToolsIcon } from './ArchiveToolsIcon.tsx'
import { ArchiveToolsPage, type ArchiveToolsInjected } from './ArchiveToolsPage.tsx'
import { en, NS, zh, type ArchiveToolsKey } from './locales.ts'
import { createToolSource } from './reference-source.ts'
import { createToolPicker } from './tool-pick.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Archive tool catalog, sidebar entry, and `@` picker copy. */
    'kaifang.archiveTools': ArchiveToolsKey
  }
}

/** The id shared by the sidebar entry and the main panel it opens. */
const PANEL_ID = 'kaifang-archive-tools' as MainPanelId

/** Required services: slots, copy, Session lookup, composer input, panel selection, navigation, and the `@` registry. */
export const inject = ['slots', 'locale', 'sessions', 'conversation', 'layout', 'uiWorkspace', 'inputTriggers']

/**
 * Register the dictionaries, the `@` source, the catalog page, and its sidebar entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'kaifang-archive-tools: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.inputTriggers.registerSource(createToolSource(t)), 'kaifang-archive-tools: @ source')
  const picker = createToolPicker(ctx, t)
  ctx.effect(() => () => { picker.dispose() }, 'kaifang-archive-tools: composer focus')
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: (): ArchiveToolsInjected => ({ onSelectTool: (id) => { picker.pick(id) } }),
  }, ArchiveToolsPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    // Below Plugins (order 0) and above Automation tasks (order 10).
    order: 1,
    locale: NS,
    label: () => t('panel'),
  }, ArchiveToolsIcon))
}
