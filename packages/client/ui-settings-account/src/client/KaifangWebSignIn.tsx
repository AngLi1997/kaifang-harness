/** Plain-browser KaifangLab sign-in page covering the workspace while no account is signed in. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, Input, KaifangLogo, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { KaifangConnection, KaifangConnectionInvalid, KaifangPasswordResult, KaifangWebState } from './kaifang-web.ts'
import type { AccountKey } from './locales.ts'
import { OnboardingSurface } from './OnboardingSurface.tsx'
import css from './KaifangWebSignIn.module.css'

/** Session state and sign-in operations supplied by the account plugin. */
export interface KaifangWebSignInInjected {
  hooks: { kaifang: HostObservable<KaifangWebState> }
  /** @returns the saved connection, or its defaults. */
  connection: () => KaifangConnection
  /** @param value - form input. @returns the field rule failure, a write failure, or success. */
  saveConnection: (value: KaifangConnection) => { ok: true } | { ok: false; reason: KaifangConnectionInvalid | 'write-failed' }
  /** @param credentials - form input. @returns the sign-in outcome. */
  passwordSignIn: (credentials: { username: string; password: string }) => Promise<KaifangPasswordResult>
  /** Open the KaifangLab authorization page in a new tab. */
  startBrowserSignIn: () => void
  /** Forget the pending browser attempt. */
  cancelBrowserSignIn: () => void
}

type Page = 'entry' | 'password' | 'settings'
type SettingsField = 'url' | 'web' | 'code' | 'form'
type PasswordField = 'username' | 'password' | 'form'

const SETTINGS_ERRORS: Record<KaifangConnectionInvalid | 'write-failed', { field: SettingsField; key: AccountKey }> = {
  'url-required': { field: 'url', key: 'kaifangSystemUrlRequired' },
  'url-invalid': { field: 'url', key: 'kaifangUrlInvalid' },
  'web-url-required': { field: 'web', key: 'kaifangWebUrlRequired' },
  'web-url-invalid': { field: 'web', key: 'kaifangUrlInvalid' },
  'auth-code-required': { field: 'code', key: 'kaifangAuthCodeRequired' },
  'write-failed': { field: 'form', key: 'kaifangSettingsFailed' },
}

const PASSWORD_ERRORS: Record<Extract<KaifangPasswordResult, { ok: false }>['reason'], { field: PasswordField; key: AccountKey }> = {
  'username-required': { field: 'username', key: 'kaifangUsernameRequired' },
  'password-required': { field: 'password', key: 'kaifangPasswordRequired' },
  'invalid-credentials': { field: 'form', key: 'kaifangPasswordInvalid' },
  unreachable: { field: 'form', key: 'kaifangPasswordUnreachable' },
  failed: { field: 'form', key: 'kaifangPasswordFailed' },
}

/**
 * Offer browser (one-click) and password sign-in, plus the system settings both use.
 * @param props - shell overlay bindings, session state, and sign-in operations.
 * @returns the covering sign-in page while signed out, otherwise nothing.
 */
