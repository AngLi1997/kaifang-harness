// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import type { KnowledgeBaseId, KnowledgeBaseSummary, KnowledgeFilePage } from '@deepseek-ai/dsh-experimental-knowledge/types'
import { BaseCard, type BaseCardProps } from '../src/client/BaseCard.tsx'
import { BaseEditor, type BaseEditorProps } from '../src/client/BaseEditor.tsx'
import { DirectoryBrowser } from '../src/client/DirectoryBrowser.tsx'
import { KnowledgeIcon } from '../src/client/KnowledgeIcon.tsx'
import { KnowledgeMention } from '../src/client/KnowledgeMention.tsx'
import { baseName } from '../src/client/draft.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup() })
const t = makeTranslate(en)
const base: KnowledgeBaseSummary = {
  id: 'kb_1' as KnowledgeBaseId, name: 'K', mention: '@[K](dsh-knowledge:kb_1)', directories: [], createdAt: 1, updatedAt: 1, uploadDirectory: '/u',
  status: {
    phase: 'error', totalFiles: 1, indexedFiles: 0, failedFiles: 0, chunkCount: 0, vectorCount: 4,
    watching: false, missingDirectories: ['/gone'], fileLimitReached: true,
  },
}

function card(overrides: Partial<BaseCardProps> = {}) {
  const props: BaseCardProps = {
    base, extensions: ['.md'], maxUploadBytes: 100, t,
    onAsk: vi.fn(), onEdit: vi.fn(), onReindex: vi.fn(), onDelete: vi.fn(),
    listFiles: vi.fn(async () => ({ files: [], truncated: false })),
    uploadFile: vi.fn(async () => {}), deleteUpload: vi.fn(async () => {}),
    ...overrides,
  }
  render(<BaseCard {...props} />)
  return props
}

describe('BaseCard', () => {
  it('shows failure, vector, missing-folder, and limit facts', () => {
    card()
    expect(screen.getByText(/^Indexing failed:\s*$/u)).toBeTruthy()
    expect(screen.getByText(/· 4 vectors/u)).toBeTruthy()
    expect(screen.getByText(en['card.noDirectories'])).toBeTruthy()
    expect(screen.getByText('Folders not found: /gone')).toBeTruthy()
    expect(screen.getByText(en['card.limit'])).toBeTruthy()
    cleanup()
    card({ base: { ...base, status: { ...base.status, error: 'disk full' } } })
    expect(screen.getByText('Indexing failed: disk full')).toBeTruthy()
  })

  it('reports listing, upload, and removal failures and shows loading and pending files', async () => {
    let finish!: (page: KnowledgeFilePage) => void
    const listFiles = vi.fn()
      .mockRejectedValueOnce('offline')
      .mockImplementationOnce(() => new Promise<KnowledgeFilePage>((resolve) => { finish = resolve }))
      .mockResolvedValue({
        files: [{ path: '/u/a.md', root: '/u', size: 1, mtimeMs: 1, state: 'pending', chunks: 0, uploaded: true },
          { path: '/u/b.md', root: '/u', size: 1, mtimeMs: 1, state: 'failed', chunks: 0, uploaded: true }],
        truncated: false,
      })
    const props = card({
      listFiles,
      uploadFile: vi.fn(async () => { throw new Error('too big') }),
      deleteUpload: vi.fn(async () => { throw new Error('locked') }),
    })
    fireEvent.click(screen.getByRole('button', { name: en['action.files'] }))
    expect(await screen.findByText('Something went wrong: offline')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['action.files'] }))
    expect(screen.getByRole('status').textContent).toBe(en['files.loading'])
    await act(async () => { finish({ files: [], truncated: false }) })
    expect(screen.getByText(en['files.empty'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['files.refresh'] }))
    expect(await screen.findByText(en['files.pending'])).toBeTruthy()
    expect(screen.getByText(/^Couldn’t read:\s*$/u)).toBeTruthy()
    const input = screen.getByLabelText(en['files.add'])
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: en['files.add'] }))
    expect(click).toHaveBeenCalledOnce()
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.md')] } })
    expect(await screen.findByText('Something went wrong: too big')).toBeTruthy()
    fireEvent.change(input, { target: { files: null } })
    fireEvent.click((await screen.findAllByRole('button', { name: 'Remove a.md' }))[0] as HTMLElement)
    await waitFor(() => { expect(props.deleteUpload).toHaveBeenCalledWith('/u/a.md') })
    expect(await screen.findByText('Something went wrong: locked')).toBeTruthy()
  })
})

const listing: DirectoryListing = {
  path: '/a/b', home: '/a', truncated: true,
  crumbs: [{ name: '/', path: '/', hidden: false }, { name: 'a', path: '/a', hidden: false }, { name: 'b', path: '/a/b', hidden: false }],
  entries: [],
}

