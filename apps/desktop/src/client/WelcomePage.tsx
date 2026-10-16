/** Desktop welcome presentation; account and credential operations stay in the preload. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives/src/Toast.tsx'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import type { PasswordSignInResult, SystemConnectionSaveResult, WelcomeApi } from '../welcome-api.ts'

type Page = 'entry' | 'account' | 'settings' | 'password'

/**
 * Render the standalone welcome flow using shell-owned operations and localized copy.
 * Clearing the account attempt returns the sign-in status page to the initial choices.
 * @param props.api - isolated preload API; no account credentials reach the renderer.
 * @returns welcome pages with fixed bottom actions.
 */
export function Welcome({ api }: { api: WelcomeApi }) {
  const { messages: m } = api
  const [expiryNotice, setExpiryNotice] = useState(false)
  const [page, setPage] = useState<Page>('entry')
  const pageRef = useRef<Page>('entry')
  const visiblePage = useRef<Page>('entry')
  const [attempt, setAttempt] = useState<AccountView['attempt']>(null)
  const attemptRef = useRef<AccountView['attempt']>(null)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState<{ status: 'idle' | 'busy' | 'copied' | 'failed' }>({ status: 'idle' })
  const copyState = copyFeedback.status
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const revision = useRef(0)
  const [systemUrl, setSystemUrl] = useState('')
  const [webUrl, setWebUrl] = useState('')
  const [authCode, setAuthCode] = useState('')
  const [settingsError, setSettingsError] = useState<{ field: 'url' | 'web' | 'code' | 'form'; text: string } | null>(null)
  const [savedNotice, setSavedNotice] = useState(false)
  const urlInput = useRef<HTMLInputElement>(null)
  const webUrlInput = useRef<HTMLInputElement>(null)
  const codeInput = useRef<HTMLInputElement>(null)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const focusEntry = useRef(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordError, setPasswordError] = useState<{ field: 'username' | 'password' | 'form'; text: string } | null>(null)
  const usernameInput = useRef<HTMLInputElement>(null)
  const passwordInput = useRef<HTMLInputElement>(null)
  const passwordEntryButton = useRef<HTMLButtonElement>(null)
  const focusPasswordEntry = useRef(false)

  function navigate(next: Page) {
    pageRef.current = next
    setPage(next)
  }
  function showAccount(state: AccountView) {
    if (pageRef.current === 'settings' || pageRef.current === 'password' || (state.attempt === null && pageRef.current === 'entry')) return
    attemptRef.current = state.attempt
    setAttempt(state.attempt)
    setStarting(false)
    setCopyFeedback({ status: 'idle' })
    navigate(state.attempt === null || state.attempt.phase === 'cancelled' ? 'entry' : 'account')
  }

  useEffect(() => {
    mounted.current = true
    document.documentElement.lang = api.id
    document.title = m.welcomeTitle
    const takeNotice = (): void => {
      void api.takeNotice().then((notice) => {
        if (mounted.current && notice === 'session-expired') setExpiryNotice(true)
      }).catch((_closedChannel: unknown) => {
        // A closed Welcome IPC channel must not interrupt the sign-in page.
      })
    }
    takeNotice()
    const stop = api.onAccountState((state) => {
      revision.current++
      takeNotice()
      showAccount(state)
    })
    return () => { mounted.current = false; stop() }
  }, [api, m.welcomeTitle])

  useEffect(() => {
    if (page === 'entry' && visiblePage.current !== 'entry') void api.analytics?.('auth_page_view', {})
    visiblePage.current = page
    if (page === 'settings') urlInput.current?.focus()
    else if (page === 'password') usernameInput.current?.focus()
    else if (page === 'entry' && focusPasswordEntry.current) {
      focusPasswordEntry.current = false
      passwordEntryButton.current?.focus()
    } else if (page === 'entry' && focusEntry.current) {
      focusEntry.current = false
      settingsButton.current?.focus()
    }
  }, [page, api])

  useEffect(() => {
    if (copyState !== 'copied' && copyState !== 'failed') return
    const timer = setTimeout(() => { setCopyFeedback({ status: 'idle' }) }, 2000)
    return () => { clearTimeout(timer) }
  }, [copyFeedback])

  async function openSettings() {
    if (busyRef.current) return
    setSettingsError(null)
    try {
      const saved = await api.readSystemConnection()
      if (!mounted.current) return
      setSystemUrl(saved.systemUrl)
      setWebUrl(saved.webUrl)
      setAuthCode(saved.authCode)
    } catch {
      if (mounted.current) setSettingsError({ field: 'form', text: m.welcomeSettingsFailed })
    }
    if (mounted.current) navigate('settings')
  }
  function leaveSettings() {
    if (busyRef.current) return
    setSettingsError(null)
    focusEntry.current = true
    navigate('entry')
  }
  function settingsFailure(result: Exclude<SystemConnectionSaveResult, { ok: true }>) {
    switch (result.reason) {
      case 'url-required': return { field: 'url', text: m.welcomeSystemUrlRequired } as const
      case 'url-invalid': return { field: 'url', text: m.welcomeSystemUrlInvalid } as const
      case 'web-url-required': return { field: 'web', text: m.welcomeWebUrlRequired } as const
      case 'web-url-invalid': return { field: 'web', text: m.welcomeSystemUrlInvalid } as const
      case 'auth-code-required': return { field: 'code', text: m.welcomeAuthCodeRequired } as const
      case 'write-failed': return { field: 'form', text: m.welcomeSettingsFailed } as const
      default: {
        const unknownReason: never = result.reason
        throw new Error(`desktop welcome: unknown settings failure ${String(unknownReason)}`)
      }
    }
  }
  async function saveSettings(event: FormEvent) {
    event.preventDefault()
    if (busyRef.current) return
    const local = systemUrl.trim() === '' ? settingsFailure({ ok: false, reason: 'url-required' })
      : webUrl.trim() === '' ? settingsFailure({ ok: false, reason: 'web-url-required' })
        : authCode.trim() === '' ? settingsFailure({ ok: false, reason: 'auth-code-required' }) : null
    const settingsInput = (field: 'url' | 'web' | 'code' | 'form') => field === 'code' ? codeInput : field === 'web' ? webUrlInput : urlInput
    if (local !== null) {
      setSettingsError(local)
      settingsInput(local.field).current?.focus()
      return
    }
    busyRef.current = true
    setBusy(true)
    setSettingsError(null)
    try {
      const result = await api.saveSystemConnection({ systemUrl: systemUrl.trim(), webUrl: webUrl.trim(), authCode: authCode.trim() })
      if (!mounted.current) return
      if (result.ok) {
        setSavedNotice(true)
        focusEntry.current = true
        navigate('entry')
      } else {
        const failure = settingsFailure(result)
        setSettingsError(failure)
        if (failure.field !== 'form') settingsInput(failure.field).current?.focus()
      }
    } catch {
      if (mounted.current) setSettingsError({ field: 'form', text: m.welcomeSettingsFailed })
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  function openPassword() {
    setPasswordError(null)
    setPassword('')
    navigate('password')
  }
  function leavePassword() {
    if (busyRef.current) return
    setPasswordError(null)
    setPassword('')
    focusPasswordEntry.current = true
    navigate('entry')
  }
  function passwordFailure(result: Exclude<PasswordSignInResult, { ok: true }>) {
    switch (result.reason) {
      case 'username-required': return { field: 'username', text: m.welcomeUsernameRequired } as const
      case 'password-required': return { field: 'password', text: m.welcomePasswordRequired } as const
      case 'invalid-credentials': return { field: 'form', text: m.welcomePasswordInvalid } as const
      case 'unreachable': return { field: 'form', text: m.welcomePasswordUnreachable } as const
      case 'failed': return { field: 'form', text: m.welcomePasswordFailed } as const
      default: {
        const unknownReason: never = result.reason
        throw new Error(`desktop welcome: unknown password sign-in failure ${String(unknownReason)}`)
      }
    }
  }
  async function submitPassword(event: FormEvent) {
    event.preventDefault()
    if (busyRef.current) return
    const local = username.trim() === '' ? passwordFailure({ ok: false, reason: 'username-required' })
      : password === '' ? passwordFailure({ ok: false, reason: 'password-required' }) : null
    if (local !== null) {
      setPasswordError(local)
      ;(local.field === 'password' ? passwordInput : usernameInput).current?.focus()
      return
    }
    busyRef.current = true
    setBusy(true)
    setPasswordError(null)
    try {
      const result = await api.passwordSignIn({ username: username.trim(), password })
      if (!mounted.current || result.ok) return
      const failure = passwordFailure(result)
      setPasswordError(failure)
      ;(failure.field === 'username' ? usernameInput : passwordInput).current?.focus()
    } catch {
      if (mounted.current) setPasswordError({ field: 'form', text: m.welcomePasswordFailed })
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function start() {
    navigate('account')
    setStarting(true)
    setAttempt(null)
    attemptRef.current = null
    const current = ++revision.current
    try {
      const state = await api.startSignIn()
      if (mounted.current && revision.current === current) showAccount(state)
    } catch {
      if (mounted.current && revision.current === current) setStarting(false)
    }
  }
  async function cancel() {
    if (cancelling || attemptRef.current === null) return
    setCancelling(true)
    const current = ++revision.current
    try {
      const state = await api.cancelSignIn(attemptRef.current.id)
      if (mounted.current && revision.current === current) showAccount(state)
    } catch {
      // The current attempt remains visible so cancellation can be retried.
    } finally {
      if (mounted.current) setCancelling(false)
    }
  }
  async function copyLink() {
    const current = attemptRef.current
    if (current?.phase !== 'waiting-browser' || (copyState === 'busy' || copyState === 'copied')) return
    setCopyFeedback({ status: 'busy' })
    try {
      await api.copySignInLink(current.id)
      if (mounted.current && attemptRef.current === current) setCopyFeedback({ status: 'copied' })
    } catch {
      if (mounted.current && attemptRef.current === current) setCopyFeedback({ status: 'failed' })
    }
  }

  const phase = starting ? 'initializing' : attempt?.phase ?? 'failed'
  const waiting = phase === 'waiting-browser'
  const failed = phase === 'expired' || phase === 'failed'
  const title = phase === 'initializing' ? m.welcomeAuthStarting
    : waiting ? m.welcomeAuthWaiting : phase === 'expired' ? m.welcomeAuthExpired
      : phase === 'failed' ? m.welcomeAuthFailed : m.welcomeAuthExchanging
  const heading = page === 'entry' ? 'welcome-heading' : page === 'settings' ? 'settings-title'
    : page === 'password' ? 'password-title' : 'auth-status'

  return <>
    {expiryNotice && <Toast text={m.welcomeSessionExpired} onDone={() => { setExpiryNotice(false) }} />}
    {savedNotice && <Toast text={m.welcomeSettingsSaved} onDone={() => { setSavedNotice(false) }} />}
    <div className="titlebar" aria-hidden="true" />
    <main className="welcome" aria-labelledby={heading}>
      <div className="brand">
        <img className="brand-logo" src="assets/kaifang-logo.png" alt={m.welcomeBrand} width="40" height="39" />
        <span className="brand-name" aria-hidden="true">{m.welcomeBrand}</span>
      </div>
      <div id="tagline" className="tagline" hidden={page !== 'entry'}>
        <h1 id="welcome-heading"><span>{m.welcomeTaglineBefore}</span><em>{m.welcomeTaglineBrand}</em><span>{m.welcomeTaglineAfter}</span></h1>
        <p id="welcome-description">{m.welcomeDescription}</p>
      </div>
      <form id="settings-form" className="key-form settings-form" hidden={page !== 'settings'} noValidate onSubmit={(event) => { void saveSettings(event) }} aria-busy={busy}>
        <header className="key-heading"><h1 id="settings-title">{m.welcomeSettingsTitle}</h1><p id="settings-description">{m.welcomeSettingsDescription}</p></header>
        <div className="settings-fields">
          <div className="key-field">
            <label className="field-label" htmlFor="system-url">{m.welcomeSystemUrl}<span className="required" aria-hidden="true">*</span></label>
            <input ref={urlInput} id="system-url" type="url" autoComplete="off" autoCapitalize="off" spellCheck={false} required
              aria-describedby="system-url-error" aria-invalid={settingsError?.field === 'url'} placeholder={m.welcomeSystemUrlPlaceholder}
              value={systemUrl} disabled={busy} onChange={(event) => { setSystemUrl(event.target.value); setSettingsError(null) }} />
            <p id="system-url-error" className="key-error" role="alert" hidden={settingsError?.field !== 'url'}>{settingsError?.field === 'url' ? settingsError.text : ''}</p>
          </div>
          <div className="key-field">
            <label className="field-label" htmlFor="web-url">{m.welcomeWebUrl}<span className="required" aria-hidden="true">*</span></label>
            <input ref={webUrlInput} id="web-url" type="url" autoComplete="off" autoCapitalize="off" spellCheck={false} required
              aria-describedby="web-url-error" aria-invalid={settingsError?.field === 'web'} placeholder={m.welcomeWebUrlPlaceholder}
              value={webUrl} disabled={busy} onChange={(event) => { setWebUrl(event.target.value); setSettingsError(null) }} />
            <p id="web-url-error" className="key-error" role="alert" hidden={settingsError?.field !== 'web'}>{settingsError?.field === 'web' ? settingsError.text : ''}</p>
          </div>
          <div className="key-field">
            <label className="field-label" htmlFor="auth-code">{m.welcomeAuthCode}<span className="required" aria-hidden="true">*</span></label>
            <input ref={codeInput} id="auth-code" type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} required
              aria-describedby="auth-code-error" aria-invalid={settingsError?.field === 'code'} placeholder={m.welcomeAuthCodePlaceholder}
              value={authCode} disabled={busy} onChange={(event) => { setAuthCode(event.target.value); setSettingsError(null) }} />
            <p id="auth-code-error" className="key-error" role="alert" hidden={settingsError === null || settingsError.field === 'url' || settingsError.field === 'web'}>{settingsError !== null && (settingsError.field === 'code' || settingsError.field === 'form') ? settingsError.text : ''}</p>
          </div>
        </div>
      </form>
      <form id="password-form" className="key-form settings-form" hidden={page !== 'password'} noValidate onSubmit={(event) => { void submitPassword(event) }} aria-busy={busy}>
        <header className="key-heading"><h1 id="password-title">{m.welcomePasswordTitle}</h1><p id="password-description">{m.welcomePasswordDescription}</p></header>
        <div className="settings-fields">
          <div className="key-field">
            <label className="field-label" htmlFor="username">{m.welcomeUsername}<span className="required" aria-hidden="true">*</span></label>
            <input ref={usernameInput} id="username" type="text" autoComplete="username" autoCapitalize="off" spellCheck={false} required
              aria-describedby="username-error" aria-invalid={passwordError?.field === 'username'} placeholder={m.welcomeUsernamePlaceholder}
              value={username} disabled={busy} onChange={(event) => { setUsername(event.target.value); setPasswordError(null) }} />
            <p id="username-error" className="key-error" role="alert" hidden={passwordError?.field !== 'username'}>{passwordError?.field === 'username' ? passwordError.text : ''}</p>
          </div>
          <div className="key-field">
            <label className="field-label" htmlFor="password">{m.welcomePassword}<span className="required" aria-hidden="true">*</span></label>
            <input ref={passwordInput} id="password" type="password" autoComplete="current-password" autoCapitalize="off" spellCheck={false} required
              aria-describedby="password-error" aria-invalid={passwordError !== null && passwordError.field !== 'username'} placeholder={m.welcomePasswordPlaceholder}
              value={password} disabled={busy} onChange={(event) => { setPassword(event.target.value); setPasswordError(null) }} />
            <p id="password-error" className="key-error" role="alert" hidden={passwordError === null || passwordError.field === 'username'}>{passwordError !== null && passwordError.field !== 'username' ? passwordError.text : ''}</p>
          </div>
        </div>
      </form>
      <section id="auth-page" className={`key-heading ${waiting ? 'auth-waiting' : phase === 'expired' ? 'auth-expired' : ''}`}
        hidden={page !== 'account'} aria-live="polite">
        <h1 id="auth-status">{title}</h1>
        <p id="auth-description" hidden={!waiting && phase !== 'expired'}>{waiting ? m.welcomeAuthWaitingDescription : m.welcomeAuthExpiredDescription}</p>
        <button id="auth-copy" className="copy-link" type="button" hidden={!waiting} disabled={!waiting || (copyState === 'busy' || copyState === 'copied')} onClick={() => { void copyLink() }}>
          {copyState === 'copied' ? m.welcomeAuthCopied : copyState === 'failed' ? m.welcomeAuthCopyFailed : m.welcomeAuthCopyLink}
        </button>
      </section>
      <div id="auth-actions" className="actions" hidden={page !== 'account'}>
        <button id="auth-loading" className="primary" type="button" hidden={failed} disabled aria-label={m.welcomeAuthExchanging}>
          <StateDot state="ongoing" size={16} className="welcome-loading" />
        </button>
        <button id="auth-retry" className="primary" type="button" hidden={!failed} onClick={() => { void api.analytics?.('auth_page_click', { button_name: 'sign_in' }); void start() }}>{m.welcomeAuthRetry}</button>
        <button id="auth-cancel" className="secondary" type="button" hidden={failed}
          disabled={cancelling || phase === 'committing' || phase === 'succeeded' || (phase === 'initializing' && !attempt?.id)}
          onClick={() => { void cancel() }}>{m.welcomeAuthCancel}</button>
      </div>
      <div id="entry-actions" className="actions" hidden={page !== 'entry'}>
        <button id="sign-in" className="primary" type="button" onClick={() => { void api.analytics?.('auth_page_click', { button_name: 'sign_in' }); void start() }}>{m.welcomeSignIn}</button>
        <button ref={passwordEntryButton} id="password-sign-in" className="secondary" type="button" onClick={openPassword}>{m.welcomePasswordSignIn}</button>
      </div>
      <div id="password-actions" className="actions" hidden={page !== 'password'}>
        <button id="submit-password" className="primary" type="submit" form="password-form" disabled={busy}
          aria-label={busy ? m.welcomeAuthExchanging : undefined}>
          {busy && page === 'password' ? <StateDot state="ongoing" size={16} className="welcome-loading" /> : m.welcomePasswordSubmit}
        </button>
        <button id="password-back" className="secondary" type="button" disabled={busy} onClick={leavePassword}>{m.welcomeSettingsBack}</button>
      </div>
      <div id="settings-actions" className="actions" hidden={page !== 'settings'}>
        <button id="save-settings" className="primary" type="submit" form="settings-form" disabled={busy}>{m.welcomeSettingsSave}</button>
        <button id="settings-back" className="secondary" type="button" disabled={busy} onClick={leaveSettings}>{m.welcomeSettingsBack}</button>
      </div>
    </main>
    <button ref={settingsButton} id="open-settings" className="settings-button" type="button" hidden={page !== 'entry'}
      aria-label={m.welcomeSettings} title={m.welcomeSettings} onClick={() => { void openSettings() }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09c-.66 0-1.25.4-1.51 1z" />
      </svg>
    </button>
  </>
}
