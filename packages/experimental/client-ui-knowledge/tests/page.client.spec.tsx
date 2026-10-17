// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import type { KnowledgeBaseId, KnowledgeBaseSummary, KnowledgeCatalog } from '@deepseek-ai/dsh-experimental-knowledge/types'
import type { KnowledgeCatalogState } from '../src/client/catalog.ts'
import { KnowledgePage, type KnowledgePageInjected, type KnowledgePageProps } from '../src/client/KnowledgePage.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const id = 'kb_1' as KnowledgeBaseId
const base: KnowledgeBaseSummary = {
  id, name: '档案制度', mention: '@[档案制度](dsh-knowledge:kb_1)', directories: ['/docs/policy'], createdAt: 1, updatedAt: 1, uploadDirectory: '/home/.dsh/knowledge/bases/kb_1/files',
  status: {
    phase: 'ready', totalFiles: 3, indexedFiles: 2, failedFiles: 1, chunkCount: 9, vectorCount: 0, indexedAt: 1_700_000_000_000,
    watching: true, missingDirectories: [], fileLimitReached: false,
  },
}
const catalog: KnowledgeCatalog = { bases: [base], retrieval: 'bm25', maxUploadBytes: 10, extensions: ['.md', '.txt'] }
const home: DirectoryListing = {
  path: '/home/u', home: '/home/u', truncated: false,
  crumbs: [{ name: '/', path: '/', hidden: false }, { name: 'home', path: '/home', hidden: false }, { name: 'u', path: '/home/u', hidden: false }],
  entries: [{ name: 'notes', path: '/home/u/notes', hidden: false }, { name: '.cache', path: '/home/u/.cache', hidden: true }],
}

function setup(state: KnowledgeCatalogState, overrides: Partial<KnowledgePageInjected> = {}) {
  const store = createSnapshotStore(state)
  const actions = {
    create: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    reindex: vi.fn(async () => {}),
    listFiles: vi.fn(async () => ({
      files: [
        { path: '/docs/policy/a.md', root: '/docs/policy', size: 3, mtimeMs: 1, state: 'indexed' as const, chunks: 4, uploaded: false },
        { path: `${base.uploadDirectory}/b.md`, root: base.uploadDirectory, size: 3, mtimeMs: 1, state: 'failed' as const, chunks: 0, uploaded: true, error: 'bad' },
      ],
      truncated: true,
    })),
    uploadFile: vi.fn(async () => {}),
    deleteUpload: vi.fn(async () => {}),
    pickDirectory: vi.fn(async () => ({ kind: 'picked' as const, path: '/picked' })),
    listDirectory: vi.fn(async (path: string | undefined) => path === undefined ? home : { ...home, path: path, crumbs: [...home.crumbs, { name: 'notes', path, hidden: false }], entries: [] }),
    ask: vi.fn(),
    ...overrides,
  }
  const sessions: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  const workspaces: WorkspaceSnapshot = { items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }
  const props: KnowledgePageProps = {
    ...actions,
    useKnowledgeCatalog: bindSnapshotSelector(store),
    useSessions: select => select(sessions),
    useWorkspaces: select => select(workspaces),
    usePanelInfo: select => select({ activePanelId: null }),
    useSessionStatus: select => select(new Map()),
    useSessionRetainInfo: () => undefined,
    useResource: () => { throw new Error('The knowledge page does not load document resources') },
    ...allowAllAccess,
    t: makeTranslate(en),
  }
  return { actions, store, view: render(<KnowledgePage {...props} />) }
}

