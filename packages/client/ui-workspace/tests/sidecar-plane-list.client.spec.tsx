// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SidecarPlaneList } from '../src/client/host-planes/SidecarPlaneList.tsx'
import { dualPlaneStore } from '../src/client/host-planes/store.ts'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh, commonZh) as never

const emptySnapshot = {
  cloudOnline: false,
  cloudShellEmpty: false,
  activePlane: 'local' as const,
  sidecarApiPrefix: undefined,
  sidecarWorkspaces: [],
  sidecarSessions: [],
  sidecarModelGroups: [],
  disconnectToastSeq: 0,
}

afterEach(() => {
  cleanup()
  dualPlaneStore.set(emptySnapshot)
})

it('filters sessions by title and keeps a workspace whose name matches', () => {
  dualPlaneStore.set({
    ...emptySnapshot,
    sidecarWorkspaces: [
      { workspaceId: 'ws', title: 'kaifang-harness' },
      { workspaceId: 'docs', title: 'docs' },
    ],
    sidecarSessions: [
      { sessionId: 's1', title: '你好', workspaceId: 'ws' },
      { sessionId: 's2', title: 'Greeting', workspaceId: 'docs' },
    ],
  })
  const { rerender } = render(
    <SidecarPlaneList
      plane="cloud"
      emptyLabel="没有会话"
      untitledLabel="未命名"
      defaultWorkspaceName="默认工作区"
      query="你好"
      noMatchesLabel="无匹配会话"
      t={t}
      onOpenSession={() => {}}
    />,
  )
  expect(screen.getByText('你好')).toBeTruthy()
  expect(screen.queryByText('Greeting')).toBeNull()
  rerender(
    <SidecarPlaneList
      plane="cloud"
      emptyLabel="没有会话"
      untitledLabel="未命名"
      defaultWorkspaceName="默认工作区"
      query="docs"
      noMatchesLabel="无匹配会话"
      t={t}
      onOpenSession={() => {}}
    />,
  )
  expect(screen.getByText('Greeting')).toBeTruthy()
  rerender(
    <SidecarPlaneList
      plane="cloud"
      emptyLabel="没有会话"
      untitledLabel="未命名"
      defaultWorkspaceName="默认工作区"
      query="没有这个"
      noMatchesLabel="无匹配会话"
      t={t}
      onOpenSession={() => {}}
    />,
  )
  expect(screen.getByText('无匹配会话')).toBeTruthy()
})

it('shows an empty label when the inactive Host has no workspaces', () => {
  dualPlaneStore.set(emptySnapshot)
  render(
    <SidecarPlaneList
      plane="cloud"
      emptyLabel="没有会话"
      untitledLabel="未命名"
      defaultWorkspaceName="默认工作区"
      t={t}
      onOpenSession={() => {}}
    />,
  )
  expect(screen.getByText('没有会话')).toBeTruthy()
})

it('renders folder rows, relative time, and opens or collapses a session', () => {
  dualPlaneStore.set({
    ...emptySnapshot,
    sidecarWorkspaces: [
      { workspaceId: 'ws', title: 'kaifang-harness' },
      { workspaceId: 'empty', title: 'empty' },
    ],
    sidecarSessions: [
      { sessionId: 's1', title: '你好', workspaceId: 'ws', updatedAt: Date.now() - 60_000 },
      { sessionId: 's2', title: '', workspaceId: 'ws' },
      { sessionId: 's3', title: '刚才', workspaceId: 'ws', updatedAt: Date.now() },
    ],
  })
  const onOpen = vi.fn()
  render(
    <SidecarPlaneList
      plane="cloud"
      emptyLabel="没有会话"
      untitledLabel="未命名"
      defaultWorkspaceName="默认工作区"
      t={t}
      onOpenSession={onOpen}
    />,
  )
  expect(screen.getByText('kaifang-harness')).toBeTruthy()
  expect(screen.getByText('你好')).toBeTruthy()
  expect(screen.getByText('未命名')).toBeTruthy()
  expect(screen.getByText('1分钟')).toBeTruthy()
  expect(screen.getByText('刚刚')).toBeTruthy()
  fireEvent.click(screen.getByText('你好'))
  expect(onOpen).toHaveBeenCalledWith('s1' as SessionId)
  const untitled = screen.getByText('未命名')
  fireEvent.keyDown(untitled, { key: 'Enter' })
  fireEvent.keyDown(untitled.closest('[role="treeitem"]')!, { key: 'Enter' })
  expect(onOpen).toHaveBeenCalledWith('s2' as SessionId)
  fireEvent.keyDown(screen.getByText('你好').closest('[role="treeitem"]')!, { key: ' ' })
  fireEvent.click(screen.getByText('kaifang-harness'))
  expect(screen.queryByText('你好')).toBeNull()
  fireEvent.click(screen.getByText('empty'))
  expect(screen.getByText('empty').closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true')
})
