/** Create and edit dialog: a name plus any number of Host folders. */
import { useState, type FormEvent } from 'react'
import { Button, IconCloseOutlineRegular, Input, Modal, PathLabel } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import type { KnowledgeBaseInput, KnowledgeBaseSummary } from '@deepseek-ai/dsh-experimental-knowledge/types'
import { DirectoryBrowser } from './DirectoryBrowser.tsx'
import type { DirectoryPick } from './KnowledgePage.tsx'
import type { NS } from './locales.ts'
import css from './KnowledgePage.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** Props of the editor dialog. */
export interface BaseEditorProps {
  /** Base being edited; undefined creates a new one. */
  readonly initial: KnowledgeBaseSummary | undefined
  readonly t: Translate
  readonly pickDirectory: () => Promise<DirectoryPick>
  readonly listDirectory: (path: string | undefined) => Promise<DirectoryListing>
  readonly onCancel: () => void
  /** Persist the fields; a rejection keeps the dialog open with the message. */
  readonly onSubmit: (input: KnowledgeBaseInput) => Promise<void>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Render the editor dialog.
 * @param props - initial base, copy, folder choosers, and submit callbacks.
 * @returns the modal, and the folder browser while one is open.
 */
export function BaseEditor(props: BaseEditorProps) {
  const { t, initial } = props
  const [name, setName] = useState(initial?.name ?? '')
  const [directories, setDirectories] = useState<readonly string[]>(initial?.directories ?? [])
  const [typed, setTyped] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState<DirectoryListing | null>(null)

  const add = (path: string): void => {
    const trimmed = path.trim()
    if (trimmed === '') return
    setDirectories(current => current.includes(trimmed) ? current : [...current, trimmed])
  }
  const choose = (): void => {
    setError(null)
    props.pickDirectory().then(async (pick) => {
      if (pick.kind === 'picked') add(pick.path)
      else if (pick.kind === 'browse') setBrowsing(await props.listDirectory(undefined))
    }).catch((reason: unknown) => { setError(message(reason)) })
  }
  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    setSaving(true)
    setError(null)
    props.onSubmit({ name: name.trim(), directories: [...directories] })
      .catch((reason: unknown) => { setError(message(reason)) })
      .finally(() => { setSaving(false) })
  }

  return <>
    <Modal
      open
      onClose={() => { if (!saving) props.onCancel() }}
      closeLabel={t('editor.close')}
      title={initial === undefined ? t('editor.createTitle') : t('editor.editTitle')}
      footer={<>
        <Button variant="outline" disabled={saving} onClick={props.onCancel}>{t('editor.cancel')}</Button>
        <Button variant="primary" disabled={saving || name.trim() === ''} onClick={() => { submit() }}>
          {saving ? t('editor.saving') : initial === undefined ? t('editor.create') : t('editor.save')}
        </Button>
      </>}
    >
      <form className={css.form} onSubmit={submit}>
        <label className={css.field}>
          <span className={css.label}>{t('editor.name')}</span>
          <Input
            data-modal-autofocus
            value={name}
            maxLength={64}
            placeholder={t('editor.namePlaceholder')}
            onChange={(event) => { setName(event.currentTarget.value) }}
          />
        </label>
        <div className={css.field}>
          <span className={css.label}>{t('editor.directories')}</span>
          <span className={css.muted}>{t('editor.directoriesHint')}</span>
          {directories.length === 0
            ? <span className={css.muted}>{t('editor.noDirectories')}</span>
            : (
              <ul className={css.directoryList}>
                {directories.map(path => (
                  <li key={path} className={css.directoryRow}>
                    <PathLabel path={path} />
                    <Button
                      size="sm"
                      aria-label={t('editor.removeDirectory', { path })}
                      icon={<IconCloseOutlineRegular size={16} />}
                      onClick={() => { setDirectories(current => current.filter(item => item !== path)) }}
                    />
                  </li>
                ))}
              </ul>
            )}
          <div className={css.directoryActions}>
            <Button size="sm" variant="outline" onClick={choose}>{t('editor.addDirectory')}</Button>
            <Input
              className={css.pathInput as string}
              value={typed}
              placeholder={t('editor.pathPlaceholder')}
              onChange={(event) => { setTyped(event.currentTarget.value) }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                add(typed)
                setTyped('')
              }}
            />
            <Button size="sm" disabled={typed.trim() === ''} onClick={() => { add(typed); setTyped('') }}>{t('editor.addPath')}</Button>
          </div>
        </div>
        {error !== null && <p className={css.warning} role="alert">{t('error.generic', { error })}</p>}
      </form>
    </Modal>
    {browsing !== null && (
      <DirectoryBrowser
        listing={browsing}
        t={t}
        listDirectory={props.listDirectory}
        onSelect={(path) => { add(path); setBrowsing(null) }}
        onCancel={() => { setBrowsing(null) }}
      />
    )}
  </>
}
