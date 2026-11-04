/** Cloud workspaces fed by that Host's follow stream. */

import { useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconFolderCloseRegular, IconFolderOpenRegular, IconTriangleRightFillRegular, relativeTime,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import rowCss from '../rows/Rows.module.css'
import listCss from '../rows/WorkspaceBrowser.module.css'
import { groupSidecarSessions } from './sidecar-rpc.ts'
import { dualPlaneStore } from './store.ts'
import type { HostPlaneId } from './types.ts'

type Translate = WorkspaceBrowserProps['t']

function sessionTime(updatedAt: number | undefined, now: number, t: Translate): string | undefined {
  if (updatedAt === undefined) return undefined
  const { unit, n } = relativeTime(updatedAt, now)
  return unit === 'now' ? t('time.now') : t(`time.${unit}`, { n })
}

/** Inactive-plane folder list inputs. */
interface SidecarPlaneListProps {
  /** Host the snapshot belongs to. */
  plane: HostPlaneId
  /** Copy when that Host has no workspaces. */
  emptyLabel: string
  /** Copy for a session with no stored title. */
  untitledLabel: string
  /** Localized name of the default workspace. */
  defaultWorkspaceName: string
  /** Workspace dictionary, including relative-time labels. */
  t: Translate
  /** Opens the session on that Host. */
  onOpenSession: (sessionId: SessionId) => void
  /** Case-insensitive title filter. Empty shows the full snapshot. */
  query?: string
  /** Copy when a non-empty query matches nothing. */
  noMatchesLabel?: string
}

/**
 * Folder rows for the cloud Host.
 * @param props - inactive-plane list inputs.
 * @returns the folder list, or the empty copy.
 */
export function SidecarPlaneList(props: SidecarPlaneListProps): ReactNode {
  const {
    plane,
    emptyLabel,
    untitledLabel,
    defaultWorkspaceName,
    t,
    onOpenSession,
    query = '',
    noMatchesLabel = emptyLabel,
  } = props
  const snapshot = useSyncExternalStore(
    fn => dualPlaneStore.subscribe(fn),
    () => dualPlaneStore.getSnapshot(),
  )
  const groups = groupSidecarSessions(
    snapshot.sidecarWorkspaces,
    snapshot.sidecarSessions,
    defaultWorkspaceName,
  )
  const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>({})
  const needle = query.trim().toLocaleLowerCase()
  const visibleGroups = needle === '' ? groups : groups.flatMap((group) => {
    const titleHit = group.title.toLocaleLowerCase().includes(needle)
    const sessions = titleHit
      ? group.sessions
      : group.sessions.filter((row) => {
        const title = row.title !== '' ? row.title : untitledLabel
        return title.toLocaleLowerCase().includes(needle)
      })
    if (!titleHit && sessions.length === 0) return []
    return [{ ...group, sessions }]
  })
  if (visibleGroups.length === 0) {
    return <div className={listCss.empty}>{needle === '' ? emptyLabel : noMatchesLabel}</div>
  }
  const now = Date.now()
  return (
    <div data-host-plane={plane}>
      {visibleGroups.map((group) => {
        const open = collapsed[group.key] === false
          || (collapsed[group.key] !== true && group.sessions.length > 0)
        const toggle = (): void => {
          setCollapsed(prev => ({ ...prev, [group.key]: open }))
        }
        return (
          <div className={listCss.groupSection} key={group.key}>
            <div
              className={rowCss.projectRow}
              role="treeitem"
              aria-expanded={open}
              onClick={toggle}
            >
              <span className={clsx(rowCss.slot, rowCss.folder, open && rowCss.folderActive)}>
                {open ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
              </span>
              <span className={clsx(rowCss.slot, rowCss.chevron)}>
                <IconTriangleRightFillRegular className={clsx(rowCss.arrow, open && rowCss.arrowOpen)} />
              </span>
              <span className={rowCss.projectText}>
                <span className={rowCss.title}>{group.title}</span>
              </span>
            </div>
            {open && group.sessions.map((row) => {
              const title = row.title !== '' ? row.title : untitledLabel
              const time = sessionTime(row.updatedAt, now, t)
              const openRow = (): void => { onOpenSession(row.sessionId as SessionId) }
              const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
                if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
                event.preventDefault()
                openRow()
              }
              return (
                <div
                  key={row.sessionId}
                  className={rowCss.sessionRow}
                  role="treeitem"
                  tabIndex={0}
                  onClick={openRow}
                  onKeyDown={onKeyDown}
                >
                  <span className={rowCss.slot} />
                  <span className={rowCss.title}>{title}</span>
                  {time !== undefined && (
                    <span className={rowCss.rowResting}>
                      <span className={rowCss.time}>{time}</span>
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
