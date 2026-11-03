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
  onOpenSession,
}: {
  plane: HostPlaneId
  emptyLabel: string
  onOpenSession: (sessionId: SessionId) => void
}): ReactNode {
  const sessions = useSyncExternalStore(
    fn => dualPlaneStore.subscribe(fn),
    () => dualPlaneStore.getSnapshot().sidecarSessions,
  )
  if (sessions.length === 0) {
    return <div className={css.sidecarEmpty}>{emptyLabel}</div>
  }
  return (
    <div className={css.sidecarList} data-host-plane={plane}>
      {sessions.map(row => (
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
          <span className={css.sidecarMeta}>{row.workspaceTitle}</span>
        </button>
      ))}
    </div>
  )
}
