/** Observable Desktop dual-plane state + sidecar poll for the inactive Host. */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { fetchSidecarPlane } from './sidecar-rpc.ts'
import { applyHostPlaneTransport, desktopHostPlaneApi, readHostPlaneTransport } from './transport.ts'
import type { DualPlaneSnapshot, HostPlaneId, HostPlaneTransport } from './types.ts'

const POLL_MS = 8_000
const FAIL_THRESHOLD = 3

const initial = (): DualPlaneSnapshot => {
  const boot = readHostPlaneTransport()
  return {
    cloudOnline: boot?.cloudOnline === true,
    cloudShellEmpty: false,
    activePlane: boot?.activePlane === 'cloud' ? 'cloud' : 'local',
    sidecarApiPrefix: boot?.sidecarApiPrefix,
    sidecarWorkspaces: [],
    sidecarSessions: [],
    sidecarModelGroups: [],
    disconnectToastSeq: 0,
  }
}

export const dualPlaneStore = createSnapshotStore({ ...initial() })

;(globalThis as { __DSH_DUAL_PLANE__?: typeof dualPlaneStore }).__DSH_DUAL_PLANE__ = dualPlaneStore

let pollTimer: ReturnType<typeof setInterval> | undefined
let pollController: AbortController | undefined
let failCount = 0
let started = false
let reconnect: (() => void) | undefined

export function setDualPlaneReconnect(handler: (() => void) | undefined): void {
  reconnect = handler
}

function updatePlaneView(view: HostPlaneTransport): void {
  const planeChanged = dualPlaneStore.getSnapshot().activePlane !== view.activePlane
  applyHostPlaneTransport(view)
  dualPlaneStore.update((draft) => {
    draft.cloudOnline = view.cloudOnline
    draft.activePlane = view.activePlane
    draft.sidecarApiPrefix = view.sidecarApiPrefix
    if (!view.cloudOnline) {
      draft.cloudShellEmpty = false
      draft.sidecarWorkspaces = []
      draft.sidecarSessions = []
      draft.sidecarModelGroups = []
    } else if (planeChanged) {
      draft.sidecarWorkspaces = []
      draft.sidecarSessions = []
      draft.sidecarModelGroups = []
    }
  })
  if (planeChanged) {
    failCount = 0
    pollController?.abort()
    pollController = undefined
    void pollOnce()
  }
}

async function applyPlaneView(plane: HostPlaneId): Promise<void> {
  const api = desktopHostPlaneApi()
  if (api === undefined) return
  const view = await api.setActive(plane)
  updatePlaneView(view)
  reconnect?.()
}

export async function setActivePlane(plane: HostPlaneId): Promise<void> {
  const snap = dualPlaneStore.getSnapshot()
  if (!snap.cloudOnline || snap.activePlane === plane) return
  await applyPlaneView(plane)
}

async function pollOnce(): Promise<void> {
  const snap = dualPlaneStore.getSnapshot()
  if (!snap.cloudOnline || snap.sidecarApiPrefix === undefined || pollController !== undefined) return
  const targetPlane = snap.activePlane
  const targetPrefix = snap.sidecarApiPrefix
  const controller = new AbortController()
  pollController = controller
  try {
    const { workspaces, sessions, modelGroups } = await fetchSidecarPlane(targetPrefix, controller.signal)
    const current = dualPlaneStore.getSnapshot()
    if (controller.signal.aborted || !current.cloudOnline || current.activePlane !== targetPlane
      || current.sidecarApiPrefix !== targetPrefix) return
    failCount = 0
    dualPlaneStore.update((draft) => {
      draft.sidecarWorkspaces = workspaces
      draft.sidecarSessions = sessions
      draft.sidecarModelGroups = modelGroups
      draft.cloudShellEmpty = false
    })
  } catch {
    if (controller.signal.aborted) return
    const current = dualPlaneStore.getSnapshot()
    if (!current.cloudOnline || current.activePlane !== targetPlane || current.sidecarApiPrefix !== targetPrefix) return
    failCount += 1
    if (failCount < FAIL_THRESHOLD) return
    failCount = 0
    const api = desktopHostPlaneApi()
    if (api !== undefined) {
      const view = await api.reportCloudLost()
      applyHostPlaneTransport(view)
    }
    dualPlaneStore.update((draft) => {
      draft.cloudOnline = false
      draft.cloudShellEmpty = false
      draft.activePlane = 'local'
      draft.sidecarApiPrefix = undefined
      draft.sidecarWorkspaces = []
      draft.sidecarSessions = []
      draft.sidecarModelGroups = []
      draft.disconnectToastSeq += 1
    })
    reconnect?.()
  } finally {
    if (pollController === controller) pollController = undefined
  }
}

/** Start dual-plane listeners once per Desktop renderer session. */
export function startDualPlaneRuntime(): () => void {
  if (started) return () => {}
  started = true
  const boot = readHostPlaneTransport()
  if (boot !== undefined) {
    dualPlaneStore.set({
      cloudOnline: boot.cloudOnline,
      cloudShellEmpty: false,
      activePlane: boot.activePlane,
      sidecarApiPrefix: boot.sidecarApiPrefix,
      sidecarWorkspaces: [],
      sidecarSessions: [],
      sidecarModelGroups: [],
      disconnectToastSeq: 0,
    })
  }
  const api = desktopHostPlaneApi()
  const stopPlane = api?.subscribe((view) => {
    updatePlaneView(view)
    reconnect?.()
  })
  const stopDisconnect = api?.subscribeDisconnect(() => {
    pollController?.abort()
    pollController = undefined
    dualPlaneStore.update((draft) => {
      draft.cloudOnline = false
      draft.cloudShellEmpty = false
      draft.activePlane = 'local'
      draft.sidecarApiPrefix = undefined
      draft.sidecarWorkspaces = []
      draft.sidecarSessions = []
      draft.sidecarModelGroups = []
      draft.disconnectToastSeq += 1
    })
  })
  void pollOnce()
  pollTimer = setInterval(() => { void pollOnce() }, POLL_MS)
  return () => {
    started = false
    stopPlane?.()
    stopDisconnect?.()
    if (pollTimer !== undefined) clearInterval(pollTimer)
    pollTimer = undefined
    pollController?.abort()
    pollController = undefined
  }
}
