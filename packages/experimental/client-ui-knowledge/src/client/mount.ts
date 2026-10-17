/** Lifecycle of the knowledge Remote and every browser contribution of this plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-experimental-knowledge/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { observeCatalog } from './catalog.ts'
import { knowledgeDraft } from './draft.ts'
import { KnowledgeIcon } from './KnowledgeIcon.tsx'
import { KnowledgeMention, type KnowledgeMentionInjected } from './KnowledgeMention.tsx'
import { KnowledgePage, type DirectoryPick, type KnowledgePageInjected } from './KnowledgePage.tsx'
import { en, NS, zh } from './locales.ts'
import { createMentionSource } from './mention-source.ts'
import { knowledgeMentionRule } from './user-text-rule.ts'

/** Main panel id of the knowledge base page. */
const PANEL_ID = 'knowledge' as MainPanelId

/** Sidebar position: directly below Archive tools (1) and above Automation tasks (10). */
const PANEL_ORDER = 2

/** Services the browser contributions read. */
export const inject = [
  'remote', 'slots', 'locale', 'inputTriggers', 'uiWorkspace', 'uiConversation', 'layout',
]

/** Unwrap a Remote result into its value, throwing its error. */
function unwrap<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error }): T {
  if (!result.ok) throw result.error
  return result.value
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-knowledge: dictionaries')
  const t = ctx.locale.bind(NS)
  const catalog = observeCatalog(ctx)
  ctx.effect(() => catalog.dispose, 'client-ui-knowledge: catalog observation')

  const pickDirectory = async (): Promise<DirectoryPick> => {
    const result = await ctx.remote.directoryPicker.pick()
    if (result.ok) return result.value === null ? { kind: 'cancelled' } : { kind: 'picked', path: result.value }
    if (result.error.code === 'directory-picker/unavailable') return { kind: 'browse' }
    throw result.error
  }
  const page: KnowledgePageInjected = {
    hooks: { knowledgeCatalog: catalog.state },
    create: async (input) => { unwrap(await ctx.remote.knowledge.create(input)) },
    update: async (update) => { unwrap(await ctx.remote.knowledge.update(update)) },
    remove: async (id) => { unwrap(await ctx.remote.knowledge.delete(id)) },
    reindex: async (id) => { unwrap(await ctx.remote.knowledge.reindex(id)) },
    listFiles: async id => unwrap(await ctx.remote.knowledge.files(id)),
    uploadFile: async (id, fileName, contentBase64) => {
      unwrap(await ctx.remote.knowledge.upload({ id, fileName, contentBase64 }))
    },
    deleteUpload: async (id, path) => { unwrap(await ctx.remote.knowledge.deleteUpload(id, path)) },
    pickDirectory,
    listDirectory: async path => unwrap(await ctx.remote.directoryPicker.list(path)),
    ask: (mention: string, name: string) => {
      ctx.uiWorkspace.startSession(undefined, { prompt: knowledgeDraft(mention, name, t('ask.prompt')), clearPreviousDraft: true })
    },
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS, inject: () => page,
  }, KnowledgePage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, locale: NS, label: () => t('panel'),
  }, KnowledgeIcon))

  const source = createMentionSource(async (query, signal) => unwrap(await ctx.remote.knowledge.candidates(query, signal)), t)
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => inputTriggers.registerSource(source), 'client-ui-knowledge: @ source')

  ctx.effect(() => ctx.uiConversation.userText.register(knowledgeMentionRule), 'client-ui-knowledge: mention rule')
  const mention: KnowledgeMentionInjected = { openPage: () => { ctx.layout.selectPanel(PANEL_ID) } }
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'knowledge', priority: 100, inject: () => mention,
  }, KnowledgeMention))
}

/**
 * Mount the experimental `knowledge` namespace, then register the browser contributions.
 * @param ctx - Client runtime.
 * @param contribution - generated knowledge Remote definitions.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function mountKnowledge(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.knowledge', 'remote.directoryPicker', 'slots', 'locale', 'inputTriggers', 'uiWorkspace', 'uiConversation', 'layout'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
