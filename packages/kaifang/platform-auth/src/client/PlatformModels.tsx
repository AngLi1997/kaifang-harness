/** Read-only list of the current account's authorized KaifangMeta models. */
import { useEffect } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import styles from './PlatformModels.module.css'

/** Model catalog snapshot shared with the footer component. */
export interface PlatformModelsState {
  loading: boolean
  error: string | null
  groups: readonly ModelProviderGroup[]
}

/** Data and actions injected by the platform-auth client plugin. */
export interface PlatformModelsInjected {
  loadCatalog: () => Promise<void>
  hooks: { catalog: SnapshotStore<PlatformModelsState> }
}

/** Props for the Models settings footer contribution. */
export type PlatformModelsProps = PropsRuntime<'settings.models.footer'>
  & PropsLocale<'kaifang.platformModels'>
  & InjectFace<PlatformModelsInjected>

/** Render the models returned by the current Peer's scoped Session catalog. */
export function PlatformModels({ useCatalog, loadCatalog, t }: PlatformModelsProps) {
  const state = useCatalog(snapshot => snapshot)
  useEffect(() => { void loadCatalog() }, [loadCatalog])

  return (
    <section className={styles['panel']} aria-busy={state.loading}>
      <header className={styles['header']}>
        <div className={styles['heading']}>
          <h3 className={styles['title']}>{t('title')}</h3>
          <p className={styles['description']}>{t('description')}</p>
        </div>
        <button
          type="button"
          className={styles['refresh']}
          disabled={state.loading}
          onClick={() => { void loadCatalog() }}
        >
          {t('refresh')}
        </button>
      </header>
      {state.groups.map(group => (
        <div key={group.id} className={styles['group']}>
          <ul className={styles['models']}>
            {group.models.map(model => (
              <li key={`${group.id}:${model.id}`} className={styles['model']}>
                <div className={styles['modelIdentity']}>
                  <span className={styles['modelName']}>{model.name}</span>
                  {model.id === model.name ? null : <code className={styles['modelId']}>{model.id}</code>}
                </div>
                {model.description === undefined ? null : (
                  <span className={styles['modelDescription']}>{model.description}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {state.loading && state.groups.length === 0
        ? (
          <ul className={styles['skeletonList']} aria-hidden="true">
            {[0, 1].map(index => (
              <li key={index} className={styles['skeletonRow']}>
                <span className={`${styles['skeletonBar']} ${styles['skeletonName']}`} />
                <span className={`${styles['skeletonBar']} ${styles['skeletonDetail']}`} />
              </li>
            ))}
          </ul>
        )
        : null}
      {state.error === null
        ? state.loading || state.groups.length > 0 ? null : <p className={styles['empty']}>{t('empty')}</p>
        : <p className={styles['error']} role="alert">{`${t('loadFailed')}: ${state.error}`}</p>}
    </section>
  )
}
