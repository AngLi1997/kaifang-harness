/** One knowledge base row: status, folders, actions, and the expandable file list with uploads. */
import { useRef, useState, type ChangeEvent } from 'react'
import { Button, fileSizeText, PathLabel, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { KnowledgeBaseSummary, KnowledgeFilePage, KnowledgeIndexPhase } from '@deepseek-ai/dsh-experimental-knowledge/types'
import { baseName, encodeBase64, extensionOf } from './draft.ts'
import type { NS } from './locales.ts'
import css from './KnowledgePage.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** Props of one card. */
export interface BaseCardProps {
  readonly base: KnowledgeBaseSummary
  /** Extensions the Host indexes. */
  readonly extensions: readonly string[]
  /** Largest accepted upload in bytes. */
  readonly maxUploadBytes: number
  readonly t: Translate
  readonly onAsk: () => void
  readonly onEdit: () => void
  readonly onReindex: () => void
  readonly onDelete: () => void
  readonly listFiles: () => Promise<KnowledgeFilePage>
  readonly uploadFile: (fileName: string, contentBase64: string) => Promise<void>
  readonly deleteUpload: (path: string) => Promise<void>
}

const DOT: Readonly<Record<KnowledgeIndexPhase, StateDotState>> = {
  pending: 'idle', scanning: 'ongoing', indexing: 'ongoing', embedding: 'ongoing', ready: 'done', error: 'error',
}

/**
 * Localized phase label.
 * @param base - base whose status is described.
 * @param t - knowledge dictionary.
 * @returns the phase text, including the failure for `error`.
 */
export function phaseText(base: Pick<KnowledgeBaseSummary, 'status'>, t: Translate): string {
  const { phase, error } = base.status
  return phase === 'error' ? t('phase.error', { error: error ?? '' }) : t(`phase.${phase}`)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type FilesState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly page: KnowledgeFilePage }

/**
 * Render one knowledge base.
 * @param props - base summary, limits, copy, and actions.
 * @returns the card element.
 */
export function BaseCard(props: BaseCardProps) {
  const { base, t } = props
  const { status } = base
  const [files, setFiles] = useState<FilesState>({ kind: 'closed' })
  const [busy, setBusy] = useState<string | null>(null)
  const [problems, setProblems] = useState<readonly string[]>([])
  const input = useRef<HTMLInputElement>(null)

  const loadFiles = (): void => {
    setFiles({ kind: 'loading' })
    props.listFiles().then((page) => { setFiles({ kind: 'loaded', page }) }, (error: unknown) => {
      setProblems([t('error.generic', { error: message(error) })])
      setFiles({ kind: 'closed' })
    })
  }
  const toggleFiles = (): void => {
    if (files.kind === 'closed') loadFiles()
    else setFiles({ kind: 'closed' })
  }
  const addFiles = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const chosen = [...event.currentTarget.files ?? []]
    event.currentTarget.value = ''
    const issues: string[] = []
    for (const file of chosen) {
      if (!props.extensions.includes(extensionOf(file.name))) {
        issues.push(t('files.unsupported', { name: file.name }))
        continue
      }
      if (file.size > props.maxUploadBytes) {
        issues.push(t('files.tooLarge', { name: file.name, size: fileSizeText(props.maxUploadBytes) }))
        continue
      }
      setBusy(t('files.uploading', { name: file.name }))
      try {
        await props.uploadFile(file.name, encodeBase64(new Uint8Array(await file.arrayBuffer())))
      } catch (error) {
        issues.push(t('error.generic', { error: message(error) }))
      }
    }
    setBusy(null)
    setProblems(issues)
    loadFiles()
  }
  const removeFile = (path: string): void => {
    props.deleteUpload(path).then(loadFiles, (error: unknown) => { setProblems([t('error.generic', { error: message(error) })]) })
  }

  return (
    <article className={css.card} aria-label={base.name}>
      <div className={css.cardHead}>
        <div className={css.cardTitle}>
          <h2>{base.name}</h2>
          <span className={css.phase}>
            <StateDot state={DOT[status.phase]} />
            {phaseText(base, t)}
          </span>
        </div>
        <div className={css.actions}>
          <Button variant="primary" size="sm" onClick={props.onAsk}>{t('action.ask')}</Button>
          <Button variant="outline" size="sm" aria-expanded={files.kind !== 'closed'} onClick={toggleFiles}>
            {files.kind === 'closed' ? t('action.files') : t('action.hideFiles')}
          </Button>
          <Button size="sm" onClick={props.onEdit}>{t('action.edit')}</Button>
          <Button size="sm" onClick={props.onReindex}>{t('action.reindex')}</Button>
          <Button size="sm" onClick={props.onDelete}>{t('action.delete')}</Button>
        </div>
      </div>
      <p className={css.stats}>
        {t('card.files', { indexed: status.indexedFiles, total: status.totalFiles, chunks: status.chunkCount })}
        {status.vectorCount > 0 && t('card.vectors', { vectors: status.vectorCount })}
        {status.watching && <span className={css.muted}> · {t('card.watching')}</span>}
      </p>
      <div className={css.directories}>
        <span className={css.label}>{t('card.directories')}</span>
        {base.directories.length === 0
          ? <span className={css.muted}>{t('card.noDirectories')}</span>
          : base.directories.map(path => <PathLabel key={path} path={path} />)}
      </div>
      {status.failedFiles > 0 && <p className={css.warning}>{t('card.failed', { failed: status.failedFiles })}</p>}
      {status.missingDirectories.length > 0 && (
        <p className={css.warning}>{t('card.missing', { paths: status.missingDirectories.join(', ') })}</p>
      )}
      {status.fileLimitReached && <p className={css.warning}>{t('card.limit')}</p>}
      {status.indexedAt !== undefined && (
        <p className={css.muted}>{t('card.updated', { time: new Date(status.indexedAt).toLocaleString() })}</p>
      )}
      {problems.map(problem => <p key={problem} className={css.warning} role="alert">{problem}</p>)}
      {files.kind !== 'closed' && (
        <section className={css.files} aria-label={t('files.title')}>
          <div className={css.filesHead}>
            <h3>{t('files.title')}</h3>
            <div className={css.actions}>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { input.current?.click() }}>{t('files.add')}</Button>
              <Button size="sm" disabled={files.kind === 'loading'} onClick={loadFiles}>{t('files.refresh')}</Button>
            </div>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              accept={props.extensions.join(',')}
              aria-label={t('files.add')}
              onChange={(event) => { void addFiles(event) }}
            />
          </div>
          <p className={css.muted}>{t('files.supported', { extensions: props.extensions.join(' ') })}</p>
          {busy !== null && <p className={css.muted} role="status">{busy}</p>}
          {files.kind === 'loading'
            ? <p className={css.muted} role="status">{t('files.loading')}</p>
            : files.page.files.length === 0
              ? <p className={css.muted}>{t('files.empty')}</p>
              : (
                <ul className={css.fileList}>
                  {files.page.files.map(file => (
                    <li key={file.path} className={css.fileRow}>
                      <PathLabel path={file.path} />
                      <span className={file.state === 'failed' ? css.warning : css.muted}>
                        {file.state === 'indexed'
                          ? t('files.chunks', { chunks: file.chunks })
                          : file.state === 'pending' ? t('files.pending') : t('files.failed', { error: file.error ?? '' })}
                      </span>
                      {file.uploaded && <span className={css.tag}>{t('files.uploaded')}</span>}
                      {file.uploaded && (
                        <Button size="sm" aria-label={t('files.remove', { name: baseName(file.path) })} onClick={() => { removeFile(file.path) }}>
                          {t('action.delete')}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
          {files.kind === 'loaded' && files.page.truncated && (
            <p className={css.muted}>{t('files.truncated', { count: files.page.files.length })}</p>
          )}
        </section>
      )}
    </article>
  )
}
