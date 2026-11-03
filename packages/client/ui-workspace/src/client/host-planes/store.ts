/** Observable Desktop dual-plane state + sidecar poll for the inactive Host. */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { fetchSidecarPlane } from './sidecar-rpc.ts'
import { applyHostPlaneTransport, desktopHostPlaneApi, readHostPlaneTransport } from './transport.ts'
import type { DualPlaneSnapshot, HostPlaneId } from './types.ts'

const POLL_MS = 8_000
const FAIL_THRESHOLD = 3

const initial = (): DualPlaneSnapshot => {
  const boot = readHostPlaneTransport()
  return {
    cloudOnline: boot?.cloudOnline === true,
    cloudShellEmpty: false,
    activePlane: boot?.activePlane === 'cloud' ? 'cloud' : 'local',
    sidecarApiPrefix: boot?.sidecarApiPrefix,
    sidecarSessions: [],
    sidecarModelGroups: [],
    disconnectToastSeq: 0,
  }
}

export const dualPlaneStore = createSnapshotStore<DualPlaneSnapshot>(initial())

;(globalThis as { __DSH_DUAL_PLANE__?: typeof dualPlaneStore }).__DSH_DUAL_PLANE__ = dualPlaneStore

let pollTimer: ReturnType<typeof setInterval> | undefined
let failCount = 0
let started = false
let reconnect: (() => void) | undefined

export function setDualPlaneReconnect(handler: (() => void) | undefined): void {
  reconnect = handler
}

async function applyPlaneView(plane: HostPlaneId): Promise<void> {
  const api = desktopHostPlaneApi()
  if (api === undefined) return
  const view = await api.setActive(plane)
  applyHostPlaneTransport(view)
  dualPlaneStore.update((draft) => {
    draft.cloudOnline = view.cloudOnline
    draft.activePlane = view.activePlane
    draft.sidecarApiPrefix = view.sidecarApiPrefix
    if (!view.cloudOnline) {
      draft.cloudShellEmpty = false
      draft.sidecarSessions = []
      draft.sidecarModelGroups = []
    }
  })
  reconnect?.()
}

export async function setActivePlane(plane: HostPlaneId): Promise<void> {
  const snap = dualPlaneStore.getSnapshot()
  if (!snap.cloudOnline || snap.activePlane === plane) return
  await applyPlaneView(plane)
}

async function pollOnce(): Promise<void> {
  const snap = dualPlaneStore.getSnapshot()
  if (!snap.cloudOnline || snap.sidecarApiPrefix === undefined) return
  try {
    const { sessions, modelGroups } = await fetchSidecarPlane(snap.sidecarApiPrefix)
    failCount = 0
    dualPlaneStore.update((draft) => {
      draft.sidecarSessions = sessions
      draft.sidecarModelGroups = modelGroups
      draft.cloudShellEmpty = false
    })
  } catch {
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
      draft.sidecarSessions = []
      draft.sidecarModelGroups = []
      draft.disconnectToastSeq += 1
    })
    reconnect?.()
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
      sidecarSessions: [],
      sidecarModelGroups: [],
      disconnectToastSeq: 0,
    })
  }
  const api = desktopHostPlaneApi()
  const stopPlane = api?.subscribe((view) => {
    applyHostPlaneTransport(view)
    dualPlaneStore.update((draft) => {
      draft.cloudOnline = view.cloudOnline
      draft.activePlane = view.activePlane
      draft.sidecarApiPrefix = view.sidecarApiPrefix
      if (!view.cloudOnline) {
        draft.cloudShellEmpty = false
        draft.sidecarSessions = []
        draft.sidecarModelGroups = []
      }
    })
    reconnect?.()
  })
  const stopDisconnect = api?.subscribeDisconnect(() => {
    dualPlaneStore.update((draft) => {
      draft.cloudOnline = false
      draft.cloudShellEmpty = false
      draft.activePlane = 'local'
      draft.sidecarApiPrefix = undefined
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
  }
}
