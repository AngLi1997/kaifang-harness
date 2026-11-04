/** Group cloud-catalog rows for the sidebar. */

import { DEFAULT_WORKSPACE_DIRECTORY, workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { SidecarGroup, SidecarSessionRow, SidecarWorkspaceRow } from './types.ts'

interface WorkspaceBaselineWire {
  readonly items?: readonly {
    readonly workspaceId?: string
    readonly title?: string
    readonly sessionIds?: readonly string[]
  }[]
  readonly deletedSessionIds?: readonly string[]
}

interface SessionListWire {
  readonly items?: readonly {
    readonly sessionId?: string
    readonly cwd?: string
    readonly origin?: string
    readonly updatedAt?: unknown
    readonly projections?: {
      readonly values?: {
        readonly title?: unknown
        readonly sessionListMetadata?: unknown
      }
    }
  }[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function storedTitle(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function storedUpdatedAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isBlankSession(item: NonNullable<SessionListWire['items']>[number]): boolean {
  const metadata = item.projections?.values?.sessionListMetadata
  return isRecord(metadata) && metadata.blank === true
}

/**
 * Project one inactive Host's workspace snapshot and session list.
 * Titles are the stored projection only: a missing title stays empty so the
 * sidebar can show the unnamed label, and a directory name is not a title.
 * Blank sessions stay hidden, matching the active workspace tree.
 * @param baseline - `workspace/listSnapshot` value.
 * @param listed - `session/list` value, or undefined when that call failed.
 * @returns workspace rows and the sessions the sidebar may show.
 */
export function readSidecarSnapshot(
  baseline: WorkspaceBaselineWire,
  listed: SessionListWire | undefined,
): { workspaces: SidecarWorkspaceRow[]; sessions: SidecarSessionRow[] } {
  const deleted = new Set(baseline.deletedSessionIds ?? [])
  const workspaces: SidecarWorkspaceRow[] = []
  const sessionWorkspaces = new Map<string, SidecarWorkspaceRow>()
  for (const workspace of baseline.items ?? []) {
    if (typeof workspace.workspaceId !== 'string') continue
    const row = { workspaceId: workspace.workspaceId, title: workspace.title ?? workspace.workspaceId }
    workspaces.push(row)
    for (const sessionId of workspace.sessionIds ?? []) {
      if (!deleted.has(sessionId)) sessionWorkspaces.set(sessionId, row)
    }
  }
  const listedSessions = listed?.items ?? []
  const sessionTitles = new Map<string, string>()
  const sessionTimes = new Map<string, number>()
  const blank = new Set<string>()
  for (const item of listedSessions) {
    if (typeof item.sessionId !== 'string') continue
    if (isBlankSession(item)) {
      blank.add(item.sessionId)
      continue
    }
    sessionTitles.set(item.sessionId, storedTitle(item.projections?.values?.title))
    const updatedAt = storedUpdatedAt(item.updatedAt)
    if (updatedAt !== undefined) sessionTimes.set(item.sessionId, updatedAt)
  }
  const sessions: SidecarSessionRow[] = []
  const added = new Set<string>()
  const pushSession = (sessionId: string, workspaceId?: string): void => {
    const updatedAt = sessionTimes.get(sessionId)
    sessions.push({
      sessionId,
      title: sessionTitles.get(sessionId) ?? '',
      ...workspaceId === undefined ? {} : { workspaceId },
      ...updatedAt === undefined ? {} : { updatedAt },
    })
  }
  for (const [sessionId, workspace] of sessionWorkspaces) {
    if (blank.has(sessionId)) continue
    added.add(sessionId)
    pushSession(sessionId, workspace.workspaceId)
  }
  for (const item of listedSessions) {
    if (typeof item.sessionId !== 'string' || item.origin === 'subagent'
      || deleted.has(item.sessionId) || blank.has(item.sessionId) || added.has(item.sessionId)) continue
    added.add(item.sessionId)
    pushSession(item.sessionId)
  }
  return { workspaces, sessions }
}

/**
 * Group sidecar rows the way the active tree groups them: the automatic
 * default workspace and sessions with no workspace share one localized bucket.
 * @param workspaces - inactive Host workspaces, in snapshot order.
 * @param sessions - visible sessions from {@link readSidecarSnapshot}.
 * @param defaultWorkspaceName - localized name of the default workspace.
 * @returns one group per shown workspace, including empty non-default workspaces.
 */
export function groupSidecarSessions(
  workspaces: readonly SidecarWorkspaceRow[],
  sessions: readonly SidecarSessionRow[],
  defaultWorkspaceName: string,
): SidecarGroup[] {
  const defaultIds = new Set(workspaces
    .filter(workspace => workspace.title === DEFAULT_WORKSPACE_DIRECTORY)
    .map(workspace => workspace.workspaceId))
  const byWorkspace = new Map<string, SidecarSessionRow[]>()
  const ungrouped: SidecarSessionRow[] = []
  for (const session of sessions) {
    if (session.workspaceId === undefined || defaultIds.has(session.workspaceId)) {
      ungrouped.push(session)
      continue
    }
    const rows = byWorkspace.get(session.workspaceId) ?? []
    rows.push(session)
    byWorkspace.set(session.workspaceId, rows)
  }
  const groups: SidecarGroup[] = []
  let placedDefault = false
  for (const workspace of workspaces) {
    if (workspace.title === DEFAULT_WORKSPACE_DIRECTORY) {
      if (placedDefault) continue
      placedDefault = true
      groups.push({ key: 'default', title: defaultWorkspaceName, sessions: ungrouped })
      continue
    }
    groups.push({
      key: workspace.workspaceId,
      title: workspaceDisplayTitle(workspace.title, defaultWorkspaceName),
      sessions: byWorkspace.get(workspace.workspaceId) ?? [],
    })
  }
  if (!placedDefault && ungrouped.length > 0) {
    groups.push({ key: 'default', title: defaultWorkspaceName, sessions: ungrouped })
  }
  return groups
}
