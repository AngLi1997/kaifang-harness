/** Platform IAM sign-in page covering the Web workspace while the Host is unauthenticated. */
import { Button, KaifangLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  KaifangConnection, KaifangConnectionInvalid, KaifangPasswordResult, KaifangWebState,
} from './kaifang-web.ts'
import { OnboardingSurface } from './OnboardingSurface.tsx'
import css from './KaifangWebSignIn.module.css'

/** Session view and operations supplied by the account plugin. */
export interface KaifangWebSignInInjected {
  hooks: { kaifang: HostObservable<KaifangWebState> }
  connection: () => KaifangConnection
  saveConnection: (value: KaifangConnection) => { ok: true } | { ok: false; reason: KaifangConnectionInvalid | 'write-failed' }
  passwordSignIn: (credentials: { username: string; password: string }) => Promise<KaifangPasswordResult>
  startBrowserSignIn: () => void
  cancelBrowserSignIn: () => void
}

/** Show the platform account sign-in state before revealing the shared DSH workspace. */
export function KaifangWebSignIn({ useKaifang, startBrowserSignIn, cancelBrowserSignIn, t }:
  PropsRuntime<'shell.overlay'> & PropsLocale<'settings.account'> & InjectFace<KaifangWebSignInInjected>) {
  const state = useKaifang(value => value)
  if (state.account !== null) return null
  const waiting = state.browser.phase === 'waiting' || state.browser.phase === 'completing'
  return <OnboardingSurface>
    <section className={css.page} aria-labelledby="kaifang-sign-in-title">
      <header className={css.brand}><KaifangLogo size={40} /></header>
      <h1 id="kaifang-sign-in-title" className={css.title}>
        {waiting ? t('kaifangWaitingTitle') : t('kaifangSignInTitle')}
      </h1>
      <p className={css.description} role={state.browser.phase === 'failed' ? 'alert' : undefined}>
        {waiting ? <>{t('kaifangWaitingDescription')}<a className={css.link} href={state.browser.phase === 'waiting' ? state.browser.url : undefined}
          target="_blank" rel="noopener">{t('kaifangOpenPage')}</a></>
          : state.browser.phase === 'failed' ? t('kaifangBrowserFailed') : t('kaifangSignInDescription')}
      </p>
      <div className={css.actions}>
        {waiting
          ? <Button variant="outline" className={css.action} onClick={cancelBrowserSignIn}>{t('cancel')}</Button>
          : <Button variant="primary" className={css.action} onClick={startBrowserSignIn}>{t('kaifangBrowserSignIn')}</Button>}
      </div>
    </section>
  </OnboardingSurface>
}
