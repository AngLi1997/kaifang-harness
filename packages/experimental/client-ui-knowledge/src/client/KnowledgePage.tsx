/** First-level page listing local knowledge bases with create, edit, delete, file, and ask actions. */
import { useState } from 'react'
import { Button, IconPlusOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import type {
  KnowledgeBaseId, KnowledgeBaseInput, KnowledgeBaseSummary, KnowledgeBaseUpdate, KnowledgeFilePage,
} from '@deepseek-ai/dsh-experimental-knowledge/types'
import { BaseCard } from './BaseCard.tsx'
import { BaseEditor } from './BaseEditor.tsx'
import type { KnowledgeCatalogState } from './catalog.ts'
import type { NS } from './locales.ts'
import css from './KnowledgePage.module.css'

/** Outcome of the native directory chooser. */
export type DirectoryPick =
  | { readonly kind: 'picked'; readonly path: string }
  | { readonly kind: 'cancelled' }
  /** The Host serves an in-app browser instead of an OS chooser. */
  | { readonly kind: 'browse' }

/** Host operations and the catalog mirror injected into the page. */
export interface KnowledgePageInjected {
  /** Shared catalog mirror. */
  readonly hooks: { readonly knowledgeCatalog: HostObservable<KnowledgeCatalogState> }
  /** Create a base; rejects with the Host's message. */
  readonly create: (input: KnowledgeBaseInput) => Promise<void>
  /** Rename a base or replace its folders; rejects with the Host's message. */
  readonly update: (update: KnowledgeBaseUpdate) => Promise<void>
  /** Delete a base; rejects with the Host's message. */
  readonly remove: (id: KnowledgeBaseId) => Promise<void>
  /** Re-scan a base now. */
  readonly reindex: (id: KnowledgeBaseId) => Promise<void>
  /** Read a base's indexed files. */
  readonly listFiles: (id: KnowledgeBaseId) => Promise<KnowledgeFilePage>
  /** Copy one file into a base's upload folder. */
  readonly uploadFile: (id: KnowledgeBaseId, fileName: string, contentBase64: string) => Promise<void>
  /** Delete one added file. */
  readonly deleteUpload: (id: KnowledgeBaseId, path: string) => Promise<void>
  /** Run the Host's native folder chooser, or report that the Host serves an in-app browser. */
  readonly pickDirectory: () => Promise<DirectoryPick>
  /** List one Host folder level for the in-app browser; undefined lists the home folder. */
  readonly listDirectory: (path: string | undefined) => Promise<DirectoryListing>
  /** Open a conversation whose draft starts with the base's mention. */
  readonly ask: (mention: string, name: string) => void
}

/** Root-scoped page props. */
export type KnowledgePageProps = PropsRuntime<'main'> & InjectFace<KnowledgePageInjected> & PropsLocale<typeof NS>

type EditorState = { readonly mode: 'create' } | { readonly mode: 'edit'; readonly base: KnowledgeBaseSummary }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Render every knowledge base and the dialogs that change them.
 * @param props - catalog hook, Host operations, and locale seat.
 * @returns the page.
 */
export function KnowledgePage(props: KnowledgePageProps) {
  const { useKnowledgeCatalog, t } = props
  const { catalog, error: transportError } = useKnowledgeCatalog(snapshot => snapshot)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [deleting, setDeleting] = useState<KnowledgeBaseSummary | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const run = (work: () => Promise<void>): void => {
    setFailure(null)
    void work().catch((error: unknown) => { setFailure(message(error)) })
  }
  const confirmDelete = (base: KnowledgeBaseSummary): void => {
    setDeleteBusy(true)
    props.remove(base.id).then(() => { setDeleting(null) }, (error: unknown) => { setFailure(message(error)); setDeleting(null) })
      .finally(() => { setDeleteBusy(false) })
  }

  return (
    <div className={css.page}>
      <div className={css.pageScroll}>
        <div className={css.pageContent}>
          <header className={css.pageHeading}>
            <h1>{t('title')}</h1>
            <Button variant="primary" className={css.newButton} icon={<IconPlusOutlineRegular size={16} />}
              onClick={() => { setEditor({ mode: 'create' }) }}>
              {t('new')}
            </Button>
          </header>
          {catalog !== null && (
            <p className={css.retrieval}>
              {catalog.retrieval === 'bm25' ? t('retrieval.bm25') : t('retrieval.hybrid', { embedder: catalog.embedder })}
            </p>
          )}
          {failure !== null && (
            <div className={css.notice} role="alert">
              <span>{t('error.generic', { error: failure })}</span>
              <Button size="sm" onClick={() => { setFailure(null) }}>{t('error.dismiss')}</Button>
            </div>
          )}
          {catalog === null
            ? <p className={css.muted} role="status">{transportError === null ? t('loading') : t('disconnected', { error: transportError })}</p>
            : catalog.bases.length === 0
              ? (
                <div className={css.empty}>
                  <h2>{t('empty.title')}</h2>
                  <p>{t('empty.body')}</p>
                </div>
              )
              : (
                <ul className={css.list}>
                  {catalog.bases.map(base => (
                    <li key={base.id}>
                      <BaseCard
                        base={base}
                        extensions={catalog.extensions}
                        maxUploadBytes={catalog.maxUploadBytes}
                        t={t}
                        onAsk={() => { props.ask(base.mention, base.name) }}
                        onEdit={() => { setEditor({ mode: 'edit', base }) }}
                        onReindex={() => { run(() => props.reindex(base.id)) }}
                        onDelete={() => { setDeleting(base) }}
                        listFiles={() => props.listFiles(base.id)}
                        uploadFile={(fileName, content) => props.uploadFile(base.id, fileName, content)}
                        deleteUpload={path => props.deleteUpload(base.id, path)}
                      />
                    </li>
                  ))}
                </ul>
              )}
        </div>
      </div>
      {editor !== null && (
        <BaseEditor
          initial={editor.mode === 'edit' ? editor.base : undefined}
          t={t}
          pickDirectory={props.pickDirectory}
          listDirectory={props.listDirectory}
          onCancel={() => { setEditor(null) }}
          onSubmit={async (input) => {
            if (editor.mode === 'edit') await props.update({ id: editor.base.id, ...input })
            else await props.create(input)
            setEditor(null)
          }}
        />
      )}
      {deleting !== null && (
        <Modal
          open
          onClose={() => { if (!deleteBusy) setDeleting(null) }}
          closeLabel={t('delete.close')}
          title={t('delete.title', { name: deleting.name })}
          description={t('delete.body')}
          footer={<>
            <Button variant="outline" disabled={deleteBusy} onClick={() => { setDeleting(null) }}>{t('delete.cancel')}</Button>
            <Button variant="primary" disabled={deleteBusy} onClick={() => { confirmDelete(deleting) }}>{t('delete.confirm')}</Button>
          </>}
        />
      )}
    </div>
  )
}
