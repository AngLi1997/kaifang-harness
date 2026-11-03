/** Native Platform sign-in through the system browser; keeps the Desktop shell after success. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives/src/Toast.tsx'
import type { WelcomeApi } from '../welcome-api.ts'

type Page = 'entry' | 'settings'

/** @param api - isolated native operations and localized shell copy. */
export function Welcome({ api }: { api: WelcomeApi }) {
  const { messages: m } = api
  const [page, setPage] = useState<Page>(api.initialPage === 'settings' ? 'settings' : 'entry')
  const [sharedHarnessUrl, setSharedHarnessUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [waitingBrowser, setWaitingBrowser] = useState(false)
  const [openError, setOpenError] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [signInError, setSignInError] = useState('')
  const urlInput = useRef<HTMLInputElement>(null)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    document.documentElement.lang = api.id
    document.title = m.welcomeTitle
    return () => { mounted.current = false }
  }, [api.id, m.welcomeTitle])

  useEffect(() => {
    if (page === 'settings') urlInput.current?.focus()
    else if (page === 'entry') settingsButton.current?.focus()
  }, [page])

  useEffect(() => {
    if (api.initialPage !== 'settings') return
    void api.readSharedHarnessUrl().then((value) => {
      if (mounted.current) setSharedHarnessUrl(value)
    }).catch(() => {
      if (mounted.current) setOpenError(true)
    })
  }, [api])

  async function openSettings() {
    try {
      setSharedHarnessUrl(await api.readSharedHarnessUrl())
      setSettingsError('')
      if (mounted.current) setPage('settings')
    } catch {
      if (mounted.current) setOpenError(true)
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setOpenError(false)
    setSettingsError('')
    try {
      const saved = await api.saveSharedHarnessUrl(sharedHarnessUrl)
      if (!saved.ok) {
        if (mounted.current) setSettingsError(saved.reason === 'invalid-url' ? m.welcomeSystemUrlInvalid : m.welcomeSettingsFailed)
        return
      }
      setSharedHarnessUrl(saved.url)
      if (mounted.current) setPage('entry')
    } catch {
      if (mounted.current) setSettingsError(m.welcomeSettingsFailed)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function startBrowserSignIn() {
    if (busy) return
    setBusy(true)
    setWaitingBrowser(true)
    setOpenError(false)
    setSignInError('')
    try {
      const result = await api.startBrowserSignIn()
      if (!mounted.current || result.ok) return
      if (result.reason === 'url-required') {
        await openSettings()
        setOpenError(true)
        return
      }
      if (result.reason === 'cancelled' || result.reason === 'denied') return
      setSignInError(result.reason === 'unreachable' ? m.welcomePasswordUnreachable
        : result.reason === 'expired' ? m.welcomeAuthExpired : m.welcomeAuthFailed)
    } catch {
      if (mounted.current) setSignInError(m.welcomeAuthFailed)
    } finally {
      if (mounted.current) {
        setBusy(false)
        setWaitingBrowser(false)
      }
    }
  }

  async function cancelBrowserSignIn() {
    try { await api.cancelBrowserSignIn() } catch { /* main settles the attempt */ }
  }

  return <>
    {openError && <Toast text={m.welcomeAuthFailed} onDone={() => { setOpenError(false) }} />}
    {signInError !== '' && <Toast text={signInError} onDone={() => { setSignInError('') }} />}
    <div className="titlebar" aria-hidden="true" />
    <main className="welcome" aria-labelledby={page === 'entry' ? 'welcome-heading' : 'settings-title'}>
      <div className="brand">
        <img className="brand-logo" src="assets/kaifang-logo.png" alt={m.welcomeBrand} width="40" height="31" />
        <span className="brand-name" aria-hidden="true">{m.welcomeBrand}</span>
      </div>
      <div id="tagline" className="tagline" hidden={page !== 'entry'}>
        <h1 id="welcome-heading"><span>{m.welcomeTaglineBefore}</span><em>{m.welcomeTaglineBrand}</em><span>{m.welcomeTaglineAfter}</span></h1>
        <p id="welcome-description">{m.welcomeDescription}</p>
      </div>
      <form id="settings-form" className="key-form settings-form" hidden={page !== 'settings'} onSubmit={(event) => { void saveSettings(event) }}>
        <header className="key-heading">
          <h1 id="settings-title">{m.welcomeSettingsTitle}</h1>
          <p id="settings-description">{m.welcomeSettingsDescription}</p>
        </header>
        <div className="settings-fields">
          <div className="key-field">
            <label className="field-label" htmlFor="shared-harness-url">{m.welcomeSystemUrl}</label>
            <input ref={urlInput} id="shared-harness-url" type="url" value={sharedHarnessUrl}
              placeholder={m.welcomeSystemUrlPlaceholder} disabled={busy} aria-invalid={settingsError !== ''}
              onChange={(event) => { setSharedHarnessUrl(event.currentTarget.value); setSettingsError('') }} />
            {settingsError !== '' && <p className="key-error" role="alert">{settingsError}</p>}
          </div>
        </div>
      </form>
      <div id="entry-actions" className="actions" hidden={page !== 'entry'}>
        {!waitingBrowser && <button id="start-browser-sign-in" className="primary" type="button" disabled={busy} onClick={() => { void startBrowserSignIn() }}>
          {busy ? m.welcomeAuthStarting : m.welcomeSignIn}
        </button>}
        {waitingBrowser && <>
          <p id="browser-waiting" className="welcome-waiting">{m.welcomeAuthWaitingDescription}</p>
          <button id="cancel-browser-sign-in" className="secondary" type="button" onClick={() => { void cancelBrowserSignIn() }}>
            {m.welcomeAuthCancel}
          </button>
        </>}
        <button id="open-local-workspace" className="secondary" type="button" disabled={busy || waitingBrowser} onClick={() => { void api.skip() }}>
          {m.openLocalWorkspaceMenu}
        </button>
      </div>
      <div id="settings-actions" className="actions" hidden={page !== 'settings'}>
        <button id="settings-back" className="secondary" type="button" disabled={busy} onClick={() => { setPage('entry') }}>
          {m.welcomeSettingsBack}
        </button>
        <button id="save-settings" className="primary" type="submit" form="settings-form" disabled={busy}>
          {busy ? m.welcomeAuthStarting : m.welcomeSettingsSave}
        </button>
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
