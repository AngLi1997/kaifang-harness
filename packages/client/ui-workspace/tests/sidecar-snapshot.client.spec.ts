import { expect, it } from 'vitest'
import { groupSidecarSessions, readSidecarSnapshot } from '../src/client/host-planes/sidecar-rpc.ts'

it('keeps stored titles and drops directory names, blanks, and subagents', () => {
  const snapshot = readSidecarSnapshot(
    {
      items: [{
        workspaceId: 'ws-default',
        title: 'default-workspace',
        sessionIds: ['titled', 'untitled', 'blank', 'gone', 'unlisted'],
      }, { title: 'missing-id' }],
      deletedSessionIds: ['gone'],
    },
    {
      items: [
        {
          sessionId: 'titled',
          cwd: '/cloud/default-workspace',
          updatedAt: 1_700_000_000_000,
          projections: { values: { title: 'Welcome and Greeting', sessionListMetadata: { blank: false } } },
        },
        {
          sessionId: 'untitled',
          cwd: '/cloud/default-workspace',
          updatedAt: 'not-a-time',
          projections: { values: { title: '   ', sessionListMetadata: { blank: false } } },
        },
        {
          sessionId: 'blank',
          cwd: '/cloud/default-workspace',
          projections: { values: { sessionListMetadata: { blank: true } } },
        },
        { sessionId: 'child', origin: 'subagent', cwd: '/cloud/default-workspace' },
        { sessionId: 'loose', projections: { values: { title: { text: 'not a string' } } } },
        { projections: { values: { title: 'ignored' } } },
      ],
    },
  )
  expect(snapshot.sessions).toEqual([
    { sessionId: 'titled', title: 'Welcome and Greeting', workspaceId: 'ws-default', updatedAt: 1_700_000_000_000 },
    { sessionId: 'untitled', title: '', workspaceId: 'ws-default' },
    { sessionId: 'unlisted', title: '', workspaceId: 'ws-default' },
    { sessionId: 'loose', title: '' },
  ])
  expect(readSidecarSnapshot({ items: [] }, undefined).sessions).toEqual([])
})

it('labels the default workspace once and keeps other workspace titles', () => {
  const groups = groupSidecarSessions(
    [
      { workspaceId: 'ws-default', title: 'default-workspace' },
      { workspaceId: 'ws-docs', title: 'docs' },
      { workspaceId: 'ws-empty', title: 'empty' },
      { workspaceId: 'ws-default-2', title: 'default-workspace' },
    ],
    [
      { sessionId: 'in-default', title: 'Hello', workspaceId: 'ws-default' },
      { sessionId: 'loose', title: '' },
      { sessionId: 'in-docs', title: 'Spec', workspaceId: 'ws-docs' },
    ],
    '默认工作区',
  )
  expect(groups).toEqual([
    {
      key: 'default',
      title: '默认工作区',
      sessions: [
        { sessionId: 'in-default', title: 'Hello', workspaceId: 'ws-default' },
        { sessionId: 'loose', title: '' },
      ],
    },
    {
      key: 'ws-docs',
      title: 'docs',
      sessions: [{ sessionId: 'in-docs', title: 'Spec', workspaceId: 'ws-docs' }],
    },
    { key: 'ws-empty', title: 'empty', sessions: [] },
  ])
})

it('still shows sessions that belong to no workspace', () => {
  expect(groupSidecarSessions(
    [],
    [{ sessionId: 'loose', title: 'Only' }],
    'Default workspace',
  )).toEqual([{
    key: 'default',
    title: 'Default workspace',
    sessions: [{ sessionId: 'loose', title: 'Only' }],
  }])
})
