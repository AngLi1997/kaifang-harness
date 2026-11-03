/** Compact inactive-plane session list (sidecar snapshot; ops stay on that plane after switch). */

import { useSyncExternalStore, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './host-planes.module.css'
import { dualPlaneStore, setActivePlane } from './store.ts'
import type { HostPlaneId } from './types.ts'

export function PlaneHeader({
  plane,
  active,
  label,
  currentLabel,
}: {
  plane: HostPlaneId
  active: boolean
  label: string
  currentLabel: string
}): ReactNode {
  return (
    <div className={`${css.planeHeader}${active ? ` ${css.planeHeaderActive}` : ''}`} data-host-plane={plane}>
      <span>{label}</span>
      {active ? <span className={css.planeBadge}>{currentLabel}</span> : null}
    </div>
  )
}

export function SidecarPlaneList({
  plane,
  emptyLabel,
  ungroupedLabel,
  onOpenSession,
}: {
  plane: HostPlaneId
  emptyLabel: string
  ungroupedLabel: string
  onOpenSession: (sessionId: SessionId) => void
}): ReactNode {
  const snapshot = useSyncExternalStore(
    fn => dualPlaneStore.subscribe(fn),
    () => dualPlaneStore.getSnapshot(),
  )
  const sessionsByWorkspace = new Map<string, (typeof snapshot.sidecarSessions)[number][]>()
  const ungrouped: (typeof snapshot.sidecarSessions)[number][] = []
  for (const session of snapshot.sidecarSessions) {
    if (session.workspaceId === undefined) {
      ungrouped.push(session)
      continue
    }
    const rows = sessionsByWorkspace.get(session.workspaceId) ?? []
    rows.push(session)
    sessionsByWorkspace.set(session.workspaceId, rows)
  }
  if (snapshot.sidecarWorkspaces.length === 0 && snapshot.sidecarSessions.length === 0) {
    return <div className={css.sidecarEmpty}>{emptyLabel}</div>
  }
  return (
    <div className={css.sidecarList} data-host-plane={plane}>
      {snapshot.sidecarWorkspaces.map(workspace => (
        <section className={css.sidecarWorkspace} key={workspace.workspaceId}>
          <div className={css.sidecarWorkspaceTitle}>{workspace.title}</div>
          {(sessionsByWorkspace.get(workspace.workspaceId) ?? []).map(row => (
            <button
              key={row.sessionId}
              type="button"
              className={css.sidecarRow}
              onClick={() => {
                void setActivePlane(plane).then(() => {
                  onOpenSession(row.sessionId as SessionId)
                })
              }}
            >
              <span className={css.sidecarTitle}>{row.title}</span>
            </button>
          ))}
        </section>
      ))}
      {ungrouped.length > 0 && (
        <section className={css.sidecarWorkspace}>
          <div className={css.sidecarWorkspaceTitle}>{ungroupedLabel}</div>
          {ungrouped.map(row => (
            <button
              key={row.sessionId}
              type="button"
              className={css.sidecarRow}
              onClick={() => {
                void setActivePlane(plane).then(() => {
                  onOpenSession(row.sessionId as SessionId)
                })
              }}
            >
              <span className={css.sidecarTitle}>{row.title}</span>
            </button>
          ))}
        </section>
      )}
    </div>
  )
}