export function KaifangWebSignIn({ useKaifang, connection, saveConnection, passwordSignIn, startBrowserSignIn, cancelBrowserSignIn, t }:
  PropsRuntime<'shell.overlay'> & PropsLocale<'settings.account'> & InjectFace<KaifangWebSignInInjected>) {
  const state = useKaifang(value => value)
  const [page, setPage] = useState<Page>('entry')
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordError, setPasswordError] = useState<{ field: PasswordField; key: AccountKey } | null>(null)
  const [settings, setSettings] = useState<KaifangConnection>(connection)
  const [settingsError, setSettingsError] = useState<{ field: SettingsField; key: AccountKey } | null>(null)
  const [savedNotice, setSavedNotice] = useState(false)
  const usernameInput = useRef<HTMLInputElement>(null)
  const urlInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (page === 'password') usernameInput.current?.focus()
    else if (page === 'settings') urlInput.current?.focus()
  }, [page])
  const signedIn = state.account !== null
  useEffect(() => {
    if (!signedIn) return
    // The page stays mounted while signed in; a later sign-out starts again from the choices.
    setPage('entry')
    setPassword('')
    setPasswordError(null)
    setSavedNotice(false)
  }, [signedIn])
  if (signedIn) return null
  const browser = state.browser
  const openPassword = () => { setPasswordError(null); setPage('password') }
  const openSettings = () => { cancelBrowserSignIn(); setSettings(connection()); setSettingsError(null); setPage('settings') }
  const submitPassword = async (event: FormEvent) => {
    event.preventDefault()
    // A second submit before the busy state renders must not start another request.
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setPasswordError(null)
    try {
      const result = await passwordSignIn({ username, password })
      if (!result.ok) setPasswordError(PASSWORD_ERRORS[result.reason])
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  const submitSettings = (event: FormEvent) => {
    event.preventDefault()
    const result = saveConnection(settings)
    if (!result.ok) { setSettingsError(SETTINGS_ERRORS[result.reason]); return }
    setSettingsError(null)
    setSavedNotice(true)
    setPage('entry')
  }
  const field = (id: string, label: AccountKey, input: ReactNode, error: AccountKey | undefined) => <div className={css.field}>
    <label className={css.label} htmlFor={id}>{t(label)}<span className={css.required} aria-hidden="true">*</span></label>
    {input}
    {error !== undefined && <span id={`${id}-error`} className={css.error} role="alert">{t(error)}</span>}
  </div>
  return <OnboardingSurface>
    {savedNotice && <Toast text={t('kaifangSettingsSaved')} onDone={() => { setSavedNotice(false) }} />}
    <section className={css.page} aria-labelledby="kaifang-sign-in-title">
      <header className={css.brand}>
        <KaifangLogo size={40} />
        {page === 'entry' && <button type="button" className={css.settings} onClick={openSettings}>{t('kaifangSettings')}</button>}
      </header>
      {page === 'entry' && <>
        <h1 id="kaifang-sign-in-title" className={css.title}>
          {browser.phase === 'waiting' ? t('kaifangWaitingTitle') : browser.phase === 'completing' ? t('kaifangCompleting') : t('kaifangSignInTitle')}
        </h1>
        {browser.phase === 'waiting'
          ? <p className={css.description}>{t('kaifangWaitingDescription')}
            <a className={css.link} href={browser.url} target="_blank" rel="noopener">{t('kaifangOpenPage')}</a></p>
          : <p className={css.description} role={browser.phase === 'failed' ? 'alert' : undefined}>
            {browser.phase === 'failed' ? t('kaifangBrowserFailed') : t('kaifangSignInDescription')}</p>}
        <div className={css.actions}>
          {browser.phase === 'waiting' || browser.phase === 'completing'
            ? <Button variant="outline" className={css.action} disabled={browser.phase === 'completing'} onClick={cancelBrowserSignIn}>{t('cancel')}</Button>
            : <>
              <Button variant="primary" className={css.action} onClick={startBrowserSignIn}>{t('kaifangBrowserSignIn')}</Button>
              <Button variant="outline" className={css.action} onClick={openPassword}>{t('kaifangPasswordSignIn')}</Button>
            </>}
        </div>
      </>}
      {page === 'password' && <form className={css.form} onSubmit={(event) => { void submitPassword(event) }} noValidate>
        <h1 id="kaifang-sign-in-title" className={css.title}>{t('kaifangPasswordTitle')}</h1>
        <p className={css.description}>{t('kaifangPasswordDescription')}</p>
        {field('kaifang-username', 'kaifangUsername', <Input ref={usernameInput} id="kaifang-username" autoComplete="username" value={username}
          placeholder={t('kaifangUsernamePlaceholder')} aria-invalid={passwordError?.field === 'username'}
          onChange={(event) => { setUsername(event.target.value) }} />, passwordError?.field === 'username' ? passwordError.key : undefined)}
        {field('kaifang-password', 'kaifangPassword', <Input id="kaifang-password" type="password" autoComplete="current-password" value={password}
          placeholder={t('kaifangPasswordPlaceholder')} aria-invalid={passwordError !== null && passwordError.field !== 'username'}
          onChange={(event) => { setPassword(event.target.value) }} />,
        passwordError !== null && passwordError.field !== 'username' ? passwordError.key : undefined)}
        <div className={css.actions}>
          <Button variant="primary" className={css.action} type="submit" disabled={busy}>{t('kaifangPasswordSubmit')}</Button>
          <Button variant="outline" className={css.action} disabled={busy} onClick={() => { setPage('entry') }}>{t('kaifangBack')}</Button>
        </div>
      </form>}
      {page === 'settings' && <form className={css.form} onSubmit={submitSettings} noValidate>
        <h1 id="kaifang-sign-in-title" className={css.title}>{t('kaifangSettingsTitle')}</h1>
        <p className={css.description}>{t('kaifangSettingsDescription')}</p>
        {field('kaifang-system-url', 'kaifangSystemUrl', <Input ref={urlInput} id="kaifang-system-url" value={settings.systemUrl}
          placeholder={t('kaifangSystemUrlPlaceholder')} aria-invalid={settingsError?.field === 'url'}
          onChange={(event) => { setSettings({ ...settings, systemUrl: event.target.value }) }} />,
        settingsError?.field === 'url' ? settingsError.key : undefined)}
        {field('kaifang-web-url', 'kaifangWebUrl', <Input id="kaifang-web-url" value={settings.webUrl}
          placeholder={t('kaifangWebUrlPlaceholder')} aria-invalid={settingsError?.field === 'web'}
          onChange={(event) => { setSettings({ ...settings, webUrl: event.target.value }) }} />,
        settingsError?.field === 'web' ? settingsError.key : undefined)}
        {field('kaifang-auth-code', 'kaifangAuthCode', <Input id="kaifang-auth-code" value={settings.authCode}
          placeholder={t('kaifangAuthCodePlaceholder')} aria-invalid={settingsError?.field === 'code'}
          onChange={(event) => { setSettings({ ...settings, authCode: event.target.value }) }} />,
        settingsError?.field === 'code' || settingsError?.field === 'form' ? settingsError.key : undefined)}
        <div className={css.actions}>
          <Button variant="primary" className={css.action} type="submit">{t('kaifangSettingsSave')}</Button>
          <Button variant="outline" className={css.action} onClick={() => { setPage('entry') }}>{t('kaifangBack')}</Button>
        </div>
      </form>}
    </section>
  </OnboardingSurface>
}
