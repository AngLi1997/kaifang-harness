// @vitest-environment jsdom
/** Plain-browser KaifangLab sign-in page: one-click and password choices, password errors, and system settings. */
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KaifangWebSignIn, type KaifangWebSignInInjected } from '../src/client/KaifangWebSignIn.tsx'
import type { KaifangPasswordResult, KaifangWebState } from '../src/client/kaifang-web.ts'
import { en, zh, type AccountKey } from '../src/client/locales.ts'

let appRoot: HTMLDivElement

beforeEach(() => {
  appRoot = document.createElement('div')
  appRoot.id = 'root'
  document.body.append(appRoot)
})

afterEach(() => {
  cleanup()
  appRoot.remove()
})

function mount(state: KaifangWebState, copy: typeof en | typeof zh = zh) {
  const operations = {
    connection: vi.fn(() => ({ systemUrl: 'http://127.0.0.1:9999', webUrl: 'http://localhost:5173', authCode: '' })),
    saveConnection: vi.fn<KaifangWebSignInInjected['saveConnection']>(value => value.authCode === ''
      ? { ok: false, reason: 'auth-code-required' } : { ok: true }),
    passwordSignIn: vi.fn(async (): Promise<KaifangPasswordResult> => ({ ok: false, reason: 'invalid-credentials' })),
    startBrowserSignIn: vi.fn(),
    cancelBrowserSignIn: vi.fn(),
  }
  const view = render(<KaifangWebSignIn {...({} as GlobalStandardProps)} {...operations}
    useKaifang={selector => selector(state)} t={key => copy[key as AccountKey]} />)
  return { ...operations, view }
}

it('offers one-click and password sign-in while signed out and covers the workspace', () => {
  const { startBrowserSignIn } = mount({ account: null, browser: { phase: 'idle' } })
  expect(screen.getByRole('heading', { name: zh.kaifangSignInTitle })).toBeTruthy()
  expect(appRoot.inert).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: zh.kaifangBrowserSignIn }))
  expect(startBrowserSignIn).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: zh.kaifangPasswordSignIn })).toBeTruthy()
})

it('renders nothing once an account is signed in', () => {
  mount({ account: { username: 'admin', displayName: '超级管理员', email: null, avatarUrl: null }, browser: { phase: 'idle' } })
  expect(screen.queryByRole('heading')).toBeNull()
  expect(appRoot.inert).not.toBe(true)
})

it('shows the waiting page with a link to reopen the authorization page and cancels it', () => {
  const url = 'http://localhost:5173/authorize?state=s'
  const { cancelBrowserSignIn } = mount({ account: null, browser: { phase: 'waiting', url } }, en)
  expect(screen.getByRole('heading', { name: en.kaifangWaitingTitle })).toBeTruthy()
  expect(screen.getByRole('link', { name: en.kaifangOpenPage }).getAttribute('href')).toBe(url)
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(cancelBrowserSignIn).toHaveBeenCalledOnce()
})

it('reports a failed browser sign-in with the choices still available', () => {
  mount({ account: null, browser: { phase: 'failed' } })
  expect(screen.getByRole('alert').textContent).toBe(zh.kaifangBrowserFailed)
  expect(screen.getByRole('button', { name: zh.kaifangBrowserSignIn })).toBeTruthy()
})

it('submits the password form and shows the localized failure', async () => {
  const { passwordSignIn } = mount({ account: null, browser: { phase: 'idle' } })
  fireEvent.click(screen.getByRole('button', { name: zh.kaifangPasswordSignIn }))
  fireEvent.change(screen.getByRole('textbox', { name: zh.kaifangUsername }), { target: { value: 'admin' } })
  fireEvent.change(screen.getByLabelText(`${zh.kaifangPassword}*`), { target: { value: 'wrong' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.kaifangPasswordSubmit })) })
  expect(passwordSignIn).toHaveBeenCalledExactlyOnceWith({ username: 'admin', password: 'wrong' })
  expect(screen.getByRole('alert').textContent).toBe(zh.kaifangPasswordInvalid)
  fireEvent.click(screen.getByRole('button', { name: zh.kaifangBack }))
  expect(screen.getByRole('heading', { name: zh.kaifangSignInTitle })).toBeTruthy()
})

it('validates and saves the system settings before returning to the choices', () => {
  const { saveConnection, cancelBrowserSignIn } = mount({ account: null, browser: { phase: 'idle' } })
  fireEvent.click(screen.getByRole('button', { name: zh.kaifangSettings }))
  expect(cancelBrowserSignIn).toHaveBeenCalledOnce()
  expect((screen.getByLabelText(zh.kaifangSystemUrl, { exact: false }) as HTMLInputElement).value).toBe('http://127.0.0.1:9999')
  fireEvent.click(screen.getByRole('button', { name: zh.kaifangSettingsSave }))
  expect(screen.getByRole('alert').textContent).toBe(zh.kaifangAuthCodeRequired)
  fireEvent.change(screen.getByLabelText(zh.kaifangAuthCode, { exact: false }), { target: { value: 'code' } })
  fireEvent.click(screen.getByRole('button', { name: zh.kaifangSettingsSave }))
  expect(saveConnection).toHaveBeenLastCalledWith({ systemUrl: 'http://127.0.0.1:9999', webUrl: 'http://localhost:5173', authCode: 'code' })
  expect(screen.getByRole('heading', { name: zh.kaifangSignInTitle })).toBeTruthy()
  expect(screen.getByText(zh.kaifangSettingsSaved)).toBeTruthy()
})