describe('KnowledgePage', () => {
  it('shows loading, transport failure, and the empty state', () => {
    const { store, view } = setup({ catalog: null, connected: false, error: null })
    expect(screen.getByRole('status').textContent).toBe(en.loading)
    act(() => { store.set({ catalog: null, connected: false, error: 'offline' }) })
    expect(screen.getByRole('status').textContent).toBe('Couldn’t load knowledge bases: offline')
    act(() => { store.set({ catalog: { ...catalog, bases: [] }, connected: true, error: null }) })
    expect(screen.getByText(en['empty.title'])).toBeTruthy()
    expect(screen.getByText(en['retrieval.bm25'])).toBeTruthy()
    view.unmount()
  })

  it('renders base status and runs ask, re-index, and delete actions', async () => {
    const { actions } = setup({ catalog: { ...catalog, retrieval: 'hybrid', embedder: 'hashed-ngram-256' }, connected: true, error: null })
    const card = screen.getByRole('article', { name: '档案制度' })
    expect(within(card).getByText('Ready')).toBeTruthy()
    expect(card.textContent).toContain('2/3 files · 9 passages')
    expect(card.textContent).toContain('1 files couldn’t be read')
    expect(screen.getByText('Retrieval: BM25 and vector (hashed-ngram-256) hybrid search')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: en['action.ask'] }))
    expect(actions.ask).toHaveBeenCalledWith('@[档案制度](dsh-knowledge:kb_1)', '档案制度')
    fireEvent.click(within(card).getByRole('button', { name: en['action.reindex'] }))
    expect(actions.reindex).toHaveBeenCalledWith(id)
    fireEvent.click(within(card).getByRole('button', { name: en['action.delete'] }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Delete knowledge base “档案制度”?')
    fireEvent.click(within(dialog).getByRole('button', { name: en['delete.confirm'] }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(actions.remove).toHaveBeenCalledWith(id)
  })

  it('keeps the delete dialog while deleting, cancels it, and reports a failed deletion', async () => {
    let reject!: (reason: unknown) => void
    const remove = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    setup({ catalog, connected: true, error: null }, { remove })
    fireEvent.click(screen.getByRole('button', { name: en['action.delete'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['delete.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['action.delete'] }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: en['delete.confirm'] }))
    fireEvent.click(within(dialog).getByRole('button', { name: en['delete.close'] }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { reject('in use') })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong: in use')
    fireEvent.click(screen.getByRole('button', { name: en['action.delete'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['delete.close'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports a failed action and lets the user dismiss it', async () => {
    setup({ catalog, connected: true, error: null }, { reindex: vi.fn(async () => { throw new Error('busy') }) })
    fireEvent.click(screen.getByRole('button', { name: en['action.reindex'] }))
    expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong: busy')
    fireEvent.click(screen.getByRole('button', { name: en['error.dismiss'] }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('creates a base from a name, a picked folder, a browsed folder, and a typed path', async () => {
    const pickDirectory = vi.fn()
      .mockResolvedValueOnce({ kind: 'picked', path: '/picked' })
      .mockResolvedValueOnce({ kind: 'browse' })
    const { actions } = setup({ catalog, connected: true, error: null }, { pickDirectory })
    fireEvent.click(screen.getByRole('button', { name: en.new }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: en['editor.create'] })).toHaveProperty('disabled', true)
    fireEvent.change(within(dialog).getByPlaceholderText(en['editor.namePlaceholder']), { target: { value: ' 新库 ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: en['editor.addDirectory'] }))
    await within(dialog).findByTitle('/picked')
    fireEvent.click(within(dialog).getByRole('button', { name: en['editor.addDirectory'] }))
    const browser = await screen.findByRole('dialog', { name: en['browser.title'] })
    expect(within(browser).queryByText('.cache')).toBeNull()
    fireEvent.click(within(browser).getByRole('button', { name: 'notes' }))
    await waitFor(() => { expect(within(browser).getByText(en['browser.empty'])).toBeTruthy() })
    fireEvent.click(within(browser).getByRole('button', { name: en['browser.select'] }))
    await within(dialog).findByTitle('/home/u/notes')
    const typed = within(dialog).getByPlaceholderText(en['editor.pathPlaceholder'])
    fireEvent.change(typed, { target: { value: '/typed' } })
    fireEvent.keyDown(typed, { key: 'Enter' })
    fireEvent.change(typed, { target: { value: '/picked' } })
    fireEvent.click(within(dialog).getByRole('button', { name: en['editor.addPath'] }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove folder /typed' }))
    fireEvent.click(within(dialog).getByRole('button', { name: en['editor.create'] }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(actions.create).toHaveBeenCalledWith({ name: '新库', directories: ['/picked', '/home/u/notes'] })
  })

  it('keeps the editor open with the Host message when saving fails, and edits an existing base', async () => {
    const update = vi.fn(async () => { throw new Error('duplicate name') })
    setup({ catalog, connected: true, error: null }, { update })
    fireEvent.click(screen.getByRole('button', { name: en['action.edit'] }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByDisplayValue('档案制度')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['editor.save'] }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('duplicate name')
    expect(update).toHaveBeenCalledWith({ id, name: '档案制度', directories: ['/docs/policy'] })
    fireEvent.click(within(dialog).getByRole('button', { name: en['editor.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists files, uploads supported files, rejects others, and removes added files', async () => {
    const { actions } = setup({ catalog, connected: true, error: null })
    fireEvent.click(screen.getByRole('button', { name: en['action.files'] }))
    const files = await screen.findByRole('region', { name: en['files.title'] })
    expect(within(files).getByText('4 passages')).toBeTruthy()
    expect(within(files).getByText('Couldn’t read: bad')).toBeTruthy()
    expect(within(files).getByText('Showing the first 2 files')).toBeTruthy()
    const input = within(files).getByLabelText(en['files.add']) as HTMLInputElement
    fireEvent.change(input, { target: { files: [
      new File(['hi'], 'note.md'),
      new File(['x'], 'image.png'),
      new File(['01234567890'], 'big.txt'),
    ] } })
    await waitFor(() => { expect(actions.uploadFile).toHaveBeenCalledWith(id, 'note.md', btoa('hi')) })
    expect((await screen.findAllByRole('alert')).map(alert => alert.textContent)).toEqual([
      'image.png is not a supported file type',
      'big.txt exceeds the 10B limit',
    ])
    fireEvent.click(within(files).getByRole('button', { name: 'Remove b.md' }))
    await waitFor(() => { expect(actions.deleteUpload).toHaveBeenCalledWith(id, `${base.uploadDirectory}/b.md`) })
    fireEvent.click(screen.getByRole('button', { name: en['action.hideFiles'] }))
    expect(screen.queryByRole('region', { name: en['files.title'] })).toBeNull()
  })

  it('has the same keys in both dictionaries', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