describe('DirectoryBrowser', () => {
  it('navigates by crumb and parent, reports listing failures, and cancels', async () => {
    const listDirectory = vi.fn()
      .mockRejectedValueOnce(new Error('denied'))
      .mockRejectedValueOnce('denied again')
      .mockResolvedValue({ ...listing, path: '/', crumbs: [{ name: '/', path: '/', hidden: false }] })
    const onCancel = vi.fn()
    render(<DirectoryBrowser listing={listing} t={t} listDirectory={listDirectory} onSelect={vi.fn()} onCancel={onCancel} />)
    expect(screen.getByText(en['browser.truncated'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['browser.up'] }))
    expect(await screen.findByText('Something went wrong: denied')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    expect(await screen.findByText('Something went wrong: denied again')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '/' }))
    await waitFor(() => { expect(screen.queryByRole('button', { name: en['browser.up'] })).toBeNull() })
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'a' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })
})

describe('BaseEditor', () => {
  it('handles cancelled and failed choosers, ignores blank paths, closes, and cancels a browser', async () => {
    const props: BaseEditorProps = {
      initial: undefined, t,
      pickDirectory: vi.fn()
        .mockResolvedValueOnce({ kind: 'cancelled' })
        .mockRejectedValueOnce('no chooser')
        .mockResolvedValueOnce({ kind: 'browse' }),
      listDirectory: vi.fn(async () => listing),
      onCancel: vi.fn(),
      onSubmit: vi.fn(async () => { throw 'rejected' }),
    }
    render(<BaseEditor {...props} />)
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: en['editor.addDirectory'] }))
    await waitFor(() => { expect(props.pickDirectory).toHaveBeenCalledOnce() })
    expect(within(dialog).getByText(en['editor.noDirectories'])).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['editor.addDirectory'] }))
    expect(await within(dialog).findByText('Something went wrong: no chooser')).toBeTruthy()
    const typed = within(dialog).getByPlaceholderText(en['editor.pathPlaceholder'])
    fireEvent.change(typed, { target: { value: '   ' } })
    fireEvent.keyDown(typed, { key: 'Enter' })
    fireEvent.keyDown(typed, { key: 'x' })
    expect(within(dialog).getByText(en['editor.noDirectories'])).toBeTruthy()
    fireEvent.change(within(dialog).getByPlaceholderText(en['editor.namePlaceholder']), { target: { value: 'n' } })
    fireEvent.submit(dialog.querySelector('form') as HTMLFormElement)
    expect(await within(dialog).findByText('Something went wrong: rejected')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['editor.addDirectory'] }))
    const browser = await screen.findByRole('dialog', { name: en['browser.title'] })
    fireEvent.click(within(browser).getByRole('button', { name: en['browser.cancel'] }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: en['browser.title'] })).toBeNull() })
    let settle!: () => void
    vi.mocked(props.onSubmit).mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve }))
    fireEvent.submit(dialog.querySelector('form') as HTMLFormElement)
    fireEvent.click(within(dialog).getByRole('button', { name: en['editor.close'] }))
    expect(props.onCancel).not.toHaveBeenCalled()
    await act(async () => { settle() })
    fireEvent.click(within(dialog).getByRole('button', { name: en['editor.close'] }))
    expect(props.onCancel).toHaveBeenCalledOnce()
  })
})

describe('small components', () => {
  it('renders the sidebar glyph and an interactive or static mention chip', () => {
    const unread = (): never => { throw new Error('The sidebar icon must not read application state') }
    const { container } = render(<KnowledgeIcon
      size={16} active={false} usePanelInfo={unread} useSessions={unread} useWorkspaces={unread}
      useResource={unread} useSessionStatus={unread} useSessionRetainInfo={unread} {...allowAllAccess}
    />)
    expect(container.querySelector('svg')).toBeTruthy()
    const openPage = vi.fn()
    const mention = (interactive: boolean) => ({
      node: { id: 'knowledge', start: 0, end: 5, data: { label: 'K', id: 'kb_1' } },
      raw: '@[K](dsh-knowledge:kb_1)', interactive, openPage,
    }) as ComponentProps<typeof KnowledgeMention>
    const { rerender } = render(<KnowledgeMention {...mention(true)} />)
    fireEvent.click(screen.getByRole('button', { name: 'K' }))
    expect(openPage).toHaveBeenCalledOnce()
    rerender(<KnowledgeMention {...mention(false)} />)
    expect(screen.queryByRole('button', { name: 'K' })).toBeNull()
    expect(baseName('/')).toBe('/')
  })
})
