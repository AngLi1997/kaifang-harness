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
    startBrowserSignIn: vi.fn(async () => ({ ok: false as const, reason: 'url-required' as const })),
    cancelBrowserSignIn: vi.fn(async () => {}),
    passwordSignIn: vi.fn(async () => ({ ok: true as const })),
    skip: vi.fn(async () => {}),
  }
  const view = render(<Welcome api={api} />)
  const button = (selector: string) => view.container.querySelector<HTMLButtonElement>(selector)!
  const url = () => view.container.querySelector<HTMLInputElement>('#shared-harness-url')!
  return { api, view, button, url }
}

describe('desktop Platform welcome', () => {
  it('saves the Platform origin without opening the Web Harness window', async () => {
    const { api, button, url } = mount('zh-CN', 'settings', 'https://harness.example')
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(url().value).toBe('https://harness.example')
    fireEvent.change(url(), { target: { value: 'https://new-harness.example' } })
    await act(async () => { fireEvent.click(button('#save-settings')) })
    expect(api.saveSharedHarnessUrl).toHaveBeenCalledExactlyOnceWith('https://new-harness.example')
    expect(api.startBrowserSignIn).not.toHaveBeenCalled()
    expect(button('#start-browser-sign-in')).toBeTruthy()
  })

  it.each(['zh-CN', 'en'])('shows browser sign-in and local workspace in %s', (language) => {
    const { view, api } = mount(language)
    expect(view.container.ownerDocument.documentElement.lang).toBe(language)
    expect(screen.getByRole('button', { name: resolveDesktopLocale(language).messages.welcomeSignIn })).toBeTruthy()
    expect(screen.getByRole('button', { name: resolveDesktopLocale(language).messages.openLocalWorkspaceMenu })).toBeTruthy()
    expect(api.startBrowserSignIn).not.toHaveBeenCalled()
  })

  it('opens settings when Platform origin is missing for browser sign-in', async () => {
    const { api, view, button, url } = mount()
    await act(async () => { fireEvent.click(button('#start-browser-sign-in')) })
    expect(api.startBrowserSignIn).toHaveBeenCalledOnce()
    expect(api.readSharedHarnessUrl).toHaveBeenCalledOnce()
    expect(view.container.querySelector('#settings-title')).toBeTruthy()
    expect(url().readOnly).toBe(false)
  })

  it('starts browser sign-in from the primary action', async () => {
    const { api, button } = mount('en')
    vi.mocked(api.startBrowserSignIn).mockResolvedValue({ ok: true })
    await act(async () => { fireEvent.click(button('#start-browser-sign-in')) })
    expect(api.startBrowserSignIn).toHaveBeenCalledOnce()
  })
})
