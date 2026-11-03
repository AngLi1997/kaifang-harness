/** Unary RPC against the inactive Host via the Desktop sidecar path prefix. */

import type { SidecarModelGroup, SidecarSessionRow } from './types.ts'

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
    readonly displayTitle?: string
    readonly title?: string
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
  const message: ClientRequest = { type: 'client-request', rpcId, method, payload }
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
): Promise<{ sessions: SidecarSessionRow[]; modelGroups: SidecarModelGroup[] }> {
  const baseline = await sidecarCall(prefix, 'workspace/listSnapshot', {}, signal) as WorkspaceBaselineWire
  const deleted = new Set(baseline.deletedSessionIds ?? [])
  let sessionTitles = new Map<string, string>()
  try {
    const listed = await sidecarCall(prefix, 'session/list', {}, signal) as SessionListWire
    sessionTitles = new Map()
    for (const item of listed.items ?? []) {
      if (typeof item.sessionId !== 'string') continue
      sessionTitles.set(item.sessionId, item.displayTitle ?? item.title ?? item.sessionId)
    }
  } catch {
    sessionTitles = new Map()
  }
  const sessions: SidecarSessionRow[] = []
  for (const workspace of baseline.items ?? []) {
    if (typeof workspace.workspaceId !== 'string') continue
    const workspaceTitle = workspace.title ?? workspace.workspaceId
    for (const sessionId of workspace.sessionIds ?? []) {
      if (deleted.has(sessionId)) continue
      sessions.push({
        sessionId,
        title: sessionTitles.get(sessionId) ?? sessionId,
        workspaceId: workspace.workspaceId,
        workspaceTitle,
      })
    }
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
  return { sessions, modelGroups }
}
