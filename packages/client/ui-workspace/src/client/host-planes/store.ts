/** Observable Desktop dual-plane state. The shell stays on the local Host; the cloud section has its own generation. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { applyHostPlaneTransport, desktopHostPlaneApi, readHostPlaneTransport } from './transport.ts'
import type { DualPlaneSnapshot, HostPlaneId, HostPlaneTransport } from './types.ts'

/** Cloud generation the sidebar drives. The workspace controller owns the implementation. */
interface CloudPlaneRuntime {
  readonly sessions: {
    retain(sessionId: SessionId, options: { readonly source: 'mainView' }): SessionReference
    create(input: { readonly workspaceId: WorkspaceId }): Promise<SessionId>
    binding(sessionId: SessionId): SessionBinding | undefined
  }
  createWorkspace(input: { readonly path: string }): Promise<WorkspaceView>
  selectModel(request: {
    readonly sessionId: SessionId
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<{ ok: true; value: undefined } | { ok: false; error: { code: string; message: string } }>
  stop(): void
}

/** Service the workspace controller publishes as `cloudHost`. */
interface CloudPlaneStarter {
  start(options: {
    readonly origin: string
    readonly apiPrefix: string
    readonly onCatalog: (catalog: {
      readonly workspaces: DualPlaneSnapshot['sidecarWorkspaces']
      readonly sessions: DualPlaneSnapshot['sidecarSessions']
      readonly modelGroups: DualPlaneSnapshot['sidecarModelGroups']
    }) => void
    readonly onLost: () => void
    readonly onFocus: (binding: SessionBinding | undefined) => void
  }): CloudPlaneRuntime
}

const initial = (): DualPlaneSnapshot => {
  const boot = readHostPlaneTransport()
  return {
    cloudOnline: boot?.cloudOnline === true,
    cloudShellEmpty: false,
    activePlane: boot?.activePlane === 'cloud' ? 'cloud' : 'local',
    sessionPlane: 'local',
    sidecarApiPrefix: boot?.sidecarApiPrefix,
    cloudStreamBaseUrl: boot?.cloudStreamBaseUrl,
    cloudAccountKey: boot?.cloudAccountKey,
    sidecarWorkspaces: [],
    sidecarSessions: [],
    sidecarModelGroups: [],
    disconnectToastSeq: 0,
  }
}

export const dualPlaneStore = createSnapshotStore({ ...initial() })

;(globalThis as { __DSH_DUAL_PLANE__?: typeof dualPlaneStore }).__DSH_DUAL_PLANE__ = dualPlaneStore
;(globalThis as { __DSH_SELECT_CLOUD_MODEL__?: typeof selectFocusedCloudModel }).__DSH_SELECT_CLOUD_MODEL__ = selectFocusedCloudModel

let started = false
let reconnect: (() => void) | undefined
let runtimeCtx: Context | undefined
let runtime: CloudPlaneRuntime | undefined
let membership: { readonly accountKey: string; readonly origin: string } | undefined
let createPlane: HostPlaneId = 'local'
let cloudMain: SessionReference | undefined
let focusHandler: ((binding: SessionBinding | undefined) => void) | undefined

export function setDualPlaneReconnect(handler: (() => void) | undefined): void {
  reconnect = handler
}

/**
 * Receive the cloud Session binding the conversation should show.
 * @param handler - adopts the binding, or clears it when passed undefined.
 */
export function setCloudSessionFocus(handler: ((binding: SessionBinding | undefined) => void) | undefined): void {
  focusHandler = handler
}

/** @returns the Host that should receive the next directory add. */
export function workspaceCreatePlane(): HostPlaneId {
  return createPlane
}

/**
 * Choose which Host the next directory add uses.
 * @param plane - local shell or cloud generation.
 */
export function setWorkspaceCreatePlane(plane: HostPlaneId): void {
  createPlane = plane
}

/**
 * Open a cloud session in the conversation without replacing the shell connection.
 * @param sessionId - session on the cloud Host.
 */
export function focusCloudSession(sessionId: SessionId): void {
  const sessions = runtime?.sessions
  if (sessions === undefined) return
  createPlane = 'cloud'
  cloudMain?.release()
  cloudMain = sessions.retain(sessionId, { source: 'mainView' })
  dualPlaneStore.update((draft) => { draft.sessionPlane = 'cloud' })
  focusHandler?.(cloudMain.binding)
}

/**
 * Live cloud binding for one session, when that catalog still retains it.
 * @param sessionId - session on the cloud Host.
 * @returns the cloud binding, or undefined when that generation is gone.
 */
export function cloudSessionBinding(sessionId: SessionId): SessionBinding | undefined {
  return runtime?.sessions.binding(sessionId)
}

/** Return the conversation to the shell catalog. */
export function releaseCloudFocus(): void {
  createPlane = 'local'
  cloudMain?.release()
  cloudMain = undefined
  dualPlaneStore.update((draft) => { draft.sessionPlane = 'local' })
  focusHandler?.(undefined)
}

/**
 * Record a model on the focused cloud session.
 * @param selection - provider and model from the cloud catalog.
 * @returns the cloud Host outcome.
 */
export async function selectFocusedCloudModel(selection: {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}): Promise<{ ok: true; value: undefined } | { ok: false; error: { code: string; message: string } }> {
  const sessionId = cloudMain?.binding.sessionId
  if (sessionId === undefined || runtime === undefined) {
    return { ok: false, error: { code: 'cloud/offline', message: 'cloud workspace is offline' } }
  }
  return runtime.selectModel({
    sessionId,
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  })
}

/**
 * Create a session in a cloud workspace and show it.
 * @param workspaceId - workspace on the cloud Host.
 * @returns when the session is retained for the conversation.
 */
export async function openCloudWorkspaceSession(workspaceId: WorkspaceId): Promise<void> {
  const sessions = runtime?.sessions
  if (sessions === undefined) throw new Error('cloud workspace is offline')
  const sessionId = await sessions.create({ workspaceId })
  focusCloudSession(sessionId)
}

/**
 * Create a workspace on the cloud Host when that section requested the add.
 * @param input - directory to adopt.
 * @param createLocal - shell workspace create.
 * @returns the created workspace.
 */
export function createWorkspaceForPlane(
  input: { path: string },
  createLocal: (input: { path: string }) => Promise<WorkspaceView>,
): Promise<WorkspaceView> {
  if (createPlane !== 'cloud') return createLocal(input)
  if (runtime === undefined) return Promise.reject(new Error('cloud workspace is offline'))
  return runtime.createWorkspace(input)
}

function clearCloudSnapshots(): void {
  dualPlaneStore.update((draft) => {
    draft.sidecarWorkspaces = []
    draft.sidecarSessions = []
    draft.sidecarModelGroups = []
    draft.sessionPlane = 'local'
  })
}

function syncCloud(view: HostPlaneTransport): void {
  const nextKey = view.cloudOnline ? view.cloudAccountKey : undefined
  const nextOrigin = view.cloudOnline ? view.cloudStreamBaseUrl : undefined
  const same = membership?.accountKey === nextKey && membership?.origin === nextOrigin
  if (same) return
  membership = nextKey !== undefined && nextOrigin !== undefined
    ? { accountKey: nextKey, origin: nextOrigin }
    : undefined
  const previous = runtime
  runtime = undefined
  previous?.stop()
  if (previous !== undefined) {
    cloudMain?.release()
    cloudMain = undefined
    focusHandler?.(undefined)
  }
  clearCloudSnapshots()
  if (membership === undefined || runtimeCtx === undefined || view.sidecarApiPrefix === undefined) return
  const starter = runtimeCtx.get('cloudHost', false) as CloudPlaneStarter | undefined
  if (starter === undefined) return
  const origin = membership.origin
  const prefix = view.sidecarApiPrefix
  const handle = starter.start({
    origin,
    apiPrefix: prefix,
    onCatalog: (catalog) => {
      if (runtime !== handle) return
      dualPlaneStore.update((draft) => {
        draft.sidecarWorkspaces = catalog.workspaces
        draft.sidecarSessions = catalog.sessions
        draft.sidecarModelGroups = catalog.modelGroups
      })
    },
    onLost: () => {
      if (runtime !== handle) return
      const api = desktopHostPlaneApi()
      if (api === undefined) return
      void api.reportCloudLost().then((next) => { updatePlaneView(next) })
    },
    onFocus: (binding) => {
      if (runtime !== handle) return
      focusHandler?.(binding)
    },
  })
  runtime = handle
}

function updatePlaneView(view: HostPlaneTransport): void {
  const previousUrl = (globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }).__DSH_TRANSPORT__?.streamBaseUrl
  applyHostPlaneTransport(view)
  dualPlaneStore.update((draft) => {
    draft.cloudOnline = view.cloudOnline
    draft.activePlane = view.activePlane
    draft.sidecarApiPrefix = view.sidecarApiPrefix
    draft.cloudStreamBaseUrl = view.cloudOnline ? view.cloudStreamBaseUrl : undefined
    draft.cloudAccountKey = view.cloudOnline ? view.cloudAccountKey : undefined
    if (!view.cloudOnline) draft.cloudShellEmpty = false
  })
  syncCloud(view)
  if (previousUrl !== undefined && previousUrl !== view.streamBaseUrl) reconnect?.()
}

export async function setActivePlane(plane: HostPlaneId): Promise<void> {
  const snap = dualPlaneStore.getSnapshot()
  if (!snap.cloudOnline || snap.activePlane === plane) return
  const api = desktopHostPlaneApi()
  if (api === undefined) return
  updatePlaneView(await api.setActive(plane))
}

/**
 * Start dual-plane listeners once per Desktop renderer session.
 * @param ctx - client root used for the cloud catalog. Omitted in tests that only observe membership.
 * @returns disposer for the listeners and the cloud generation.
 */
export function startDualPlaneRuntime(ctx?: Context): () => void {
  if (started) return () => {}
  started = true
  runtimeCtx = ctx
  const boot = readHostPlaneTransport()
  if (boot !== undefined) updatePlaneView(boot)
  const api = desktopHostPlaneApi()
  // Boot can finish before sign-in. A later snapshot is missed when nothing is listening yet.
  let sawPlaneEvent = false
  const stopPlane = api?.subscribe((view) => {
    sawPlaneEvent = true
    updatePlaneView(view)
  })
  if (api !== undefined) {
    void api.current().then((view) => {
      if (sawPlaneEvent) return
      updatePlaneView(view)
    }).catch((error: unknown) => {
      console.warn('dual-plane: live host plane was unavailable', error)
    })
  }
  const stopDisconnect = api?.subscribeDisconnect(() => {
    dualPlaneStore.update((draft) => {
      draft.cloudOnline = false
      draft.cloudShellEmpty = false
      draft.activePlane = 'local'
      draft.sidecarApiPrefix = undefined
      draft.cloudStreamBaseUrl = undefined
      draft.cloudAccountKey = undefined
      draft.disconnectToastSeq += 1
    })
    syncCloud({
      cloudOnline: false,
      activePlane: 'local',
      streamBaseUrl: readHostPlaneTransport()?.streamBaseUrl ?? '',
      ownsHost: true,
    })
  })
  return () => {
    started = false
    runtimeCtx = undefined
    stopPlane?.()
    stopDisconnect?.()
    runtime?.stop()
    runtime = undefined
    membership = undefined
    cloudMain?.release()
    cloudMain = undefined
  }
}