it('starts again from the choices after a sign-in and a later sign-out', () => {
  const signedOut: KaifangWebState = { account: null, browser: { phase: 'idle' } }
  const { view } = mount(signedOut)
  fireEvent.click(screen.getByRole('button', { name: zh.kaifangPasswordSignIn }))
  fireEvent.change(screen.getByLabelText(`${zh.kaifangPassword}*`), { target: { value: 'secret' } })
  const props = (state: KaifangWebState) => <KaifangWebSignIn {...({} as GlobalStandardProps)} connection={vi.fn()} saveConnection={vi.fn()}
    passwordSignIn={vi.fn()} startBrowserSignIn={vi.fn()} cancelBrowserSignIn={vi.fn()}
    useKaifang={selector => selector(state)} t={key => zh[key as AccountKey]} />
  view.rerender(props({ account: { username: 'admin', displayName: '超级管理员', email: null, avatarUrl: null }, browser: { phase: 'idle' } }))
  expect(screen.queryByRole('heading')).toBeNull()
  view.rerender(props(signedOut))
  expect(screen.getByRole('heading', { name: zh.kaifangSignInTitle })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.kaifangPasswordSignIn }))
  expect((screen.getByLabelText(`${zh.kaifangPassword}*`) as HTMLInputElement).value).toBe('')
})

it('ignores a second submit while a password sign-in is running and marks a missing account', async () => {
  const pending = Promise.withResolvers<KaifangPasswordResult>()
  const { passwordSignIn } = mount({ account: null, browser: { phase: 'idle' } })
  passwordSignIn.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ok: false, reason: 'username-required' })
  fireEvent.click(screen.getByRole('button', { name: zh.kaifangPasswordSignIn }))
  const form = screen.getByRole('button', { name: zh.kaifangPasswordSubmit }).closest('form')!
  await act(async () => { fireEvent.submit(form); fireEvent.submit(form) })
  expect(passwordSignIn).toHaveBeenCalledOnce()
  await act(async () => { pending.resolve({ ok: true }) })
  expect(screen.queryByRole('alert')).toBeNull()
  await act(async () => { fireEvent.submit(form) })
  expect(screen.getByRole('alert').textContent).toBe(zh.kaifangUsernameRequired)
  expect(screen.getByRole('textbox', { name: zh.kaifangUsername }).getAttribute('aria-invalid')).toBe('true')
})

it('shows the completing state without the choices', () => {
  mount({ account: null, browser: { phase: 'completing' } })
  expect(screen.getByRole('heading', { name: zh.kaifangCompleting })).toBeTruthy()
  expect(screen.getByRole('button', { name: zh.cancel }).hasAttribute('disabled')).toBe(true)
})

it.each([
  ['url-invalid', zh.kaifangSystemUrl, zh.kaifangUrlInvalid],
  ['web-url-required', zh.kaifangWebUrl, zh.kaifangWebUrlRequired],
  ['write-failed', zh.kaifangAuthCode, zh.kaifangSettingsFailed],
] as const)('places the %s settings failure on its field', (reason, label, message) => {
  const { saveConnection } = mount({ account: null, browser: { phase: 'idle' } })
  saveConnection.mockReturnValueOnce({ ok: false, reason })
  fireEvent.click(screen.getByRole('button', { name: zh.kaifangSettings }))
  fireEvent.click(screen.getByRole('button', { name: zh.kaifangSettingsSave }))
  expect(screen.getByRole('alert').textContent).toBe(message)
  expect(screen.getByRole('alert').previousElementSibling?.querySelector('input')?.id)
    .toBe(screen.getByLabelText(label, { exact: false }).id)
})

it('edits every system setting, leaves Settings with Back, and dismisses the saved notice', () => {
  vi.useFakeTimers()
  try {
    const { saveConnection } = mount({ account: null, browser: { phase: 'idle' } })
    fireEvent.click(screen.getByRole('button', { name: zh.kaifangSettings }))
    fireEvent.change(screen.getByLabelText(zh.kaifangSystemUrl, { exact: false }), { target: { value: 'http://lab.test' } })
    fireEvent.change(screen.getByLabelText(zh.kaifangWebUrl, { exact: false }), { target: { value: 'http://web.test' } })
    fireEvent.click(screen.getByRole('button', { name: zh.kaifangBack }))
    expect(saveConnection).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.kaifangSettings }))
    fireEvent.change(screen.getByLabelText(zh.kaifangSystemUrl, { exact: false }), { target: { value: 'http://lab.test' } })
    fireEvent.change(screen.getByLabelText(zh.kaifangWebUrl, { exact: false }), { target: { value: 'http://web.test' } })
    fireEvent.change(screen.getByLabelText(zh.kaifangAuthCode, { exact: false }), { target: { value: 'code' } })
    fireEvent.click(screen.getByRole('button', { name: zh.kaifangSettingsSave }))
    expect(saveConnection).toHaveBeenCalledExactlyOnceWith({ systemUrl: 'http://lab.test', webUrl: 'http://web.test', authCode: 'code' })
    expect(screen.getByText(zh.kaifangSettingsSaved)).toBeTruthy()
    act(() => { vi.runAllTimers() })
    expect(screen.queryByText(zh.kaifangSettingsSaved)).toBeNull()
  } finally { vi.useRealTimers() }
})
