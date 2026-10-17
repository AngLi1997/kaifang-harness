/** In-app Host folder browser for hosts without a native chooser, such as remote Web access. */
import { useState } from 'react'
import { Button, IconFolderCloseRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import type { NS } from './locales.ts'
import css from './KnowledgePage.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** Props of the folder browser. */
export interface DirectoryBrowserProps {
  /** Level shown first. */
  readonly listing: DirectoryListing
  readonly t: Translate
  readonly listDirectory: (path: string | undefined) => Promise<DirectoryListing>
  readonly onSelect: (path: string) => void
  readonly onCancel: () => void
}

/**
 * Render one folder level with breadcrumbs, subfolders, and a choose action.
 * @param props - first listing, copy, listing callback, and outcome callbacks.
 * @returns the nested modal.
 */
export function DirectoryBrowser(props: DirectoryBrowserProps) {
  const { t } = props
  const [listing, setListing] = useState(props.listing)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = (path: string): void => {
    setLoading(true)
    setError(null)
    props.listDirectory(path).then(setListing, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setLoading(false) })
  }
  const visible = listing.entries.filter(entry => !entry.hidden)
  const parent = listing.crumbs.at(-2)
  return (
    <Modal
      open
      onClose={props.onCancel}
      closeLabel={t('browser.close')}
      title={t('browser.title')}
      onKeyDownCapture={(event) => { if (event.key === 'Escape') { event.stopPropagation(); props.onCancel() } }}
      footer={<>
        <Button variant="outline" onClick={props.onCancel}>{t('browser.cancel')}</Button>
        <Button variant="primary" disabled={loading} onClick={() => { props.onSelect(listing.path) }}>{t('browser.select')}</Button>
      </>}
    >
      <nav className={css.crumbs} aria-label={t('browser.title')}>
        {listing.crumbs.map((crumb, index) => (
          <button key={crumb.path} type="button" className={css.crumb} disabled={loading || index === listing.crumbs.length - 1}
            onClick={() => { open(crumb.path) }}>
            {crumb.name}
          </button>
        ))}
      </nav>
      {parent !== undefined && (
        <Button size="sm" disabled={loading} onClick={() => { open(parent.path) }}>{t('browser.up')}</Button>
      )}
      {error !== null && <p className={css.warning} role="alert">{t('error.generic', { error })}</p>}
      {loading
        ? <p className={css.muted} role="status">{t('browser.loading')}</p>
        : visible.length === 0
          ? <p className={css.muted}>{t('browser.empty')}</p>
          : (
            <ul className={css.browserList}>
              {visible.map(entry => (
                <li key={entry.path}>
                  <button type="button" className={css.browserRow} onClick={() => { open(entry.path) }}>
                    <IconFolderCloseRegular size={16} />
                    <span>{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      {listing.truncated && <p className={css.muted}>{t('browser.truncated')}</p>}
    </Modal>
  )
}
