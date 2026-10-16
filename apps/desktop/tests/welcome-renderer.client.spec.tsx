// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Welcome } from '../src/client/WelcomePage.tsx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import type { SystemConnection, SystemConnectionSaveResult, WelcomeSaveResult, WelcomeNotice } from '../src/welcome-api.ts'

const DEFAULT_SYSTEM_CONNECTION: SystemConnection = { systemUrl: 'http://127.0.0.1:9999', authCode: '' }

const html = readFileSync(join(import.meta.dirname, '../renderer/welcome.html'), 'utf8')
afterEach(cleanup)

function mount(language = 'zh-CN', takeNotice = vi.fn<() => Promise<WelcomeNotice | undefined>>().mockResolvedValue(undefined)) {
  cleanup()
  const stopAccount = vi.fn()
  const api = {
    takeNotice,
    analytics: vi.fn(async (_event: string, _attributes: object) => {}),
    analyticsEnabled: async () => true,
    onAccountState: vi.fn((_listener: (state: AccountView) => void) => stopAccount),
    startSignIn: vi.fn(async (): Promise<AccountView> => ({ links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'signed-out', attempt: null })),
    cancelSignIn: vi.fn(async (): Promise<AccountView> => ({ links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'signed-out', attempt: null })),
    copySignInLink: vi.fn(async () => undefined),
    ...resolveDesktopLocale(language),
    saveApiKey: vi.fn<(value: string) => Promise<WelcomeSaveResult>>().mockResolvedValue({ ok: true }),
    skip: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    readSystemConnection: vi.fn<() => Promise<SystemConnection>>().mockResolvedValue(DEFAULT_SYSTEM_CONNECTION),
    saveSystemConnection: vi.fn<(value: SystemConnection) => Promise<SystemConnectionSaveResult>>().mockResolvedValue({ ok: true }),
  }
  const mounted = render(<Welcome api={api} />)
  const url = document.querySelector<HTMLInputElement>('#system-url')!
  const code = document.querySelector<HTMLInputElement>('#auth-code')!
  const button = (id: string) => document.querySelector<HTMLButtonElement>(id)!
  const enter = (input: HTMLInputElement, value: string) => {
    fireEvent.change(input, { target: { value } })
  }
  const openSettings = async () => { await act(async () => { fireEvent.click(button('#open-settings')) }) }
  const submit = () => fireEvent.submit(document.querySelector('form')!)
  const copy = () => {
    const heading = document.querySelector('main')!.getAttribute('aria-labelledby')!
    return [
      document.title, document.querySelector('img')!.alt, document.getElementById(heading)!.textContent,
      ...heading === 'welcome-heading' ? [document.querySelector('#welcome-description')!.textContent] : [],
      ...heading === 'settings-title' ? [document.querySelector('#settings-description')!.textContent,
        `${url.labels![0]!.textContent}: ${url.value || url.placeholder}`, `${code.labels![0]!.textContent}: ${code.placeholder} [password]`] : [],
      ...[...document.querySelectorAll('button')].filter(item => item.closest('[hidden]') === null)
        .map(item => `${item.textContent || item.getAttribute('aria-label')}${item.disabled ? ' [disabled]' : ''}`),
      '',
    ].join('\n')
  }
  return { document, api, url, code, button, enter, openSettings, submit, copy, unmount: mounted.unmount, stopAccount }
}

