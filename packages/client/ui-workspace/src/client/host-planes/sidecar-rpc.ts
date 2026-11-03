/** Unary RPC against the inactive Host via the Desktop sidecar path prefix. */

import type { SidecarModelGroup, SidecarSessionRow, SidecarWorkspaceRow } from './types.ts'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'

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
    readonly projections?: { readonly values?: { readonly title?: unknown } }
  }[]
}

interface ModelCatalogWire {
  readonly groups?: readonly {
    readonly id?: string
    readonly name?: string
    readonly models?: readonly { readonly id?: string; readonly name?: string }[]
  }[]
}

interface ClientRequest {
  readonly type: 'client-request'
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
}

async function sidecarCall(
  prefix: string,
  method: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const base = prefix.replace(/\/$/, '')
  const rpcId = globalThis.crypto?.randomUUID?.() ?? `sidecar-${Date.now()}`
  const message: ClientRequest = { type: 'client-request', rpcId, method, payload: { args: payload } }
  const response = await globalThis.fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) {
    throw new Error(`sidecar ${method}: HTTP ${response.status}`)
  }
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null || !('result' in body)) {
    throw new Error(`sidecar ${method}: invalid envelope`)
  }
  const result = (body as { result: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } }).result
  if (result.ok !== true) {
    throw new Error(`${result.error?.code ?? 'error'}: ${result.error?.message ?? method}`)
  }
  return result.value
}

export async function fetchSidecarPlane(
  prefix: string,
  signal?: AbortSignal,
): Promise<{ workspaces: SidecarWorkspaceRow[]; sessions: SidecarSessionRow[]; modelGroups: SidecarModelGroup[] }> {
  const baseline = await sidecarCall(prefix, 'workspace/listSnapshot', {}, signal) as WorkspaceBaselineWire
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
  let sessionTitles = new Map<string, string>()
  let listedSessions: readonly NonNullable<SessionListWire['items']>[number][] = []
  try {
    const listed = await sidecarCall(prefix, 'session/list', { _request: {} }, signal) as SessionListWire
    listedSessions = listed.items ?? []
    sessionTitles = new Map()
    for (const item of listedSessions) {
      if (typeof item.sessionId !== 'string') continue
      const title = item.projections?.values?.title
      const cwdTitle = typeof item.cwd === 'string' ? workspaceTitleOf(item.cwd) : ''
      sessionTitles.set(item.sessionId, typeof title === 'string' && title !== ''
        ? title
        : cwdTitle !== ''
          ? cwdTitle
          : item.sessionId)
    }
  } catch {
    sessionTitles = new Map()
  }
  const sessions: SidecarSessionRow[] = []
  const added = new Set<string>()
  for (const [sessionId, workspace] of sessionWorkspaces) {
    added.add(sessionId)
    sessions.push({
      sessionId,
      title: sessionTitles.get(sessionId) ?? sessionId,
      workspaceId: workspace.workspaceId,
    })
  }
  for (const item of listedSessions) {
    if (typeof item.sessionId !== 'string' || item.origin === 'subagent'
      || deleted.has(item.sessionId) || added.has(item.sessionId)) continue
    added.add(item.sessionId)
    sessions.push({ sessionId: item.sessionId, title: sessionTitles.get(item.sessionId) ?? item.sessionId })
  }
  let modelGroups: SidecarModelGroup[] = []
  try {
    const catalog = await sidecarCall(prefix, 'session/modelCatalog', {}, signal) as ModelCatalogWire
    modelGroups = (catalog.groups ?? []).flatMap((group) => {
      if (typeof group.id !== 'string') return []
      const models = (group.models ?? []).flatMap((model) => {
        if (typeof model.id !== 'string') return []
        return [{ id: model.id, name: model.name ?? model.id }]
      })
      return [{ id: group.id, name: group.name ?? group.id, models }]
    })
  } catch {
    modelGroups = []
  }
  return { workspaces, sessions, modelGroups }
}
