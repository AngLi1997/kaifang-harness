// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Welcome } from '../src/client/WelcomePage.tsx'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { WelcomeApi } from '../src/welcome-api.ts'

afterEach(cleanup)

function mount(language = 'zh-CN', initialPage: WelcomeApi['initialPage'] = 'entry', configuredUrl = '') {
  const api: WelcomeApi = {
    ...resolveDesktopLocale(language),
    initialPage,
    readSharedHarnessUrl: vi.fn(async () => configuredUrl),
    saveSharedHarnessUrl: vi.fn(async (value: string) => ({ ok: true as const, url: value })),
    openSharedHarness: vi.fn(async () => false),
    passwordSignIn: vi.fn(async () => ({ ok: true as const })),
    skip: vi.fn(async () => {}),
  }
  const view = render(<Welcome api={api} />)
  const button = (selector: string) => view.container.querySelector<HTMLButtonElement>(selector)!
  const url = () => view.container.querySelector<HTMLInputElement>('#shared-harness-url')!
  return { api, view, button, url }
}

describe('desktop shared Harness welcome', () => {
  it('allows editing and saving the Host URL to start Platform sign-in', async () => {
    const { api, view, button, url } = mount('zh-CN', 'settings', 'https://harness.example')
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(url().value).toBe('https://harness.example')
    expect(url().readOnly).toBe(false)
    fireEvent.change(url(), { target: { value: 'https://new-harness.example' } })
    vi.mocked(api.openSharedHarness).mockResolvedValue(true)
    await act(async () => { fireEvent.click(button('#save-settings')) })
    expect(api.saveSharedHarnessUrl).toHaveBeenCalledExactlyOnceWith('https://new-harness.example')
    expect(api.openSharedHarness).toHaveBeenCalledOnce()
    expect(view.container.querySelector('#settings-title')?.textContent).toBe(resolveDesktopLocale('zh-CN').messages.welcomeSettingsTitle)
  })

  it.each(['zh-CN', 'en'])('shows platform and password entry options in %s', (language) => {
    const { view, api } = mount(language)
    expect(view.container.ownerDocument.documentElement.lang).toBe(language)
    expect(screen.getByRole('button', { name: resolveDesktopLocale(language).messages.welcomeSignIn })).toBeTruthy()
    expect(screen.getByRole('button', { name: resolveDesktopLocale(language).messages.welcomePasswordSignIn })).toBeTruthy()
    expect(api.openSharedHarness).not.toHaveBeenCalled()
  })

  it('shows deployment configuration when the Platform entry is unavailable and keeps password login available', async () => {
    const { api, view, button, url } = mount()
    await act(async () => { fireEvent.click(button('#open-shared-harness')) })
    expect(api.openSharedHarness).toHaveBeenCalledOnce()
    expect(api.readSharedHarnessUrl).toHaveBeenCalledOnce()
    expect(view.container.querySelector('#settings-title')).toBeTruthy()
    expect(url().readOnly).toBe(false)
    expect(button('#save-settings')).toBeTruthy()
    await act(async () => { fireEvent.click(button('#settings-back')) })
    expect(button('#password-sign-in')).toBeTruthy()
  })

  it('opens the configured shared Host from the sign-in action', async () => {
    const { api, button } = mount('en')
    vi.mocked(api.openSharedHarness).mockResolvedValue(true)
    await act(async () => { fireEvent.click(button('#open-shared-harness')) })
    expect(api.openSharedHarness).toHaveBeenCalledOnce()
    expect(api.readSharedHarnessUrl).not.toHaveBeenCalled()
  })

  it('submits editable account and password fields through the native login page', async () => {
    const { api, view, button } = mount()
    const username = view.container.querySelector<HTMLInputElement>('#username')!
    const password = view.container.querySelector<HTMLInputElement>('#password')!
    await act(async () => { fireEvent.click(button('#password-sign-in')) })
    fireEvent.change(username, { target: { value: 'admin' } })
    fireEvent.change(password, { target: { value: 'secret' } })
    await act(async () => { fireEvent.click(button('#submit-password')) })
    expect(api.passwordSignIn).toHaveBeenCalledExactlyOnceWith({ username: 'admin', password: 'secret' })
    expect(password.value).toBe('')
  })
})