describe('desktop welcome presentation', () => {
  it.each(['zh-CN', 'en'])('renders the %s entry and settings page', async (language) => {
    const view = mount(language)
    expect(view.document.documentElement.lang).toBe(language)
    expect(view.document.querySelector('img')!.getAttribute('src')).toBe('assets/kaifang-logo.png')
    expect(view.document.querySelector('#api-key')).toBeNull()
    await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}.expected.txt`)
    await view.openSettings()
    expect(view.api.readSystemConnection).toHaveBeenCalledOnce()
    expect(view.document.activeElement).toBe(view.url)
    expect(view.url.value).toBe('http://127.0.0.1:9999')
    expect(view.code.value).toBe('')
    expect(view.code.type).toBe('password')
    await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}-settings.expected.txt`)
  })

  it('saves one trimmed connection, prevents competing actions, and returns to the entry', async () => {
    const view = mount()
    const saved = Promise.withResolvers<SystemConnectionSaveResult>()
    view.api.saveSystemConnection.mockReturnValue(saved.promise)
    await view.openSettings()
    view.enter(view.url, '  https://kaifang.example.test  ')
    view.enter(view.code, '  code-123  ')
    view.submit()
    view.submit()
    fireEvent.click(view.button('#settings-back'))
    expect(view.api.saveSystemConnection).toHaveBeenCalledExactlyOnceWith({ systemUrl: 'https://kaifang.example.test', authCode: 'code-123' })
    expect(view.button('#save-settings').disabled).toBe(true)
    expect(view.button('#settings-back').disabled).toBe(true)
    await act(async () => { saved.resolve({ ok: true }); await saved.promise })
    expect(view.document.querySelector<HTMLElement>('#settings-form')!.hidden).toBe(true)
    expect(view.document.activeElement).toBe(view.button('#open-settings'))
    expect(screen.getByRole('alert').textContent).toBe(view.api.messages.welcomeSettingsSaved)
  })

  it.each([
    ['', 'code', '#system-url-error', 'welcomeSystemUrlRequired'],
    ['http://127.0.0.1:9999', '', '#auth-code-error', 'welcomeAuthCodeRequired'],
  ] as const)('requires both fields before saving: %j %j', async (systemUrl, authCode, errorId, message) => {
    const view = mount()
    await view.openSettings()
    view.enter(view.url, systemUrl)
    view.enter(view.code, authCode)
    view.submit()
    expect(view.api.saveSystemConnection).not.toHaveBeenCalled()
    const error = view.document.querySelector<HTMLElement>(errorId)!
    expect(error.hidden).toBe(false)
    expect(error.textContent).toBe(view.api.messages[message])
  })

  it('shows host validation and write failures and allows retry', async () => {
    const view = mount()
    view.api.saveSystemConnection.mockResolvedValueOnce({ ok: false, reason: 'url-invalid' })
    await view.openSettings()
    view.enter(view.url, 'ftp://example.test')
    view.enter(view.code, 'code')
    await act(async () => { view.submit() })
    expect(view.document.querySelector('#system-url-error')!.textContent).toBe(view.api.messages.welcomeSystemUrlInvalid)
    expect(view.url.getAttribute('aria-invalid')).toBe('true')
    view.api.saveSystemConnection.mockResolvedValueOnce({ ok: false, reason: 'write-failed' })
    await act(async () => { view.submit() })
    expect(view.document.querySelector('#auth-code-error')!.textContent).toBe(view.api.messages.welcomeSettingsFailed)
    expect(view.document.querySelector<HTMLElement>('#settings-form')!.hidden).toBe(false)
    await act(async () => { view.submit() })
    expect(view.document.querySelector<HTMLElement>('#settings-form')!.hidden).toBe(true)
  })

  it('returns to the entry without saving and reloads the saved connection next time', async () => {
    const view = mount()
    await view.openSettings()
    view.enter(view.url, 'http://unsaved.example.test')
    fireEvent.click(view.button('#settings-back'))
    expect(view.document.querySelector<HTMLElement>('#settings-form')!.hidden).toBe(true)
    expect(view.document.activeElement).toBe(view.button('#open-settings'))
    expect(view.api.saveSystemConnection).not.toHaveBeenCalled()
    view.api.readSystemConnection.mockResolvedValueOnce({ systemUrl: 'http://saved.example.test', authCode: 'saved-code' })
    await view.openSettings()
    expect(view.url.value).toBe('http://saved.example.test')
    expect(view.code.value).toBe('saved-code')
  })

  it('keeps visible copy in the shell dictionaries and denies network access', () => {
    expect([...html.matchAll(/>([^<]*\p{L}[^<]*)</gu)]).toEqual([])
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("form-action 'none'")
  })
})

it.each(['zh-CN', 'en'])('renders %s timeout with manual retry only', async (language) => {
  const view = mount(language)
  const receive = (state: AccountView) => { act(() => { view.api.onAccountState.mock.calls[0]![0](state) }) }
  receive({ status: 'signed-out', links: { usageUrl: '', topUpUrl: '' }, attempt: { id: 'expired' as NonNullable<AccountView['attempt']>['id'], phase: 'expired' } })
  expect(view.button('#auth-retry').hidden).toBe(false)
  expect(view.document.querySelector('#auth-api-key')).toBeNull()
  expect(view.api.startSignIn).not.toHaveBeenCalled()
  await expect(view.copy() + view.document.querySelector('#auth-description')!.textContent + '\n').toMatchFileSnapshot(`./expected/welcome/${language}-timeout.expected.txt`)
})

it.each(['zh-CN', 'en'])('renders %s browser fallback and copies only the active login link', async (language) => {
  const view = mount(language)
  const receive = (state: AccountView) => { act(() => { view.api.onAccountState.mock.calls[0]![0](state) }) }
  const waiting: AccountView = { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' },
    attempt: { id: 'waiting' as NonNullable<AccountView['attempt']>['id'], phase: 'waiting-browser', authorizeUrl: 'https://example.test/login' } }
  receive(waiting)
  await expect(view.copy() + view.document.querySelector('#auth-description')!.textContent + '\n')
    .toMatchFileSnapshot(`./expected/welcome/${language}-waiting.expected.txt`)
  fireEvent.click(view.button('#auth-copy'))
  await vi.waitFor(() => { expect(view.button('#auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopied) })
  expect(view.api.copySignInLink).toHaveBeenCalledWith('waiting')
  await vi.waitFor(() => { expect(view.button('#auth-copy').disabled).toBe(false) }, { timeout: 3000 })
  view.api.copySignInLink.mockRejectedValueOnce(new Error('clipboard unavailable'))
  fireEvent.click(view.button('#auth-copy'))
  await vi.waitFor(() => { expect(view.button('#auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopyFailed) })
  expect(view.button('#auth-cancel').disabled).toBe(false)
  receive({ ...waiting, attempt: { ...waiting.attempt!, phase: 'exchanging' } })
  expect(view.button('#auth-copy').hidden).toBe(true)
  expect(view.button('#auth-loading').hidden).toBe(false)
  receive({ ...waiting, attempt: { ...waiting.attempt!, phase: 'cancelled' } })
  expect(view.document.querySelector('main')!.classList.contains('waiting-page')).toBe(false)
})

it('keeps a newer account notification when the start response arrives late', async () => {
  const view = mount()
  const started = Promise.withResolvers<AccountView>()
  view.api.startSignIn.mockReturnValueOnce(started.promise)
  fireEvent.click(view.button('#sign-in'))
  expect(view.button('#auth-cancel').disabled).toBe(true)
  const state: AccountView = { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' },
    attempt: { id: 'attempt' as NonNullable<AccountView['attempt']>['id'], phase: 'expired' } }
  act(() => { view.api.onAccountState.mock.calls[0]![0](state) })
  await act(async () => { started.resolve({ ...state, attempt: { ...state.attempt!, phase: 'waiting-browser' } }); await started.promise })
  expect(view.document.querySelector('#auth-status')!.textContent).toBe(view.api.messages.welcomeAuthExpired)
  expect(view.button('#auth-retry').hidden).toBe(false)
})

it('does not restore a copied-link status after leaving the waiting phase', async () => {
  const view = mount()
  const copied = Promise.withResolvers<undefined>()
  view.api.copySignInLink.mockReturnValueOnce(copied.promise)
  const waiting: AccountView = { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' },
    attempt: { id: 'attempt' as NonNullable<AccountView['attempt']>['id'], phase: 'waiting-browser' } }
  act(() => { view.api.onAccountState.mock.calls[0]![0](waiting) })
  fireEvent.click(view.button('#auth-copy'))
  expect(view.button('#auth-copy').disabled).toBe(true)
  act(() => { view.api.onAccountState.mock.calls[0]![0]({ ...waiting, attempt: { ...waiting.attempt!, phase: 'exchanging' } }) })
  await act(async () => { copied.resolve(undefined); await copied.promise })
  expect(view.button('#auth-copy').hidden).toBe(true)
  expect(view.button('#auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopyLink)
})

it('keeps the settings draft while account notifications arrive and releases the subscription on unmount', async () => {
  const view = mount()
  await view.openSettings()
  view.enter(view.code, 'draft-code')
  act(() => { view.api.onAccountState.mock.calls[0]![0]({ status: 'signed-out', links: { usageUrl: '', topUpUrl: '' },
    attempt: { id: 'expired' as NonNullable<AccountView['attempt']>['id'], phase: 'expired' } }) })
  expect(view.document.querySelector<HTMLElement>('#settings-form')!.hidden).toBe(false)
  expect(view.code.value).toBe('draft-code')
  view.unmount()
  expect(view.stopAccount).toHaveBeenCalledOnce()
})

it.each(['copied', 'failed'] as const)('restores the copy action after %s feedback and cleans up on unmount', async (result) => {
  vi.useFakeTimers()
  try {
    const view = mount('en')
    if (result === 'failed') view.api.copySignInLink.mockRejectedValue(new Error('clipboard unavailable'))
    const waiting: AccountView = { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' },
      attempt: { id: 'waiting' as NonNullable<AccountView['attempt']>['id'], phase: 'waiting-browser' } }
    act(() => { view.api.onAccountState.mock.calls[0]![0](waiting) })
    const feedback = result === 'copied' ? view.api.messages.welcomeAuthCopied : view.api.messages.welcomeAuthCopyFailed
    const copy = async () => { await act(async () => { fireEvent.click(view.button('#auth-copy')) }) }
    await copy()
    expect(view.button('#auth-copy').textContent).toBe(feedback)
    expect(view.button('#auth-copy').disabled).toBe(result === 'copied')
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    await copy()
    expect(view.api.copySignInLink).toHaveBeenCalledTimes(result === 'copied' ? 1 : 2)
    await act(async () => { await vi.advanceTimersByTimeAsync(result === 'copied' ? 499 : 1999) })
    expect(view.button('#auth-copy').textContent).toBe(feedback)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(view.button('#auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopyLink)
    expect(view.button('#auth-copy').disabled).toBe(false)
    await copy()
    expect(view.api.copySignInLink).toHaveBeenCalledTimes(result === 'copied' ? 2 : 3)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

it.each(['zh-CN', 'en'])('keeps the expiry notice visible after returning to Welcome: %s', async (language) => {
  vi.useFakeTimers()
  try {
    const takeNotice = vi.fn<() => Promise<WelcomeNotice | undefined>>().mockResolvedValue(undefined).mockResolvedValueOnce('session-expired')
    const view = mount(language, takeNotice)
    await act(async () => {})
    const publish = view.api.onAccountState.mock.calls[0]![0]
    const expired: AccountView = { status: 'signed-out', attempt: null,
      links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' } }
    await act(async () => { publish(expired) })
    const notice = screen.getByRole('alert')
    expect(notice.textContent).toBe(view.api.messages.welcomeSessionExpired)
    await expect(`${notice.textContent}\n`).toMatchFileSnapshot(`./expected/welcome/${language}-expired.expected.txt`)
    expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { publish(expired) })
    expect(screen.queryByRole('alert')).toBeNull()
    view.unmount()
    mount(language, takeNotice)
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
  } finally { cleanup(); vi.useRealTimers() }
})

it('does not infer a notification from a retained expired account snapshot', async () => {
  const view = mount()
  await act(async () => {
    view.api.onAccountState.mock.calls[0]![0]({ status: 'signed-out', attempt: null,
      links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' } })
  })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps the entry usable when notification IPC fails', async () => {
  const view = mount('en', vi.fn<() => Promise<WelcomeNotice | undefined>>().mockRejectedValue(new Error('closed')))
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  await view.openSettings()
  expect(view.url.closest('[hidden]')).toBeNull()
})

it('ignores a notification received after its renderer unmounts', async () => {
  const pending = Promise.withResolvers<WelcomeNotice | undefined>()
  const view = mount('en', vi.fn<() => Promise<WelcomeNotice | undefined>>().mockReturnValue(pending.promise))
  view.unmount()
  mount('en')
  await act(async () => { pending.resolve('session-expired') })
  expect(screen.queryByRole('alert')).toBeNull()
})


it.each(['zh-CN', 'en'])('returns from completed sign-in to the initial page after sign-out: %s', async (language) => {
  const view = mount(language)
  const publish = view.api.onAccountState.mock.calls[0]![0]
  const links = { usageUrl: 'https://example.test/usage', topUpUrl: 'https://example.test/top_up' }
  act(() => { publish({ status: 'credential-stored', links,
    attempt: { id: 'completed' as NonNullable<AccountView['attempt']>['id'], phase: 'succeeded' } }) })
  expect(view.document.querySelector<HTMLElement>('#auth-page')!.hidden).toBe(false)
  act(() => { publish({ status: 'signed-out', links, attempt: null }) })
  expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
  expect(view.document.querySelector<HTMLElement>('#auth-page')!.hidden).toBe(true)
  await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}.expected.txt`)
})

it('reports each return to the welcome entry once, including account cancellation', async () => {
  const view = mount()
  expect(view.api.analytics).not.toHaveBeenCalled()
  await view.openSettings()
  fireEvent.click(view.button('#settings-back'))
  expect(view.api.analytics.mock.calls.map(([action]) => action)).toEqual(['auth_page_view'])
  const pending = Promise.withResolvers<AccountView>()
  view.api.startSignIn.mockReturnValueOnce(pending.promise)
  fireEvent.click(view.button('#sign-in'))
  await act(async () => { pending.resolve({ links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'signed-out', attempt: null }) })
  expect(view.api.analytics.mock.calls.map(([action]) => action)).toEqual(['auth_page_view', 'auth_page_click', 'auth_page_view'])
})
